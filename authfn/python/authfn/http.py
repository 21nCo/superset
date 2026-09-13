"""Shared HTTP route construction and envelope helpers for authfn Python."""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, cast
from urllib.parse import parse_qs, urlparse

from superfunctions.http import HttpMethod, Response, Route, RouteContext, SetCookie

from .config import get_plugin_config, resolve_runtime
from .errors import to_authfn_error
from .observability import (
    emit_auth_event,
    event_request_id,
)
from .observability import (
    resolve_request_id as resolve_observability_request_id,
)
from .plugins.api_keys import ApiKeyPluginConfig, ApiKeyService
from .plugins.email_otp import EmailOtpPluginConfig, EmailOtpService
from .plugins.gateway_routing import create_cell_routing_middleware
from .plugins.multi_region import MultiRegionPluginConfig, MultiRegionService
from .plugins.two_factor import TwoFactorPluginConfig, TwoFactorService
from .types import (
    AuthFnConfig,
    AuthFnError,
    AuthFnHookContext,
    AuthFnSession,
    ConflictError,
    CsrfInvalidError,
    InternalError,
    InvalidCredentialsError,
    NotFoundError,
    PluginAbortedError,
    SessionExpiredError,
    SessionRevokedError,
    UnauthorizedError,
    ValidationError,
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _coerce_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)

DEFAULT_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7
DEFAULT_CSRF_MAX_AGE_SECONDS = DEFAULT_SESSION_MAX_AGE_SECONDS
PASSWORD_HASH_ALGO = "scrypt"
PASSWORD_HASH_N = 16384
PASSWORD_HASH_R = 8
PASSWORD_HASH_P = 1
PASSWORD_HASH_KEY_LENGTH = 64
MIN_PASSWORD_LENGTH = 12


@dataclass
class CookiePolicy:
    prefix: str
    path: str
    domain: Optional[str]
    secure: bool
    same_site: str
    session_max_age_seconds: int
    csrf_max_age_seconds: int
    session_cookie_name: str
    csrf_cookie_name: str


@dataclass
class SessionState:
    runtime: Any
    cookie_policy: CookiePolicy
    session_token: Optional[str] = None
    csrf_token: Optional[str] = None
    session: Optional[AuthFnSession] = None
    session_record: Optional[Dict[str, Any]] = None
    user: Optional[Dict[str, Any]] = None
    failure_reason: Optional[str] = None


def resolve_request_id(request: Any) -> str:
    return resolve_observability_request_id(request)


def success_envelope(request_id: str, data: Any) -> Dict[str, Any]:
    return {"ok": True, "data": _normalize_json_value(data), "requestId": request_id}


def error_envelope(request_id: str, error: Any) -> Dict[str, Any]:
    auth_error = to_authfn_error(error)
    return {
        "ok": False,
        "error": {
            "code": auth_error.code,
            "message": str(auth_error),
            "retryable": auth_error.retryable,
            "details": _normalize_json_value(auth_error.details),
        },
        "requestId": request_id,
    }


def json_success(
    request: Any,
    data: Any,
    *,
    status: int = 200,
    cookies: Optional[List[SetCookie]] = None,
    headers: Optional[Dict[str, str]] = None,
) -> Response:
    request_id = resolve_request_id(request)
    response_headers = {"content-type": "application/json", "x-request-id": request_id}
    if headers:
        response_headers.update(headers)
    return Response(
        status=status,
        headers=response_headers,
        cookies=cookies or [],
        body=success_envelope(request_id, data),
    )


def json_error(request: Any, error: Any) -> Response:
    request_id = resolve_request_id(request)
    auth_error = to_authfn_error(error)
    return Response(
        status=auth_error.status,
        headers={"content-type": "application/json", "x-request-id": request_id},
        body=error_envelope(request_id, auth_error),
    )


def create_authfn_route_meta(
    operation_id: str,
    summary: str,
    auth: Dict[str, Any],
) -> Dict[str, Any]:
    return {
        "auth": auth,
        "openapi": {
            "operationId": operation_id,
            "summary": summary,
            "tags": ["authfn"],
        },
    }


def create_authfn_routes(config: AuthFnConfig) -> List[Route]:
    routes: List[Route] = [*_create_base_routes(config)]
    for plugin in config.plugins:
        if plugin.name == "password":
            routes.extend(_create_password_routes(config))
        elif plugin.name == "emailOtp":
            routes.extend(_create_otp_routes(config))
        elif plugin.name == "socialOAuth":
            routes.extend(_create_social_routes(config))
        elif plugin.name == "apiKey":
            routes.extend(_create_api_key_routes(config))
        elif plugin.name == "twoFactor":
            routes.extend(_create_two_factor_routes(config))
        elif plugin.name == "multiRegion":
            routes.extend(_create_multi_region_routes(config))
    base_path = (config.base_path or "/auth").rstrip("/")
    resolved_routes = [
        route.model_copy(update={"path": _join_path(base_path, route.path)})
        for route in routes
    ]
    plugin_config = get_plugin_config(config, "multiRegion", MultiRegionPluginConfig())
    routing = plugin_config.routing
    if routing and routing.mode == "gateway":
        placement_middleware = create_cell_routing_middleware(routing, base_path=base_path)
        resolved_routes = [
            route.model_copy(
                update={"middleware": [placement_middleware, *(route.middleware or [])]}
            )
            for route in resolved_routes
        ]
    return resolved_routes


async def authenticate_request(config: AuthFnConfig, request: Any) -> Optional[AuthFnSession]:
    request = _with_url(request, _best_effort_url(request))
    state = await get_cookie_session_state(config, request)
    if state.session is not None:
        return state.session

    api_key_config = get_plugin_config(config, "apiKey", ApiKeyPluginConfig())
    return await ApiKeyService(config, api_key_config).authenticate(request)


async def get_cookie_session_state(
    config: AuthFnConfig,
    request: Any,
    *,
    touch: bool = True,
) -> SessionState:
    runtime = resolve_runtime(config, request)
    cookie_policy = resolve_cookie_policy(config, request, runtime)
    cookies = _parse_cookies(_headers_dict(request).get("cookie", ""))
    session_token = cookies.get(cookie_policy.session_cookie_name)
    csrf_token = cookies.get(cookie_policy.csrf_cookie_name)
    state = SessionState(
        runtime=runtime,
        cookie_policy=cookie_policy,
        session_token=session_token,
        csrf_token=csrf_token,
    )
    if not session_token:
        state.failure_reason = "missing"
        return state

    record = await config.database.find_one(
        model="sessions",
        where=[{"field": "tokenHash", "operator": "eq", "value": _hash_secret(session_token)}],
        namespace=config.namespace,
    )
    if record is None:
        state.failure_reason = "missing"
        return state
    if record.get("revokedAt") is not None:
        state.session_record = record
        state.failure_reason = "revoked"
        return state
    expires_at = record.get("expiresAt")
    if expires_at is not None and _coerce_utc(expires_at) <= _utcnow():
        state.session_record = record
        state.failure_reason = "expired"
        return state

    user = await config.database.find_one(
        model="users",
        where=[{"field": "id", "operator": "eq", "value": record["userId"]}],
        namespace=config.namespace,
    )
    if user is None:
        state.failure_reason = "missing"
        return state

    if not touch:
        state.session_record = record
        state.user = user
        state.session = _build_user_session(record, user, runtime.region_id)
        return state

    now = _utcnow()
    updated = await config.database.update(
        model="sessions",
        where=[{"field": "id", "operator": "eq", "value": record["id"]}],
        data={"lastAuthenticatedAt": now, "updatedAt": now},
        namespace=config.namespace,
    )
    record = updated or {**record, "lastAuthenticatedAt": now, "updatedAt": now}
    state.session_record = record
    state.user = user
    state.session = _build_user_session(record, user, runtime.region_id)
    return state


async def require_cookie_session(config: AuthFnConfig, request: Any) -> SessionState:
    state = await get_cookie_session_state(config, request)
    if state.failure_reason == "revoked":
        raise SessionRevokedError("Session revoked")
    if state.failure_reason == "expired":
        raise SessionExpiredError("Session expired")
    if state.session is None or state.session_record is None or state.user is None:
        raise UnauthorizedError("Authentication required")
    return state


def resolve_cookie_policy(config: AuthFnConfig, request: Any, runtime: Any) -> CookiePolicy:
    cookie_payload = {}
    if config.cookie is not None:
        cookie_payload.update(config.cookie.model_dump(by_alias=True, exclude_none=True))
    runtime_cookie = getattr(runtime, "cookie", None)
    if runtime_cookie is not None:
        if hasattr(runtime_cookie, "model_dump"):
            cookie_payload.update(runtime_cookie.model_dump(by_alias=True, exclude_none=True))
        elif isinstance(runtime_cookie, dict):
            cookie_payload.update({k: v for k, v in runtime_cookie.items() if v is not None})

    prefix = str(cookie_payload.get("prefix") or "authfn").strip() or "authfn"
    path = cookie_payload.get("path") or "/"
    domain = cookie_payload.get("domain")
    secure = bool(cookie_payload.get("secure", True))
    same_site = str(cookie_payload.get("sameSite") or "lax").lower()
    session_max_age_seconds = int(
        cookie_payload.get("sessionMaxAgeSeconds") or DEFAULT_SESSION_MAX_AGE_SECONDS
    )
    csrf_max_age_seconds = int(
        cookie_payload.get("csrfMaxAgeSeconds") or DEFAULT_CSRF_MAX_AGE_SECONDS
    )

    return CookiePolicy(
        prefix=prefix,
        path=path,
        domain=domain,
        secure=secure,
        same_site=same_site,
        session_max_age_seconds=session_max_age_seconds,
        csrf_max_age_seconds=csrf_max_age_seconds,
        session_cookie_name=f"__Secure-{prefix}.session" if secure else f"{prefix}.session",
        csrf_cookie_name=f"{prefix}.csrf",
    )


def issue_session_cookies(
    cookie_policy: CookiePolicy,
    session_token: str,
    csrf_token: str,
) -> List[SetCookie]:
    return [
        SetCookie(
            name=cookie_policy.session_cookie_name,
            value=session_token,
            path=cookie_policy.path,
            domain=cookie_policy.domain,
            secure=cookie_policy.secure,
            httpOnly=True,
            sameSite=cookie_policy.same_site,
            maxAge=cookie_policy.session_max_age_seconds,
        ),
        SetCookie(
            name=cookie_policy.csrf_cookie_name,
            value=csrf_token,
            path=cookie_policy.path,
            domain=cookie_policy.domain,
            secure=cookie_policy.secure,
            httpOnly=False,
            sameSite=cookie_policy.same_site,
            maxAge=cookie_policy.csrf_max_age_seconds,
        ),
    ]


def clear_session_cookies(cookie_policy: CookiePolicy) -> List[SetCookie]:
    expires = datetime.fromtimestamp(0, tz=timezone.utc)
    return [
        SetCookie(
            name=cookie_policy.session_cookie_name,
            value="",
            path=cookie_policy.path,
            domain=cookie_policy.domain,
            secure=cookie_policy.secure,
            httpOnly=True,
            sameSite=cookie_policy.same_site,
            maxAge=0,
            expires=expires,
        ),
        SetCookie(
            name=cookie_policy.csrf_cookie_name,
            value="",
            path=cookie_policy.path,
            domain=cookie_policy.domain,
            secure=cookie_policy.secure,
            httpOnly=False,
            sameSite=cookie_policy.same_site,
            maxAge=0,
            expires=expires,
        ),
    ]


async def issue_session(
    config: AuthFnConfig,
    request: Any,
    *,
    user: Dict[str, Any],
    methods: List[str],
) -> Dict[str, Any]:
    runtime = resolve_runtime(config, request)
    cookie_policy = resolve_cookie_policy(config, request, runtime)
    now = _utcnow()
    payload = {
        "userId": user["id"],
        "primaryEmail": user.get("primaryEmail"),
        "tenantId": None,
        "regionId": getattr(runtime, "region_id", None) or getattr(runtime, "regionId", None),
        "methods": list(methods),
        "metadata": {},
    }
    payload = await _run_before_session_issue_hook(config, request, runtime, payload)
    session_token = _create_opaque_token("st")
    csrf_token = _create_opaque_token("csrf")
    record = {
        "id": _create_opaque_token("sess"),
        "userId": payload["userId"],
        "tokenHash": _hash_secret(session_token),
        "csrfHash": _hash_secret(csrf_token),
        "methods": list(payload["methods"]),
        "metadata": payload.get("metadata") or {},
        "expiresAt": now + timedelta(seconds=cookie_policy.session_max_age_seconds),
        "revokedAt": None,
        "createdAt": now,
        "updatedAt": now,
        "lastAuthenticatedAt": now,
    }
    await config.database.create(model="sessions", data=record, namespace=config.namespace)
    session = _build_user_session(record, user, payload.get("regionId"))
    await _run_after_session_issue_hook(config, request, runtime, session)
    await emit_auth_event(
        config,
        {
            "type": "authfn.session.issued",
            "requestId": event_request_id(request),
            "actorId": session.actor_id,
            "sessionId": session.id,
            "userId": session.actor_id,
            "regionId": session.region_id,
            "outcome": "issued",
            "metadata": {"methods": session.methods},
        },
    )
    return {
        "session": session,
        "record": record,
        "sessionToken": session_token,
        "csrfToken": csrf_token,
        "cookies": issue_session_cookies(cookie_policy, session_token, csrf_token),
        "cookiePolicy": cookie_policy,
    }


async def revoke_session_by_id(
    config: AuthFnConfig,
    session_id: str,
    *,
    user_id: Optional[str] = None,
) -> Dict[str, Any]:
    record = await config.database.find_one(
        model="sessions",
        where=[{"field": "id", "operator": "eq", "value": session_id}],
        namespace=config.namespace,
    )
    if record is None or (user_id is not None and record.get("userId") != user_id):
        raise NotFoundError("Session not found", {"sessionId": session_id})
    if record.get("revokedAt") is not None:
        return record
    revoked_at = _utcnow()
    await config.database.update(
        model="sessions",
        where=[{"field": "id", "operator": "eq", "value": record["id"]}],
        data={"revokedAt": revoked_at, "updatedAt": revoked_at},
        namespace=config.namespace,
    )
    return {**record, "revokedAt": revoked_at, "updatedAt": revoked_at}


def _create_base_routes(config: AuthFnConfig) -> List[Route]:
    return [
        Route(
            method=HttpMethod.GET,
            path="/session",
            handler=_wrap_route(config, _handle_get_session),
            meta=create_authfn_route_meta(
                "getSession",
                "Get the current cookie session",
                {"mode": "cookie-session"},
            ),
        ),
        Route(
            method=HttpMethod.GET,
            path="/sessions",
            handler=_wrap_route(config, _handle_list_sessions),
            meta=create_authfn_route_meta(
                "listSessions",
                "List active sessions for the current user",
                {"mode": "cookie-session"},
            ),
        ),
        Route(
            method=HttpMethod.POST,
            path="/sign-out",
            handler=_wrap_route(config, _handle_sign_out),
            meta=create_authfn_route_meta(
                "signOut",
                "Revoke the current session",
                {"mode": "cookie-session", "csrf": True},
            ),
        ),
        Route(
            method=HttpMethod.POST,
            path="/sessions/:sessionId/revoke",
            handler=_wrap_route(config, _handle_revoke_session),
            meta=create_authfn_route_meta(
                "revokeSession",
                "Revoke a specific session",
                {"mode": "cookie-session", "csrf": True},
            ),
        ),
    ]


def _create_password_routes(config: AuthFnConfig) -> List[Route]:
    return [
        Route(
            method=HttpMethod.POST,
            path="/sign-up/password",
            handler=_wrap_route(config, _handle_sign_up_password),
            meta=create_authfn_route_meta(
                "signUpWithPassword",
                "Create a user and session using email/password",
                {"mode": "none"},
            ),
        ),
        Route(
            method=HttpMethod.POST,
            path="/password/reset/start",
            handler=_wrap_route(config, _handle_password_reset_start),
            meta=create_authfn_route_meta(
                "startPasswordReset",
                "Start an OTP-backed password reset flow",
                {"mode": "none"},
            ),
        ),
        Route(
            method=HttpMethod.POST,
            path="/password/reset/complete",
            handler=_wrap_route(config, _handle_password_reset_complete),
            meta=create_authfn_route_meta(
                "completePasswordReset",
                "Complete a password reset with a valid OTP challenge",
                {"mode": "none"},
            ),
        ),
        Route(
            method=HttpMethod.POST,
            path="/sign-in/password",
            handler=_wrap_route(config, _handle_sign_in_password),
            meta=create_authfn_route_meta(
                "signInWithPassword",
                "Sign in and issue a session using email/password",
                {"mode": "none"},
            ),
        ),
    ]


def _create_otp_routes(config: AuthFnConfig) -> List[Route]:
    return [
        Route(
            method=HttpMethod.POST,
            path="/otp/send",
            handler=_wrap_route(config, _handle_send_otp),
            meta=create_authfn_route_meta("sendOtp", "Send an email OTP challenge", {"mode": "none"}),
        ),
        Route(
            method=HttpMethod.POST,
            path="/otp/verify",
            handler=_wrap_route(config, _handle_verify_otp),
            meta=create_authfn_route_meta(
                "verifyOtp",
                "Verify an email OTP challenge",
                {"mode": "none"},
            ),
        ),
    ]


def _create_social_routes(config: AuthFnConfig) -> List[Route]:
    return [
        Route(
            method=HttpMethod.POST,
            path="/social/start",
            handler=_wrap_route(config, _handle_social_start),
            meta=create_authfn_route_meta(
                "startSocialSignIn",
                "Start social OAuth sign-in",
                {"mode": "none"},
            ),
        ),
        Route(
            method=HttpMethod.GET,
            path="/social/callback/:provider",
            handler=_wrap_route(config, _handle_social_callback),
            meta=create_authfn_route_meta(
                "completeSocialSignIn",
                "Complete social OAuth sign-in",
                {"mode": "none"},
            ),
        ),
        Route(
            method=HttpMethod.POST,
            path="/social/disconnect/:provider",
            handler=_wrap_route(config, _handle_social_disconnect),
            meta=create_authfn_route_meta(
                "disconnectSocialAccount",
                "Disconnect a linked social OAuth account",
                {"mode": "cookie-session", "csrf": True},
            ),
        ),
    ]


def _create_api_key_routes(config: AuthFnConfig) -> List[Route]:
    return [
        Route(
            method=HttpMethod.POST,
            path="/api-keys",
            handler=_wrap_route(config, _handle_create_api_key),
            meta=create_authfn_route_meta(
                "createApiKey",
                "Create a new API key for the current user",
                {"mode": "cookie-session", "csrf": True},
            ),
        ),
        Route(
            method=HttpMethod.GET,
            path="/api-keys",
            handler=_wrap_route(config, _handle_list_api_keys),
            meta=create_authfn_route_meta(
                "listApiKeys",
                "List API keys for the current user",
                {"mode": "cookie-session"},
            ),
        ),
        Route(
            method=HttpMethod.DELETE,
            path="/api-keys/:keyId",
            handler=_wrap_route(config, _handle_revoke_api_key),
            meta=create_authfn_route_meta(
                "revokeApiKey",
                "Revoke an API key for the current user",
                {"mode": "cookie-session", "csrf": True},
            ),
        ),
    ]


def _create_two_factor_routes(config: AuthFnConfig) -> List[Route]:
    return [
        Route(
            method=HttpMethod.POST,
            path="/2fa/enroll",
            handler=_wrap_route(config, _handle_two_factor_enroll),
            meta=create_authfn_route_meta(
                "enrollTwoFactor",
                "Create a 2FA enrollment and recovery codes",
                {"mode": "cookie-session", "csrf": True},
            ),
        ),
        Route(
            method=HttpMethod.POST,
            path="/2fa/confirm",
            handler=_wrap_route(config, _handle_two_factor_confirm),
            meta=create_authfn_route_meta(
                "confirmTwoFactor",
                "Confirm a 2FA enrollment with a valid TOTP code",
                {"mode": "cookie-session", "csrf": True},
            ),
        ),
        Route(
            method=HttpMethod.POST,
            path="/2fa/challenge",
            handler=_wrap_route(config, _handle_two_factor_challenge),
            meta=create_authfn_route_meta(
                "completeTwoFactorChallenge",
                "Complete a pending two-factor sign-in challenge",
                {"mode": "none"},
            ),
        ),
        Route(
            method=HttpMethod.POST,
            path="/2fa/disable",
            handler=_wrap_route(config, _handle_two_factor_disable),
            meta=create_authfn_route_meta(
                "disableTwoFactor",
                "Disable 2FA with a valid TOTP or recovery code",
                {"mode": "cookie-session", "csrf": True},
            ),
        ),
    ]


def _create_multi_region_routes(config: AuthFnConfig) -> List[Route]:
    return [
        Route(
            method=HttpMethod.POST,
            path="/regions/lookup",
            handler=_wrap_route(config, _handle_region_lookup),
            meta=create_authfn_route_meta(
                "lookupRegion",
                "Lookup region routing guidance for an identifier",
                {"mode": "none"},
            ),
        ),
        Route(
            method=HttpMethod.GET,
            path="/environment",
            handler=_wrap_route(config, _handle_runtime),
            meta=create_authfn_route_meta(
                "getEnvironment",
                "Get resolved runtime and cookie/provider overrides",
                {"mode": "none"},
            ),
        ),
        Route(
            method=HttpMethod.GET,
            path="/runtime",
            handler=_wrap_route(config, _handle_runtime),
            meta=create_authfn_route_meta(
                "getRuntime",
                "Compatibility alias for the resolved runtime environment",
                {"mode": "none"},
            ),
        ),
    ]


def _wrap_route(
    config: AuthFnConfig,
    handler: Callable[[AuthFnConfig, Any, RouteContext], Awaitable[Response]],
) -> Callable[[Any, RouteContext], Awaitable[Response]]:
    async def wrapped(request: Any, context: RouteContext) -> Response:
        try:
            return await handler(config, _with_url(request, context.url), context)
        except Exception as error:  # noqa: BLE001
            return json_error(request, error)

    return wrapped


async def _handle_get_session(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    state = await get_cookie_session_state(config, request)
    cookies = clear_session_cookies(state.cookie_policy) if state.failure_reason else []
    return json_success(request, {"session": state.session}, cookies=cookies)


async def _handle_list_sessions(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    state = await require_cookie_session(config, request)
    rows = await config.database.find_many(
        model="sessions",
        where=[{"field": "userId", "operator": "eq", "value": state.user["id"]}],
        order_by=[
            {"field": "createdAt", "direction": "asc"},
            {"field": "id", "direction": "asc"},
        ],
        namespace=config.namespace,
    )
    active = [
        _build_user_session(row, state.user, getattr(state.runtime, "region_id", None) or getattr(state.runtime, "regionId", None))
        for row in rows
        if row.get("revokedAt") is None and row.get("expiresAt") and _coerce_utc(row["expiresAt"]) > _utcnow()
    ]
    return json_success(
        request,
        {"sessions": active, "currentSessionId": state.session.id},
    )


async def _handle_sign_out(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    state = await get_cookie_session_state(config, request)
    body = await _read_json(request)
    all_sessions = bool(body.get("allSessions"))
    cookies = clear_session_cookies(state.cookie_policy)
    if state.session is None or state.session_record is None or state.user is None:
        return json_success(request, {"revoked": False, "allSessions": all_sessions}, cookies=cookies)

    _assert_valid_csrf(request, state)
    if all_sessions:
        rows = await config.database.find_many(
            model="sessions",
            where=[{"field": "userId", "operator": "eq", "value": state.user["id"]}],
            order_by=[],
            namespace=config.namespace,
        )
        for row in rows:
            if row.get("revokedAt") is None:
                await config.database.update(
                    model="sessions",
                    where=[{"field": "id", "operator": "eq", "value": row["id"]}],
                    data={"revokedAt": _utcnow(), "updatedAt": _utcnow()},
                    namespace=config.namespace,
                )
    else:
        await config.database.update(
            model="sessions",
            where=[{"field": "id", "operator": "eq", "value": state.session.id}],
            data={"revokedAt": _utcnow(), "updatedAt": _utcnow()},
            namespace=config.namespace,
        )
    return json_success(request, {"revoked": True, "allSessions": all_sessions}, cookies=cookies)


async def _handle_revoke_session(config: AuthFnConfig, request: Any, context: RouteContext) -> Response:
    state = await require_cookie_session(config, request)
    _assert_valid_csrf(request, state)
    target = await config.database.find_one(
        model="sessions",
        where=[{"field": "id", "operator": "eq", "value": context.params["sessionId"]}],
        namespace=config.namespace,
    )
    if target is None or target.get("userId") != state.user["id"]:
        raise NotFoundError("Session not found", {"sessionId": context.params["sessionId"]})
    await config.database.update(
        model="sessions",
        where=[{"field": "id", "operator": "eq", "value": context.params["sessionId"]}],
        data={"revokedAt": _utcnow(), "updatedAt": _utcnow()},
        namespace=config.namespace,
    )
    cookies = clear_session_cookies(state.cookie_policy) if context.params["sessionId"] == state.session.id else []
    return json_success(request, {"revoked": True, "sessionId": context.params["sessionId"]}, cookies=cookies)


async def _handle_sign_up_password(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    body = await _read_json(request)
    user = await _sign_up_with_password(config, request, body.get("email"), body.get("password"), body.get("profile"))
    runtime = resolve_runtime(config, request)
    await emit_auth_event(
        config,
        {
            "type": "authfn.user.created",
            "requestId": event_request_id(request),
            "actorId": user["id"],
            "userId": user["id"],
            "regionId": getattr(runtime, "region_id", None) or getattr(runtime, "regionId", None),
            "outcome": "created",
            "metadata": {"email": user.get("primaryEmail")},
        },
    )
    issued = await issue_session(config, request, user=user, methods=["password"])
    return json_success(request, {"session": issued["session"]}, cookies=issued["cookies"])


async def _handle_sign_in_password(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    body = await _read_json(request)
    user = await _sign_in_with_password(config, body.get("email"), body.get("password"))
    await _ensure_region_alignment(config, request, user["id"])
    challenge = await _maybe_begin_two_factor(config, request, user["id"], "password")
    if challenge is not None:
        raise challenge
    issued = await issue_session(config, request, user=user, methods=["password"])
    return json_success(request, {"session": issued["session"]}, cookies=issued["cookies"])


async def _handle_password_reset_start(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    body = await _read_json(request)
    plugin_config = get_plugin_config(config, "emailOtp", EmailOtpPluginConfig())
    result = await EmailOtpService(config, plugin_config).send_challenge(
        "reset-password",
        body.get("email", ""),
        request=request,
    )
    return json_success(request, {"challengeId": result["challenge"]["id"], "sent": True})


async def _handle_password_reset_complete(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    body = await _read_json(request)
    plugin_config = get_plugin_config(config, "emailOtp", EmailOtpPluginConfig())
    result = await EmailOtpService(config, plugin_config).complete_reset_password(
        body.get("email", ""),
        body.get("code", ""),
        body.get("newPassword", ""),
        request=request,
    )
    return json_success(request, result)


async def _handle_send_otp(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    body = await _read_json(request)
    plugin_config = get_plugin_config(config, "emailOtp", EmailOtpPluginConfig())
    result = await EmailOtpService(config, plugin_config).send_challenge(
        body.get("purpose", "verify-email"),
        body.get("email", ""),
        request=request,
    )
    return json_success(request, {"challengeId": result["challenge"]["id"], "sent": True})


async def _handle_verify_otp(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    body = await _read_json(request)
    purpose = body.get("purpose", "verify-email")
    plugin_config = get_plugin_config(config, "emailOtp", EmailOtpPluginConfig())
    service = EmailOtpService(config, plugin_config)
    result = await service.verify_challenge(
        purpose,
        body.get("email", ""),
        body.get("code", ""),
        request=request,
    )
    user = result.get("user")
    if purpose == "sign-in" and user is not None:
        await _ensure_region_alignment(config, request, user["id"])
        challenge = await _maybe_begin_two_factor(config, request, user["id"], "email-otp")
        if challenge is not None:
            raise challenge
        issued = await issue_session(config, request, user=user, methods=["email-otp"])
        return json_success(request, {"session": issued["session"]}, cookies=issued["cookies"])
    return json_success(request, {"verified": True})


async def _handle_social_start(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    from .plugins.social_oauth import SocialOAuthPluginConfig, SocialOAuthService

    body = await _read_json(request)
    plugin_config = get_plugin_config(config, "socialOAuth", SocialOAuthPluginConfig())
    service = SocialOAuthService(config, plugin_config)
    result = await service.start(
        body.get("provider", ""),
        return_to=body.get("returnTo"),
        callback_mode=body.get("callbackMode"),
        request=request,
    )
    return json_success(request, result)


async def _handle_social_callback(config: AuthFnConfig, request: Any, context: RouteContext) -> Response:
    from .plugins.social_oauth import SocialOAuthPluginConfig, SocialOAuthService

    parsed = urlparse(_best_effort_url(request))
    query = parse_qs(parsed.query)
    provider = context.params["provider"]
    plugin_config = get_plugin_config(config, "socialOAuth", SocialOAuthPluginConfig())
    service = SocialOAuthService(config, plugin_config)
    callback = await service.handle_callback(
        provider,
        code=(query.get("code") or [""])[0],
        state=(query.get("state") or [""])[0],
        request=request,
    )
    user_id = callback.get("userId")
    if not user_id:
        raise InternalError("OAuth callback did not resolve an authfn user", {"provider": provider})
    user = await config.database.find_one(
        model="users",
        where=[{"field": "id", "operator": "eq", "value": user_id}],
        namespace=config.namespace,
    )
    if user is None:
        raise InternalError("OAuth callback linked a missing authfn user", {"provider": provider, "userId": user_id})

    method = f"oauth-{provider}"
    challenge = await _maybe_begin_two_factor(config, request, user_id, method)
    if challenge is not None:
        raise challenge
    issued = await issue_session(config, request, user=user, methods=[method])

    if callback.get("callbackMode") == "redirect" or callback.get("status") == 303:
        return Response(
            status=303,
            headers={"location": callback.get("redirectTo", ""), "x-request-id": resolve_request_id(request)},
            cookies=issued["cookies"],
        )

    return json_success(
        request,
        {"linked": True, "provider": provider, "session": issued["session"]},
        cookies=issued["cookies"],
    )


async def _handle_social_disconnect(config: AuthFnConfig, request: Any, context: RouteContext) -> Response:
    from .plugins.social_oauth import SocialOAuthPluginConfig, SocialOAuthService

    state = await require_cookie_session(config, request)
    _assert_valid_csrf(request, state)
    plugin_config = get_plugin_config(config, "socialOAuth", SocialOAuthPluginConfig())
    result = await SocialOAuthService(config, plugin_config).disconnect(state.user["id"], context.params["provider"])
    return json_success(request, result)


async def _handle_create_api_key(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    state = await require_cookie_session(config, request)
    _assert_valid_csrf(request, state)
    body = await _read_json(request)
    plugin_config = get_plugin_config(config, "apiKey", ApiKeyPluginConfig())
    created = await ApiKeyService(config, plugin_config).create_key(
        user_id=state.user["id"],
        name=body.get("name", "api-key"),
        scopes=body.get("scopes"),
        metadata=body.get("metadata"),
        expires_at=_parse_optional_datetime(body.get("expiresAt")),
    )
    await emit_auth_event(
        config,
        {
            "type": "authfn.api_key.created",
            "requestId": event_request_id(request),
            "actorId": state.user["id"],
            "userId": state.user["id"],
            "outcome": "created",
            "metadata": {
                "keyId": created["keyId"],
                "scopes": body.get("scopes") or [],
            },
        },
    )
    return json_success(
        request,
        {"keyId": created["keyId"], "secret": created["secret"], "secretReturnedOnce": True},
        status=201,
    )


async def _handle_list_api_keys(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    state = await require_cookie_session(config, request)
    plugin_config = get_plugin_config(config, "apiKey", ApiKeyPluginConfig())
    keys = await ApiKeyService(config, plugin_config).list_keys(user_id=state.user["id"])
    return json_success(request, {"keys": keys})


async def _handle_revoke_api_key(config: AuthFnConfig, request: Any, context: RouteContext) -> Response:
    state = await require_cookie_session(config, request)
    _assert_valid_csrf(request, state)
    plugin_config = get_plugin_config(config, "apiKey", ApiKeyPluginConfig())
    await ApiKeyService(config, plugin_config).revoke_key(
        key_id=context.params["keyId"], user_id=state.user["id"]
    )
    await emit_auth_event(
        config,
        {
            "type": "authfn.api_key.revoked",
            "requestId": event_request_id(request),
            "actorId": state.user["id"],
            "userId": state.user["id"],
            "outcome": "revoked",
            "metadata": {"keyId": context.params["keyId"]},
        },
    )
    return json_success(request, {"revoked": True, "keyId": context.params["keyId"]})


async def _handle_two_factor_enroll(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    state = await require_cookie_session(config, request)
    _assert_valid_csrf(request, state)
    plugin_config = get_plugin_config(config, "twoFactor", TwoFactorPluginConfig())
    result = await TwoFactorService(config, plugin_config).enroll(
        user_id=state.user["id"], primary_email=state.user.get("primaryEmail")
    )
    return json_success(request, result)


async def _handle_two_factor_confirm(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    state = await require_cookie_session(config, request)
    _assert_valid_csrf(request, state)
    body = await _read_json(request)
    plugin_config = get_plugin_config(config, "twoFactor", TwoFactorPluginConfig())
    await TwoFactorService(config, plugin_config).confirm(user_id=state.user["id"], code=body.get("code", ""))
    updated = list(state.session.methods)
    if "two-factor" not in updated:
        updated.append("two-factor")
    await config.database.update(
        model="sessions",
        where=[{"field": "id", "operator": "eq", "value": state.session.id}],
        data={"methods": updated, "updatedAt": _utcnow()},
        namespace=config.namespace,
    )
    return json_success(request, {"enabled": True, "sessionMethods": updated})


async def _handle_two_factor_challenge(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    body = await _read_json(request)
    plugin_config = get_plugin_config(config, "twoFactor", TwoFactorPluginConfig())
    service = TwoFactorService(config, plugin_config)
    result = await service.complete_sign_in_challenge(
        challenge_id=body.get("challengeId", ""),
        code=body.get("code", ""),
    )
    user = await config.database.find_one(
        model="users",
        where=[{"field": "id", "operator": "eq", "value": result["session"].actor_id}],
        namespace=config.namespace,
    )
    if user is None:
        raise NotFoundError("User not found", {"userId": result["session"].actor_id})
    issued = await issue_session(config, request, user=user, methods=result["session"].methods)
    return json_success(
        request,
        {"twoFactorSatisfied": True, "session": issued["session"]},
        cookies=issued["cookies"],
    )


async def _handle_two_factor_disable(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    state = await require_cookie_session(config, request)
    _assert_valid_csrf(request, state)
    body = await _read_json(request)
    plugin_config = get_plugin_config(config, "twoFactor", TwoFactorPluginConfig())
    result = await TwoFactorService(config, plugin_config).disable(user_id=state.user["id"], code=body.get("code", ""))
    return json_success(request, result)


async def _handle_region_lookup(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    body = await _read_json(request)
    plugin_config = get_plugin_config(config, "multiRegion", MultiRegionPluginConfig())
    if plugin_config.routing and plugin_config.routing.mode == "gateway":
        identifier = _normalize_email(body.get("identifier"))
        runtime = MultiRegionService(config, plugin_config).resolve_runtime(request)
        await emit_auth_event(
            config,
            {
                "type": "authfn.region.lookup",
                "requestId": event_request_id(request),
                "regionId": runtime.region_id,
                "outcome": "local",
                "metadata": {
                    "identifier": identifier,
                    "authority": runtime.issuer,
                    "continueLocally": True,
                },
            },
        )
        return json_success(
            request,
            {
                "identifier": identifier,
                "authority": runtime.issuer,
                "continueLocally": True,
            },
        )
    result = await MultiRegionService(config, plugin_config).lookup(identifier=body.get("identifier", ""), request=request)
    await emit_auth_event(
        config,
        {
            "type": "authfn.region.lookup",
            "requestId": event_request_id(request),
            "userId": result.get("userId"),
            "regionId": result.get("regionId"),
            "outcome": "local" if result.get("continueLocally") else "redirect",
            "metadata": {
                "identifier": result.get("identifier"),
                "authority": result.get("authority"),
                "continueLocally": result.get("continueLocally"),
            },
        },
    )
    return json_success(request, result)


async def _handle_runtime(config: AuthFnConfig, request: Any, _context: RouteContext) -> Response:
    runtime = resolve_runtime(config, request)
    plugin_config = get_plugin_config(config, "multiRegion", MultiRegionPluginConfig())
    cookie_policy = resolve_cookie_policy(config, request, runtime)
    oauth = getattr(runtime, "oauth", None) or {}
    return json_success(
        request,
        {
            "issuer": runtime.issuer,
            "baseUrl": runtime.base_url if hasattr(runtime, "base_url") else runtime.baseUrl,
            "regionId": None
            if plugin_config.routing and plugin_config.routing.mode == "gateway"
            else getattr(runtime, "region_id", None) or getattr(runtime, "regionId", None),
            "cookie": {
                "prefix": cookie_policy.prefix,
                "domain": cookie_policy.domain,
                "secure": cookie_policy.secure,
                "sameSite": cookie_policy.same_site,
                "path": cookie_policy.path,
                "sessionCookieName": cookie_policy.session_cookie_name,
                "csrfCookieName": cookie_policy.csrf_cookie_name,
            },
            "oauth": {
                provider_id: {
                    "clientId": provider.get("clientId"),
                    "hasClientSecret": bool(provider.get("clientSecret")),
                    "hasClientSecretResolver": bool(provider.get("clientSecretResolver")),
                    "allowlistedRedirectUris": provider.get("allowlistedRedirectUris", []),
                    "allowlistedReturnTo": provider.get("allowlistedReturnTo", []),
                    "scopes": provider.get("scopes", []),
                }
                for provider_id, provider in oauth.items()
            },
        },
    )


async def _sign_up_with_password(
    config: AuthFnConfig,
    request: Any,
    email: Optional[str],
    password: Optional[str],
    profile: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    normalized_email = _normalize_email(email)
    _assert_valid_password(password)
    runtime = resolve_runtime(config, request)
    payload = {"primaryEmail": normalized_email, "metadata": profile or {}}
    payload = await _run_before_user_create_hook(config, request, runtime, payload)
    resolved_email = _normalize_email(payload.get("primaryEmail"))
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else profile or {}
    existing = await config.database.find_one(
        model="users",
        where=[{"field": "primaryEmail", "operator": "eq", "value": resolved_email}],
        namespace=config.namespace,
    )
    if existing is not None:
        raise ConflictError("A user with this email already exists", {"primaryEmail": resolved_email})

    now = _utcnow()
    user = {
        "id": _create_id("user"),
        "primaryEmail": resolved_email,
        "emailVerifiedAt": None,
        "metadata": metadata,
        "createdAt": now,
        "updatedAt": now,
    }
    await config.database.create(model="users", data=user, namespace=config.namespace)
    await config.database.create(
        model="password_credentials",
        data={
            "id": _create_id("pwd"),
            "userId": user["id"],
            "passwordHash": _hash_password(password or ""),
            "createdAt": now,
            "updatedAt": now,
        },
        namespace=config.namespace,
    )
    await _register_multi_region_user(config, request, user)
    await _run_after_user_create_hook(config, request, runtime, user)
    return user


async def _sign_in_with_password(
    config: AuthFnConfig,
    email: Optional[str],
    password: Optional[str],
) -> Dict[str, Any]:
    normalized_email = _normalize_email(email)
    if not password:
        raise ValidationError("Password is required")
    user = await config.database.find_one(
        model="users",
        where=[{"field": "primaryEmail", "operator": "eq", "value": normalized_email}],
        namespace=config.namespace,
    )
    if user is None:
        raise InvalidCredentialsError("Invalid email or password")
    credential = await config.database.find_one(
        model="password_credentials",
        where=[{"field": "userId", "operator": "eq", "value": user["id"]}],
        namespace=config.namespace,
    )
    if credential is None or not _verify_password(password, credential["passwordHash"]):
        raise InvalidCredentialsError("Invalid email or password")
    return user


async def _run_before_user_create_hook(
    config: AuthFnConfig,
    request: Any,
    runtime: Any,
    payload: Dict[str, Any],
) -> Dict[str, Any]:
    hooks = config.hooks
    hook = getattr(hooks, "before_user_create", None) if hooks else None
    if hook is None:
        return payload
    try:
        result = await _maybe_await(hook(AuthFnHookContext(config=config, request=request, runtime=runtime), payload))
    except AuthFnError:
        raise
    except Exception as error:  # noqa: BLE001
        await emit_auth_event(
            config,
            {
                "type": "authfn.plugin.failed",
                "requestId": event_request_id(request),
                "pluginName": "config",
                "hookName": "beforeUserCreate",
                "outcome": "aborted",
                "metadata": {"errorCode": "AUTHFN_INTERNAL_ERROR", "retryable": False},
            },
        )
        raise PluginAbortedError(
            "beforeUserCreate hook aborted user creation",
            {"cause": str(error)},
        ) from error
    return result or payload


async def _run_after_user_create_hook(
    config: AuthFnConfig,
    request: Any,
    runtime: Any,
    user: Dict[str, Any],
) -> None:
    hooks = config.hooks
    hook = getattr(hooks, "after_user_create", None) if hooks else None
    if hook is None:
        return
    try:
        await _maybe_await(
            hook(
                AuthFnHookContext(
                    config=config,
                    request=request,
                    runtime=runtime,
                    actor_id=user["id"],
                ),
                user,
            )
        )
    except Exception:  # noqa: BLE001
        await emit_auth_event(
            config,
            {
                "type": "authfn.plugin.failed",
                "requestId": event_request_id(request),
                "actorId": user["id"],
                "pluginName": "config",
                "hookName": "afterUserCreate",
                "outcome": "observed",
                "metadata": {"errorCode": "AUTHFN_INTERNAL_ERROR", "retryable": False},
            },
        )
        return


async def _run_before_session_issue_hook(
    config: AuthFnConfig,
    request: Any,
    runtime: Any,
    payload: Dict[str, Any],
) -> Dict[str, Any]:
    hooks = config.hooks
    hook = getattr(hooks, "before_session_issue", None) if hooks else None
    if hook is None:
        return payload
    try:
        result = await _maybe_await(
            hook(
                AuthFnHookContext(
                    config=config,
                    request=request,
                    runtime=runtime,
                    actor_id=payload["userId"],
                ),
                payload,
            )
        )
    except AuthFnError:
        raise
    except Exception as error:  # noqa: BLE001
        await emit_auth_event(
            config,
            {
                "type": "authfn.plugin.failed",
                "requestId": event_request_id(request),
                "actorId": payload["userId"],
                "pluginName": "config",
                "hookName": "beforeSessionIssue",
                "outcome": "aborted",
                "metadata": {"errorCode": "AUTHFN_INTERNAL_ERROR", "retryable": False},
            },
        )
        raise PluginAbortedError(
            "beforeSessionIssue hook aborted session issuance",
            {"cause": str(error), "actorId": payload["userId"]},
        ) from error
    return result or payload


async def _run_after_session_issue_hook(
    config: AuthFnConfig,
    request: Any,
    runtime: Any,
    session: AuthFnSession,
) -> None:
    hooks = config.hooks
    hook = getattr(hooks, "after_session_issue", None) if hooks else None
    if hook is None:
        return
    try:
        await _maybe_await(
            hook(
                AuthFnHookContext(
                    config=config,
                    request=request,
                    runtime=runtime,
                    actor_id=session.actor_id,
                    session=session,
                ),
                session,
            )
        )
    except Exception:  # noqa: BLE001
        await emit_auth_event(
            config,
            {
                "type": "authfn.plugin.failed",
                "requestId": event_request_id(request),
                "actorId": session.actor_id,
                "pluginName": "config",
                "hookName": "afterSessionIssue",
                "outcome": "observed",
                "metadata": {"errorCode": "AUTHFN_INTERNAL_ERROR", "retryable": False},
            },
        )
        return


async def _maybe_begin_two_factor(
    config: AuthFnConfig,
    request: Any,
    user_id: str,
    primary_method: str,
) -> Optional[AuthFnError]:
    if get_plugin_config(config, "twoFactor") is None:
        return None
    plugin_config = get_plugin_config(config, "twoFactor", TwoFactorPluginConfig())
    challenge = await TwoFactorService(config, plugin_config).begin_sign_in_challenge(
        user_id=user_id,
        primary_method=primary_method,
    )
    if challenge is None:
        return None
    runtime = resolve_runtime(config, request)
    await emit_auth_event(
        config,
        {
            "type": "authfn.2fa.challenged",
            "requestId": event_request_id(request),
            "actorId": user_id,
            "userId": user_id,
            "regionId": getattr(runtime, "region_id", None) or getattr(runtime, "regionId", None),
            "outcome": "required",
            "metadata": {
                "challengeId": challenge["id"],
                "primaryMethod": primary_method,
            },
        },
    )
    return TwoFactorService(config, plugin_config).pending_error(challenge)


async def _register_multi_region_user(config: AuthFnConfig, request: Any, user: Dict[str, Any]) -> None:
    plugin_config = get_plugin_config(config, "multiRegion")
    if plugin_config is None:
        return
    if not user.get("primaryEmail"):
        return
    await MultiRegionService(config, plugin_config).register_user(
        user_id=user["id"],
        primary_email=user["primaryEmail"],
        request=request,
    )


async def _ensure_region_alignment(config: AuthFnConfig, request: Any, user_id: str) -> None:
    plugin_config = get_plugin_config(config, "multiRegion")
    if plugin_config is None:
        return
    await MultiRegionService(config, plugin_config).ensure_region_alignment(user_id=user_id, request=request)


def _assert_valid_csrf(request: Any, state: SessionState) -> None:
    header_token = _headers_dict(request).get("x-authfn-csrf")
    if not header_token or not state.csrf_token or not state.session_record:
        raise CsrfInvalidError("CSRF token invalid")
    if not secrets.compare_digest(header_token, state.csrf_token):
        raise CsrfInvalidError("CSRF token invalid")
    expected = state.session_record.get("csrfHash")
    actual = _hash_secret(header_token)
    if not expected or not secrets.compare_digest(actual, expected):
        raise CsrfInvalidError("CSRF token invalid")


def _build_user_session(record: Dict[str, Any], user: Dict[str, Any], region_id: Optional[str]) -> AuthFnSession:
    return AuthFnSession.model_validate(
        {
            "id": record["id"],
            "type": "session",
            "subject": {
                "actorId": user["id"],
                "actorType": "user",
                "regionId": region_id,
                "email": user.get("primaryEmail"),
            },
            "actorType": "user",
            "actorId": user["id"],
            "regionId": region_id,
            "resourceIds": [],
            "methods": list(record.get("methods") or []),
            "primaryEmail": user.get("primaryEmail"),
            "expiresAt": record.get("expiresAt"),
            "metadata": record.get("metadata"),
        }
    )


def _headers_dict(request: Any) -> Dict[str, str]:
    headers = getattr(request, "headers", {}) or {}
    if hasattr(headers, "items"):
        return {str(key).lower(): value for key, value in headers.items()}
    return {str(key).lower(): value for key, value in dict(headers).items()}


def _parse_cookies(header: str) -> Dict[str, str]:
    values: Dict[str, str] = {}
    for part in header.split(";"):
        if "=" not in part:
            continue
        name, value = part.split("=", 1)
        values[name.strip()] = value.strip()
    return values


async def _read_json(request: Any) -> Dict[str, Any]:
    try:
        payload = await request.json()
    except Exception as err:  # noqa: BLE001
        raw = await request.text()
        if not raw:
            return {}
        raise ValidationError("Request body must be valid JSON") from err
    if payload is None:
        return {}
    if not isinstance(payload, dict):
        raise ValidationError("Request body must be a JSON object")
    return payload


def _normalize_email(value: Optional[str]) -> str:
    normalized = (value or "").strip().lower()
    if not normalized or "@" not in normalized:
        raise ValidationError("A valid email is required")
    return normalized


def _assert_valid_password(password: Optional[str]) -> None:
    if not password or len(password) < MIN_PASSWORD_LENGTH:
        raise ValidationError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")


def _hash_password(password: str) -> str:
    _assert_valid_password(password)
    salt = secrets.token_hex(16)
    if hasattr(hashlib, "scrypt"):
        derived = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt.encode("utf-8"),
            n=PASSWORD_HASH_N,
            r=PASSWORD_HASH_R,
            p=PASSWORD_HASH_P,
            dklen=PASSWORD_HASH_KEY_LENGTH,
        )
        return "$".join(
            [
                PASSWORD_HASH_ALGO,
                str(PASSWORD_HASH_N),
                str(PASSWORD_HASH_R),
                str(PASSWORD_HASH_P),
                salt,
                derived.hex(),
            ]
        )

    iterations = 600_000
    derived = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        iterations,
        dklen=PASSWORD_HASH_KEY_LENGTH,
    )
    return "$".join(["pbkdf2-sha256", str(iterations), salt, derived.hex()])


def _verify_password(password: str, stored_hash: str) -> bool:
    parts = stored_hash.split("$")
    if len(parts) == 6 and parts[0] == PASSWORD_HASH_ALGO:
        if not hasattr(hashlib, "scrypt"):
            raise InternalError("Stored password hash format is invalid")
        _, n_raw, r_raw, p_raw, salt, digest = parts
        derived = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt.encode("utf-8"),
            n=int(n_raw),
            r=int(r_raw),
            p=int(p_raw),
            dklen=len(bytes.fromhex(digest)),
        )
        return secrets.compare_digest(derived.hex(), digest)

    if len(parts) == 4 and parts[0] == "pbkdf2-sha256":
        _, iterations_raw, salt, digest = parts
        derived = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt.encode("utf-8"),
            int(iterations_raw),
            dklen=len(bytes.fromhex(digest)),
        )
        return secrets.compare_digest(derived.hex(), digest)

    raise InternalError("Stored password hash format is invalid")


def _hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _create_opaque_token(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(24)}"


def _create_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def _parse_optional_datetime(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(tzinfo=None)


async def _maybe_await(value: Any) -> Any:
    if hasattr(value, "__await__"):
        return await value
    return value


def _best_effort_url(request: Any) -> str:
    if hasattr(request, "url"):
        return str(request.url)
    headers = _headers_dict(request)
    host = headers.get("x-forwarded-host") or headers.get("host") or "account.example.com"
    scheme = headers.get("x-forwarded-proto") or "https"
    path = getattr(request, "path", "/auth")
    return f"{scheme}://{host}{path}"


def _join_path(base_path: str, path: str) -> str:
    if not path.startswith("/"):
        path = f"/{path}"
    return f"{base_path}{path}"


def _normalize_json_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if hasattr(value, "model_dump"):
        return _normalize_json_value(value.model_dump(by_alias=True, exclude_none=True))
    if isinstance(value, dict):
        return {key: _normalize_json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize_json_value(item) for item in value]
    return value


def _with_url(request: Any, url: str) -> Any:
    if hasattr(request, "url"):
        return request

    class RequestWithUrl:
        def __init__(self, base: Any, resolved_url: str) -> None:
            self._base = base
            self.url = resolved_url

        @property
        def method(self) -> Optional[str]:
            return getattr(self._base, "method", None)

        @property
        def path(self) -> Optional[str]:
            return getattr(self._base, "path", None)

        @property
        def headers(self) -> Dict[str, str]:
            return cast(Dict[str, str], getattr(self._base, "headers", {}))

        @property
        def query_params(self) -> Dict[str, Any]:
            return getattr(self._base, "query_params", {})

        async def json(self) -> Any:
            return await self._base.json()

        async def body(self) -> bytes:
            return await self._base.body()

        async def text(self) -> str:
            return await self._base.text()

    return RequestWithUrl(request, url)


def create_authfn_openapi(config: AuthFnConfig, title: str = "AuthFn API", version: str = "0.0.1") -> Dict[str, Any]:
    from superfunctions.http.openapi import OpenApiGenerationError, generate_openapi_document

    try:
        return generate_openapi_document(title, version, create_authfn_routes(config))
    except OpenApiGenerationError as error:
        raise InternalError(
            "AuthFn OpenAPI generation failed",
            {"code": error.code, "details": error.details},
        ) from error


__all__ = [
    "authenticate_request",
    "clear_session_cookies",
    "create_authfn_openapi",
    "create_authfn_route_meta",
    "create_authfn_routes",
    "error_envelope",
    "get_cookie_session_state",
    "issue_session",
    "issue_session_cookies",
    "revoke_session_by_id",
    "json_error",
    "json_success",
    "resolve_cookie_policy",
    "resolve_request_id",
    "success_envelope",
]
