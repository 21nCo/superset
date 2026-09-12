"""Placement-bound auth context for trusted AuthFn consumers."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import inspect
import ipaddress
import json
import secrets
import time
import unicodedata
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence, Tuple, TypeGuard, cast
from urllib.parse import unquote, urlparse

import idna
from idna import idnadata

from ..http import _coerce_utc, _hash_secret, get_cookie_session_state
from ..observability import emit_auth_event, resolve_request_id
from ..plugins.gateway_routing import (
    IdentityPlacement,
    IdentityPlacementDirectory,
    RoutingKeyring,
    RoutingSigningKey,
)
from ..types import (
    ApiKeyRevokedError,
    AuthFnConfig,
    ConfigError,
    ExpiredCredentialsError,
    PlacementContextInvalidError,
    PlacementDirectoryUnavailableError,
    PlacementMovingError,
    RegionNotFoundError,
    SessionExpiredError,
    SessionRevokedError,
    UnauthorizedError,
    ValidationError,
)

CONTEXT_KIND = "placement-context"
INTERNAL_HEADER_PREFIX = "x-authfn-routing-"
DEFAULT_TTL_SECONDS = 60
MAX_TTL_SECONDS = 300
AUTH_REQUIRED = "Authentication required"
SESSION_EXPIRED = "Session expired"
SESSION_REVOKED = "Session revoked"
INVALID_AUTHORITY = "AuthFn publicAuthority must be a valid origin"


@dataclass(frozen=True)
class PlacementBoundAuthContext:
    subject: str
    home_region: str
    placement_epoch: int
    issuer: str
    session_binding: str
    session_version: str
    authenticated_at: str
    issued_at: str
    expires_at: str
    audience: str
    assurance: Tuple[str, ...]
    request_id: str
    actor_type: str
    scopes: Optional[Tuple[str, ...]] = None
    user_id: Optional[str] = None


class PlacementContextIssuer:
    """Opt-in in-process and private-service placement context issuer."""

    def __init__(
        self,
        *,
        config: AuthFnConfig,
        region_id: str,
        subject_secret: bytes | str,
        audiences: Sequence[str],
        public_authority: str,
        placement_directory: IdentityPlacementDirectory,
        identity_key_for_user_id: Callable[[str], str | Awaitable[str]],
        audience: Optional[str] = None,
        keyring: Optional[RoutingKeyring] = None,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        clock_skew_seconds: int = 5,
        include_user_id: bool = False,
        clock: Callable[[], float] = time.time,
        on_event: Optional[Callable[[Dict[str, Any]], Any]] = None,
    ) -> None:
        if not isinstance(region_id, str) or not region_id.strip():
            raise ConfigError("Placement-context issuance requires the region owning config.database")
        self._region_id = region_id.strip()
        mac_key = _secret_bytes(subject_secret)
        if len(mac_key) < 32:
            raise ConfigError("Placement-context subject_secret must be at least 32 bytes")
        allowed = tuple(dict.fromkeys(item.strip() for item in audiences if item.strip()))
        if not allowed:
            raise ConfigError("Placement-bound auth context requires at least one audience")
        default_audience = allowed[0] if audience is None else audience
        if default_audience not in allowed:
            raise ConfigError("Default placement-context audience must be in the allowlist")
        ttl_seconds = _require_int("ttl_seconds", ttl_seconds, 1, MAX_TTL_SECONDS)
        clock_skew_seconds = _require_int("clock_skew_seconds", clock_skew_seconds, 0, 60)
        if keyring is not None:
            _validate_keyring(keyring)
        self._config = config
        self._mac_key = mac_key
        self._audiences = allowed
        self._default_audience = default_audience
        self._public_authority = _normalize_authority(public_authority)
        self._directory = placement_directory
        self._identity_key_for_user_id = identity_key_for_user_id
        self._keyring = keyring
        self._ttl_seconds = ttl_seconds
        self._clock_skew_seconds = clock_skew_seconds
        self._include_user_id = include_user_id
        self._clock = clock
        self._on_event = on_event
        self._verifier = (
            PlacementContextVerifier(
                audiences=allowed,
                public_authority=self._public_authority,
                keyring=keyring,
                audience=default_audience,
                clock_skew_seconds=clock_skew_seconds,
                clock=clock,
                config=config,
                on_event=on_event,
            )
            if keyring is not None
            else None
        )

    async def derive(self, request: Any, *, audience: Optional[str] = None) -> PlacementBoundAuthContext:
        request_id = resolve_request_id(request)
        sanitized = _strip_routing_headers(request)
        for key in [name for name in list(sanitized.headers) if name.lower() == "x-request-id"]:
            del sanitized.headers[key]
        sanitized.headers["x-request-id"] = request_id
        try:
            resolved_audience = _require_audience(
                self._default_audience if audience is None else audience,
                self._audiences,
            )
            principal = await _resolve_principal(self._config, sanitized, self._clock)
            identity_key = self._identity_key_for_user_id(principal["user_id"])
            if inspect.isawaitable(identity_key):
                identity_key = await identity_key
            placement = await _load_active_placement(self._directory, str(identity_key))
            if placement.region_id != self._region_id:
                raise PlacementMovingError(
                    "Session validation region does not own the current placement",
                    {"executionStarted": False},
                )
            issued_at = self._clock()
            expires_at = issued_at + self._ttl_seconds
            session_expiry = principal.get("session_expires_at")
            if isinstance(session_expiry, datetime):
                expires_at = min(expires_at, _coerce_utc(session_expiry).timestamp())
            if expires_at <= issued_at:
                raise SessionExpiredError(SESSION_EXPIRED)
            authenticated_at = principal["authenticated_at"]
            context = PlacementBoundAuthContext(
                subject=_hmac_opaque(self._mac_key, "subject", principal["user_id"]),
                home_region=placement.region_id,
                placement_epoch=placement.epoch,
                issuer=self._public_authority,
                session_binding=_hmac_opaque(self._mac_key, "session", principal["session_id"]),
                session_version=_hmac_opaque(
                    self._mac_key,
                    "session-version",
                    principal["session_version_material"],
                ),
                authenticated_at=_isoformat(authenticated_at),
                issued_at=_isoformat(datetime.fromtimestamp(issued_at, tz=timezone.utc)),
                expires_at=_isoformat(datetime.fromtimestamp(expires_at, tz=timezone.utc)),
                audience=resolved_audience,
                assurance=tuple(principal["methods"]),
                scopes=tuple(principal["scopes"]) if principal.get("scopes") is not None else None,
                request_id=request_id,
                actor_type=principal["actor_type"],
                user_id=principal["user_id"] if self._include_user_id else None,
            )
            await self._emit(
                {
                    "type": "authfn.placement_context.issued",
                    "requestId": request_id,
                    "regionId": context.home_region,
                    "outcome": "success",
                    "actorId": _telemetry_hash(context.subject),
                    "metadata": {
                        "epoch": context.placement_epoch,
                        "audience": context.audience,
                        "actorType": context.actor_type,
                        "subjectDigest": _telemetry_hash(context.subject),
                    },
                }
            )
            return context
        except Exception as error:
            await self._emit(
                {
                    "type": "authfn.placement_context.rejected",
                    "requestId": request_id,
                    "outcome": "rejected",
                    "metadata": {"errorType": getattr(error, "code", "AUTHFN_INTERNAL_ERROR")},
                }
            )
            raise

    async def with_context(
        self,
        request: Any,
        consumer: Callable[[PlacementBoundAuthContext], Any],
        *,
        audience: Optional[str] = None,
    ) -> Any:
        context = await self.derive(request, audience=audience)
        result = consumer(context)
        if isinstance(result, Awaitable):
            return await result
        return result

    async def issue_signed(
        self,
        request: Any,
        *,
        audience: Optional[str] = None,
    ) -> Dict[str, Any]:
        if self._keyring is None:
            raise ConfigError("Signed placement context requires a keyring")
        context = await self.derive(request, audience=audience)
        payload = _payload_from_context(context, self._keyring)
        return {"context": context, "assertion": _sign(payload, self._keyring)}

    def verify_signed(self, assertion: str, *, audience: Optional[str] = None) -> PlacementBoundAuthContext:
        if self._verifier is None:
            raise ConfigError("Placement-context verification requires a keyring")
        return self._verifier.verify_signed(assertion, audience=audience)

    async def _emit(self, event: Dict[str, Any]) -> None:
        self._notify(event)
        await emit_auth_event(self._config, event)

    def _notify(self, event: Dict[str, Any]) -> None:
        if self._on_event is None:
            return
        try:
            self._on_event(event)
        except Exception:  # noqa: BLE001
            return


def create_placement_context_issuer(**kwargs: Any) -> PlacementContextIssuer:
    return PlacementContextIssuer(**kwargs)


class PlacementContextVerifier:
    """Verification-only consumer. HMAC holders are trusted co-issuers."""

    def __init__(
        self,
        *,
        audiences: Sequence[str],
        public_authority: str,
        keyring: RoutingKeyring,
        audience: Optional[str] = None,
        clock_skew_seconds: int = 5,
        clock: Callable[[], float] = time.time,
        config: Optional[AuthFnConfig] = None,
        on_event: Optional[Callable[[Dict[str, Any]], Any]] = None,
    ) -> None:
        allowed = tuple(dict.fromkeys(item.strip() for item in audiences if item.strip()))
        if not allowed:
            raise ConfigError("Placement-bound auth context requires at least one audience")
        default_audience = allowed[0] if audience is None else audience
        if default_audience not in allowed:
            raise ConfigError("Default placement-context audience must be in the allowlist")
        self._audiences = allowed
        self._default_audience = default_audience
        self._public_authority = _normalize_authority(public_authority)
        self._keyring = keyring
        _validate_keyring(keyring)
        self._clock_skew_seconds = _require_int("clock_skew_seconds", clock_skew_seconds, 0, 60)
        self._clock = clock
        self._config = config
        self._on_event = on_event

    def verify_signed(self, assertion: str, *, audience: Optional[str] = None) -> PlacementBoundAuthContext:
        requested_audience = self._default_audience if audience is None else audience
        verified_request_id: Optional[str] = None
        try:
            payload = _verify(assertion, self._keyring, self._clock, self._clock_skew_seconds)
            request_id = payload.get("requestId")
            if isinstance(request_id, str):
                verified_request_id = request_id
            resolved_audience = _require_audience(requested_audience, self._audiences)
            if payload.get("audience") != resolved_audience:
                raise PlacementContextInvalidError("Placement-bound auth context audience is invalid")
            if payload.get("issuer") != self._public_authority:
                raise PlacementContextInvalidError("Placement-bound auth context issuer is invalid")
            context = _context_from_payload(payload)
            self._emit_sync(
                {
                    "type": "authfn.placement_context.verified",
                    "requestId": context.request_id,
                    "regionId": context.home_region,
                    "outcome": "success",
                    "metadata": {
                        "epoch": context.placement_epoch,
                        "audience": context.audience,
                        "subjectDigest": _telemetry_hash(context.subject),
                    },
                }
            )
            return context
        except Exception as error:
            self._emit_sync(
                {
                    "type": "authfn.placement_context.verification_failed",
                    "requestId": verified_request_id or _request_id(None),
                    "outcome": "rejected",
                    "metadata": {
                        "errorType": getattr(error, "code", "AUTHFN_PLACEMENT_CONTEXT_INVALID"),
                        "audience": requested_audience,
                    },
                }
            )
            if isinstance(error, PlacementContextInvalidError):
                raise
            raise PlacementContextInvalidError() from error

    def _emit_sync(self, event: Dict[str, Any]) -> None:
        if self._on_event is not None:
            try:
                self._on_event(event)
            except Exception:  # noqa: BLE001
                pass
        if self._config is None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(emit_auth_event(self._config, event))
            return
        loop.create_task(emit_auth_event(self._config, event))


def create_placement_context_verifier(**kwargs: Any) -> PlacementContextVerifier:
    return PlacementContextVerifier(**kwargs)


async def _resolve_principal(
    config: AuthFnConfig,
    request: Any,
    clock: Callable[[], float],
) -> Dict[str, Any]:
    state = await get_cookie_session_state(config, request, touch=False)
    cookie_principal = await _cookie_principal_for_clock(config, state, clock)
    if cookie_principal is not None:
        return cookie_principal
    credential = _authorization_credential(request)
    if credential:
        scheme, secret = credential
        if scheme == "bearer":
            bearer_session = await _resolve_bearer_session(config, secret, clock)
            if bearer_session is not None:
                return bearer_session
        api_key_principal = await _resolve_api_key_principal(config, secret, clock)
        if api_key_principal is not None:
            return api_key_principal
    if state.session_token:
        return _fail_closed_cookie_state(state, clock)
    raise UnauthorizedError(AUTH_REQUIRED)


async def _cookie_principal_for_clock(
    config: AuthFnConfig,
    state: Any,
    clock: Callable[[], float],
) -> Optional[Dict[str, Any]]:
    record = state.session_record
    if record is None or record.get("revokedAt") is not None:
        return None
    if _credential_expired(record.get("expiresAt"), clock):
        return None
    if state.session is not None and state.user is not None:
        return _principal_from_cookie_state(state)
    user = state.user
    if user is None:
        user = await config.database.find_one(
            model="users",
            where=[{"field": "id", "operator": "eq", "value": record["userId"]}],
            namespace=config.namespace,
        )
    if user is None:
        return None
    return {
        "user_id": user["id"],
        "actor_type": "user",
        "session_id": record["id"],
        "session_version_material": _credential_version_material(record),
        "methods": list(record.get("methods") or ["password"]),
        "authenticated_at": record.get("lastAuthenticatedAt") or record.get("createdAt"),
        "session_expires_at": record.get("expiresAt"),
    }


def _fail_closed_cookie_state(state: Any, clock: Callable[[], float]) -> Dict[str, Any]:
    if state.failure_reason == "revoked" or (state.session_record and state.session_record.get("revokedAt")):
        raise SessionRevokedError(SESSION_REVOKED)
    if _credential_expired((state.session_record or {}).get("expiresAt"), clock) or state.failure_reason == "expired":
        raise SessionExpiredError(SESSION_EXPIRED)
    return _principal_from_cookie_state(state)


def _credential_expired(expires_at: Any, clock: Callable[[], float]) -> bool:
    if isinstance(expires_at, datetime):
        return _coerce_utc(expires_at).timestamp() <= clock()
    return False


def _principal_from_cookie_state(state: Any) -> Dict[str, Any]:
    if state.failure_reason == "revoked":
        raise SessionRevokedError(SESSION_REVOKED)
    if state.failure_reason == "expired":
        raise SessionExpiredError(SESSION_EXPIRED)
    if state.session is None or state.session_record is None or state.user is None:
        raise UnauthorizedError(AUTH_REQUIRED)
    record = state.session_record
    user = state.user
    return {
        "user_id": user["id"],
        "actor_type": "user",
        "session_id": record["id"],
        "session_version_material": _credential_version_material(record),
        "methods": list(state.session.methods),
        "authenticated_at": record.get("lastAuthenticatedAt") or record.get("createdAt"),
        "session_expires_at": record.get("expiresAt"),
    }


async def _resolve_api_key_principal(
    config: AuthFnConfig,
    secret: str,
    clock: Callable[[], float],
) -> Optional[Dict[str, Any]]:
    # Same keyed lookup AuthFn uses for API keys (not password storage).
    secret_hash = _hash_secret(secret)  # codeql[py/weak-sensitive-data-hashing]
    row = await config.database.find_one(
        model="api_keys",
        where=[{"field": "secretHash", "operator": "eq", "value": secret_hash}],
        namespace=config.namespace,
    )
    if row is None:
        return None
    if row.get("revokedAt") is not None:
        raise ApiKeyRevokedError("API key has been revoked")
    if _credential_expired(row.get("expiresAt"), clock):
        raise ExpiredCredentialsError("API key has expired")
    user_id = row.get("userId")
    if not user_id:
        raise UnauthorizedError(AUTH_REQUIRED)
    user = await config.database.find_one(
        model="users",
        where=[{"field": "id", "operator": "eq", "value": user_id}],
        namespace=config.namespace,
    )
    if user is None:
        raise UnauthorizedError(AUTH_REQUIRED)
    raw_scopes = row.get("scopes")
    scopes = (
        [scope for scope in raw_scopes if isinstance(scope, str)]
        if isinstance(raw_scopes, list)
        else None
    )
    return {
        "user_id": user["id"],
        "actor_type": "api-key",
        "session_id": row["id"],
        "session_version_material": _credential_version_material(row),
        "methods": ["api-key"],
        "scopes": scopes,
        "authenticated_at": row.get("lastUsedAt") or row.get("createdAt"),
        "session_expires_at": row.get("expiresAt"),
    }


async def _resolve_bearer_session(
    config: AuthFnConfig,
    session_token: str,
    clock: Callable[[], float],
) -> Optional[Dict[str, Any]]:
    record = await config.database.find_one(
        model="sessions",
        where=[{
            "field": "tokenHash",
            "operator": "eq",
            "value": _hash_secret(session_token),  # codeql[py/weak-sensitive-data-hashing]
        }],
        namespace=config.namespace,
    )
    if record is None:
        return None
    if record.get("revokedAt") is not None:
        raise SessionRevokedError(SESSION_REVOKED)
    if _credential_expired(record.get("expiresAt"), clock):
        raise SessionExpiredError(SESSION_EXPIRED)
    user = await config.database.find_one(
        model="users",
        where=[{"field": "id", "operator": "eq", "value": record["userId"]}],
        namespace=config.namespace,
    )
    if user is None:
        raise UnauthorizedError(AUTH_REQUIRED)
    methods = record.get("methods") or []
    return {
        "user_id": user["id"],
        "actor_type": "user",
        "session_id": record["id"],
        "session_version_material": _credential_version_material(record),
        "methods": [str(item) for item in methods] if isinstance(methods, list) else ["password"],
        "authenticated_at": record.get("lastAuthenticatedAt") or record.get("createdAt"),
        "session_expires_at": record.get("expiresAt"),
    }


async def _load_active_placement(
    directory: IdentityPlacementDirectory,
    identity_key: str,
) -> IdentityPlacement:
    try:
        placement = await directory.get(identity_key)
    except Exception as error:  # noqa: BLE001
        raise PlacementDirectoryUnavailableError() from error
    if placement is None or placement.state == "tombstoned":
        raise RegionNotFoundError("Identity placement is not active")
    if placement.state in {"moving", "deleting"}:
        raise PlacementMovingError("Identity placement is moving", {"executionStarted": False})
    if placement.state != "active":
        raise RegionNotFoundError("Identity placement is not active")
    if (placement.identity_key != identity_key or not isinstance(placement.region_id, str)
            or not placement.region_id.strip()
            or type(placement.epoch) is not int or placement.epoch < 1):
        raise PlacementDirectoryUnavailableError("Invalid authoritative placement record")
    region_id = placement.region_id.strip()
    return placement if region_id == placement.region_id else replace(placement, region_id=region_id)


def _payload_from_context(context: PlacementBoundAuthContext, keyring: RoutingKeyring) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "kind": CONTEXT_KIND,
        "keyId": keyring.active.key_id,
        "subject": context.subject,
        "homeRegion": context.home_region,
        "placementEpoch": context.placement_epoch,
        "issuer": context.issuer,
        "sessionBinding": context.session_binding,
        "sessionVersion": context.session_version,
        "authenticatedAt": _unix(context.authenticated_at),
        "issuedAt": _unix(context.issued_at),
        "expiresAt": _unix(context.expires_at),
        "audience": context.audience,
        "assurance": list(context.assurance),
        "requestId": context.request_id,
        "actorType": context.actor_type,
        "nonce": secrets.token_urlsafe(16),
    }
    if context.scopes is not None:
        payload["scopes"] = list(context.scopes)
    if context.user_id:
        payload["userId"] = context.user_id
    return payload


def _context_from_payload(payload: Dict[str, Any]) -> PlacementBoundAuthContext:
    scopes = payload.get("scopes")
    return PlacementBoundAuthContext(
        subject=str(payload["subject"]),
        home_region=str(payload["homeRegion"]),
        placement_epoch=int(payload["placementEpoch"]),
        issuer=str(payload["issuer"]),
        session_binding=str(payload["sessionBinding"]),
        session_version=str(payload["sessionVersion"]),
        authenticated_at=_isoformat(datetime.fromtimestamp(int(payload["authenticatedAt"]), tz=timezone.utc)),
        issued_at=_isoformat(datetime.fromtimestamp(int(payload["issuedAt"]), tz=timezone.utc)),
        expires_at=_isoformat(datetime.fromtimestamp(int(payload["expiresAt"]), tz=timezone.utc)),
        audience=str(payload["audience"]),
        assurance=tuple(str(item) for item in payload.get("assurance") or ()),
        scopes=tuple(str(item) for item in scopes) if isinstance(scopes, list) else None,
        request_id=str(payload["requestId"]),
        actor_type=str(payload["actorType"]),
        user_id=str(payload["userId"]) if payload.get("userId") else None,
    )


def _sign(payload: Dict[str, Any], keyring: RoutingKeyring) -> str:
    encoded = _b64(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = _b64(hmac.new(_secret_bytes(keyring.active.secret), encoded.encode("ascii"), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def _verify(
    token: str,
    keyring: RoutingKeyring,
    clock: Callable[[], float],
    clock_skew_seconds: int,
) -> Dict[str, Any]:
    parts = token.split(".")
    if len(parts) != 2:
        raise PlacementContextInvalidError()
    encoded, signature = parts
    try:
        parsed: Any = json.loads(_unb64(encoded).decode("utf-8"))
    except Exception as error:  # noqa: BLE001
        raise PlacementContextInvalidError() from error
    if not _is_signed_payload(parsed):
        raise PlacementContextInvalidError()
    payload = cast(Dict[str, Any], parsed)
    key = next(
        (entry for entry in [keyring.active, *keyring.previous] if entry.key_id == payload.get("keyId")),
        None,
    )
    if key is None:
        raise PlacementContextInvalidError("Placement-bound auth context key is unknown")
    expected = hmac.new(_secret_bytes(key.secret), encoded.encode("ascii"), hashlib.sha256).digest()
    if not hmac.compare_digest(_unb64(signature), expected):
        raise PlacementContextInvalidError()
    now = int(clock())
    if int(payload["issuedAt"]) > now + clock_skew_seconds or int(payload["expiresAt"]) < now - clock_skew_seconds:
        raise PlacementContextInvalidError("Placement-bound auth context is expired")
    return payload


def _is_signed_payload(value: Any) -> TypeGuard[Dict[str, Any]]:
    if not isinstance(value, dict):
        return False
    required = (
        value.get("kind") == CONTEXT_KIND
        and isinstance(value.get("keyId"), str)
        and isinstance(value.get("subject"), str)
        and isinstance(value.get("homeRegion"), str)
        and isinstance(value.get("placementEpoch"), int)
        and int(value["placementEpoch"]) >= 1
        and isinstance(value.get("issuer"), str)
        and isinstance(value.get("sessionBinding"), str)
        and isinstance(value.get("sessionVersion"), str)
        and isinstance(value.get("authenticatedAt"), int)
        and isinstance(value.get("issuedAt"), int)
        and isinstance(value.get("expiresAt"), int)
        and int(value["expiresAt"]) >= int(value["issuedAt"])
        and int(value["expiresAt"]) - int(value["issuedAt"]) <= MAX_TTL_SECONDS
        and isinstance(value.get("audience"), str)
        and isinstance(value.get("assurance"), list)
        and all(isinstance(item, str) for item in value["assurance"])
        and isinstance(value.get("requestId"), str)
        and value.get("actorType") in {"user", "api-key"}
        and isinstance(value.get("nonce"), str)
        and len(str(value.get("nonce"))) >= 16
    )
    if not required:
        return False
    scopes = value.get("scopes")
    if scopes is not None and (
        not isinstance(scopes, list) or any(not isinstance(item, str) for item in scopes)
    ):
        return False
    user_id = value.get("userId")
    if user_id is not None and not isinstance(user_id, str):
        return False
    return True


class _HeaderSanitizedRequest:
    __slots__ = ("_original", "headers", "method", "url")

    def __init__(self, original: Any, headers: Dict[str, str]) -> None:
        object.__setattr__(self, "_original", original)
        object.__setattr__(self, "headers", headers)
        object.__setattr__(self, "method", getattr(original, "method", "GET"))
        object.__setattr__(self, "url", getattr(original, "url", ""))

    def __getattr__(self, name: str) -> Any:
        return getattr(self._original, name)


def _strip_routing_headers(request: Any) -> Any:
    headers = {
        key: value
        for key, value in getattr(request, "headers", {}).items()
        if not key.lower().startswith(INTERNAL_HEADER_PREFIX)
    }
    return _HeaderSanitizedRequest(request, headers)


def _authorization_credential(request: Any) -> Optional[Tuple[str, str]]:
    headers = getattr(request, "headers", {}) or {}
    authorization = next((value for key, value in headers.items() if key.lower() == "authorization"), None)
    if not authorization:
        return None
    trimmed = authorization.strip()
    lowered = trimmed.lower()
    if lowered.startswith("bearer "):
        secret = trimmed[7:].strip()
        return ("bearer", secret) if secret else None
    if lowered.startswith("api-key "):
        secret = trimmed[8:].strip()
        return ("api-key", secret) if secret else None
    return None


def _require_audience(audience: str, allowlist: Sequence[str]) -> str:
    if audience not in allowlist:
        raise ValidationError("Placement-bound auth context audience is not allowed")
    return audience


def _require_int(name: str, value: Any, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"Placement-context {name} must be an integer")
    if not minimum <= value <= maximum:
        if name == "ttl_seconds":
            raise ConfigError(f"Placement-context ttl_seconds must be between 1 and {MAX_TTL_SECONDS}")
        raise ConfigError(f"Placement-context {name} must be between {minimum} and {maximum}")
    return value


def _credential_version_material(record: Dict[str, Any]) -> str:
    created_at = record.get("createdAt") or record.get("updatedAt")
    return f"{record['id']}:{_isoformat(created_at)}"


def _hmac_opaque(mac_key: bytes, label: str, value: str) -> str:
    # Keyed MAC over identifiers (user/session ids), not password storage.
    material = f"{label}:{value}".encode("utf-8")
    return _b64(hmac.digest(mac_key, material, "sha256"))  # codeql[py/weak-sensitive-data-hashing]


def _telemetry_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def _secret_bytes(secret: bytes | str) -> bytes:
    return secret.encode("utf-8") if isinstance(secret, str) else bytes(secret)


def _percent_decode_hostname(hostname: str) -> str:
    try:
        return unquote(hostname, encoding="utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ConfigError(INVALID_AUTHORITY) from error


def _has_forbidden_domain_code_point(hostname: str) -> bool:
    return any(
        ord(char) <= 0x1F
        or char in {" ", "#", "/", ":", "<", ">", "?", "@", "[", "\\", "]", "^", "|", "%", "\x7f"}
        for char in hostname
    )


def _canonical_bracketed_ipv6(hostport: str) -> str:
    end = hostport.find("]")
    if end < 2:
        raise ConfigError(INVALID_AUTHORITY)
    raw = hostport[1:end]
    if "%" in raw:
        raise ConfigError(INVALID_AUTHORITY)
    try:
        return f"[{_serialize_ipv6(ipaddress.IPv6Address(raw))}]"
    except ipaddress.AddressValueError as error:
        raise ConfigError(INVALID_AUTHORITY) from error


def _canonical_hostname(hostname: str) -> str:
    hostname = _percent_decode_hostname(hostname)
    if _has_forbidden_domain_code_point(hostname):
        raise ConfigError(INVALID_AUTHORITY)
    try:
        mapped = idna.uts46_remap(hostname, std3_rules=False, transitional=False)
    except idna.IDNAError as error:
        raise ConfigError(INVALID_AUTHORITY) from error
    ascii_host = ".".join(_ascii_domain_label(label) for label in mapped.split("."))
    if not _ends_in_ipv4_number(ascii_host):
        return ascii_host
    ipv4 = _parse_ipv4_hostname(ascii_host)
    if ipv4 is None:
        raise ConfigError(INVALID_AUTHORITY)
    return ipv4


def _ascii_domain_label(label: str) -> str:
    if not label:
        return ""
    try:
        return idna.encode(label, uts46=False, transitional=False).decode("ascii")
    except idna.IDNAError as error:
        if _has_forbidden_domain_code_point(label):
            raise ConfigError(INVALID_AUTHORITY) from error
        # WHATWG domain-to-ASCII: UseSTD3ASCIIRules=false, CheckHyphens=false,
        # VerifyDnsLength=false, CheckJoiners=true, CheckBidi=true.
        # Keep ASCII labels. Unicode encode failures still punycode after
        # joiner/BiDi checks, including CONTEXTO and symbol labels Node accepts.
        if label.isascii():
            _reject_malformed_ace_label(label)
            return label
        try:
            _enforce_idna_after_hyphen_or_length_exception(label)
            return "xn--" + label.encode("punycode").decode("ascii")
        except ConfigError:
            raise
        except (idna.IDNAError, UnicodeError) as remaining:
            raise ConfigError(INVALID_AUTHORITY) from remaining


def _reject_malformed_ace_label(label: str) -> None:
    # ACE labels still Punycode-decode under WHATWG domain-to-ASCII. Keep
    # underscore hosts, but fail closed when xn-- suffix decode or the
    # resulting Unicode would be rejected by Node URL.origin.
    if not label.startswith("xn--"):
        return
    try:
        decoded = label[4:].encode("ascii").decode("punycode")
    except UnicodeError as error:
        raise ConfigError(INVALID_AUTHORITY) from error
    if not decoded:
        raise ConfigError(INVALID_AUTHORITY)
    try:
        mapped = idna.uts46_remap(decoded, std3_rules=False, transitional=False)
    except idna.IDNAError as error:
        raise ConfigError(INVALID_AUTHORITY) from error
    if _has_forbidden_domain_code_point(mapped):
        raise ConfigError(INVALID_AUTHORITY)
    _enforce_idna_after_hyphen_or_length_exception(mapped)


def _enforce_idna_after_hyphen_or_length_exception(label: str) -> None:
    # WHATWG keeps CheckJoiners and CheckBidi even when CheckHyphens and
    # VerifyDnsLength are false. idna.encode reports the hyphen first, so
    # re-run the remaining checks before the raw-punycode fallback.
    idna.check_nfc(label)
    # Node/ICU accepts these Arabic marks at the start of a WHATWG host even
    # though Python's general-category based IDNA check rejects them. Keep this
    # compatibility exception narrow; NFC, joiner and BiDi checks still apply.
    if not label or not 0x0898 <= ord(label[0]) <= 0x089F:
        idna.check_initial_combiner(label)
    classes = idnadata.codepoint_classes
    for pos, char in enumerate(label):
        code = ord(char)
        if idna.intranges_contain(code, classes["PVALID"]):
            continue
        if idna.intranges_contain(code, classes["CONTEXTJ"]):
            try:
                if not idna.valid_contextj(label, pos):
                    raise ConfigError(INVALID_AUTHORITY)
            except ValueError as error:
                raise ConfigError(INVALID_AUTHORITY) from error
            continue
        # WHATWG domain-to-ASCII does not enable CONTEXTO, so mapped middle-dot
        # and similar labels still punycode like Node URL.origin.
    if _rtl_hyphen_exception_is_invalid(label):
        raise ConfigError(INVALID_AUTHORITY)


def _rtl_hyphen_exception_is_invalid(label: str) -> bool:
    if not label:
        return False
    directions = [unicodedata.bidirectional(char) for char in label]
    has_rtl = any(direction in {"R", "AL", "AN"} for direction in directions)
    if not has_rtl:
        return False
    # ICU rejects an initial combining mark when the label also contains RTL
    # characters, including marks allowed by the narrow WHATWG exception above.
    if directions[0] == "NSM":
        return True
    has_ltr = any(direction == "L" for direction in directions)
    has_an = any(direction == "AN" for direction in directions)
    has_en = any(direction == "EN" for direction in directions)
    last = next((direction for direction in reversed(directions) if direction != "NSM"), "")
    # RTL labels must end in R/AL/EN/AN (RFC 5893), ignoring trailing NSM so
    # -א plus sheva matches Node. Trailing neutrals such as -א! still fail.
    if last not in {"R", "AL", "EN", "AN"}:
        return True
    if has_ltr:
        # Node URL.origin allows one trailing R/AL/AN on an LTR-leading label,
        # including L+EN+AN (https://a1١.example -> https://xn--a1-cyd.example)
        # and still rejects EN-then-L-then-RTL (1aא), two AN digits (a١١),
        # and AN-then-EN (a١1). EN is not an RTL class, so the mix check
        # below must not run on this LTR-leading path.
        rtl_count = sum(1 for direction in directions if direction in {"R", "AL", "AN"})
        first = next((direction for direction in directions if direction != "NSM"), "")
        return rtl_count != 1 or last not in {"R", "AL", "AN"} or first != "L"
    # AN and EN must not both appear on RTL-only labels (e.g. -١۲, 1١).
    return has_an and has_en


def _serialize_ipv6(address: ipaddress.IPv6Address) -> str:
    # WHATWG URL.origin / RFC 5952 hex compression. Do not use str(IPv6Address):
    # Python 3.11 emits dotted IPv4 for ::ffff-mapped addresses.
    pieces = [int.from_bytes(address.packed[index : index + 2], "big") for index in range(0, 16, 2)]
    best_start = -1
    best_length = 1
    index = 0
    while index < 8:
        if pieces[index] != 0:
            index += 1
            continue
        end = index
        while end < 8 and pieces[end] == 0:
            end += 1
        length = end - index
        if length > best_length:
            best_start = index
            best_length = length
        index = end
    if best_length < 2:
        return ":".join(format(piece, "x") for piece in pieces)
    head = ":".join(format(piece, "x") for piece in pieces[:best_start])
    tail = ":".join(format(piece, "x") for piece in pieces[best_start + best_length :])
    return f"{head}::{tail}"


def _ends_in_ipv4_number(hostname: str) -> bool:
    parts = hostname.split(".")
    if parts and parts[-1] == "":
        if len(parts) == 1:
            return False
        parts.pop()
    return bool(parts) and (
        _parse_ipv4_number(parts[-1]) is not None
        or (parts[-1].isascii() and parts[-1].isdigit())
    )


def _parse_ipv4_hostname(hostname: str) -> Optional[str]:
    parts = hostname.split(".")
    if parts and parts[-1] == "" and len(parts) > 1:
        parts.pop()
    if not 1 <= len(parts) <= 4:
        return None
    numbers: List[int] = []
    for part in parts:
        parsed = _parse_ipv4_number(part)
        if parsed is None:
            return None
        numbers.append(parsed)
    if any(number > 255 for number in numbers[:-1]):
        return None
    if numbers[-1] >= 256 ** (5 - len(numbers)):
        return None
    ipv4 = numbers[-1]
    for index, number in enumerate(numbers[:-1]):
        ipv4 += number * (256 ** (3 - index))
    return ".".join(str((ipv4 >> shift) & 255) for shift in (24, 16, 8, 0))


def _parse_ipv4_number(part: str) -> Optional[int]:
    if not part:
        return None
    radix = 10
    digits = part
    if len(part) >= 2 and part[0] == "0" and part[1] in {"x", "X"}:
        radix = 16
        digits = part[2:]
    elif len(part) >= 2 and part[0] == "0":
        radix = 8
        digits = part[1:]
    if not digits:
        return 0 if radix == 16 else None
    allowed = {
        8: set("01234567"),
        10: set("0123456789"),
        16: set("0123456789abcdefABCDEF"),
    }[radix]
    if any(char not in allowed for char in digits):
        return None
    try:
        return int(digits, radix)
    except ValueError:
        return None


_WHATWG_SPECIAL_SCHEMES = {"http", "https", "ftp", "ws", "wss"}
_SPECIAL_SCHEME_DEFAULT_PORTS = {
    "http": 80,
    "https": 443,
    "ftp": 21,
    "ws": 80,
    "wss": 443,
}


def _whatwg_special_scheme_authority(authority: str) -> str:
    scheme, separator, rest = authority.partition(":")
    if not separator or scheme.lower() not in _WHATWG_SPECIAL_SCHEMES:
        return authority
    # WHATWG special-scheme: backslash is a path separator, and one or more
    # leading slashes enter the authority state. `https:host` and `https:/host`
    # therefore match TypeScript `new URL(authority).origin`.
    rest = rest.replace("\\", "/").lstrip("/")
    return f"{scheme}://{rest}"


def _strip_whatwg_url_input(authority: str) -> str:
    start = 0
    end = len(authority)
    while start < end and ord(authority[start]) <= 0x20:
        start += 1
    while end > start and ord(authority[end - 1]) <= 0x20:
        end -= 1
    return authority[start:end]


def _normalize_authority(authority: str) -> str:
    authority = _whatwg_special_scheme_authority(_strip_whatwg_url_input(authority))
    try:
        parsed = urlparse(authority)
        port = parsed.port
    except ValueError as error:
        raise ConfigError(INVALID_AUTHORITY) from error
    if not parsed.scheme or not parsed.hostname:
        raise ConfigError(INVALID_AUTHORITY)
    scheme = parsed.scheme.lower()
    if scheme not in _SPECIAL_SCHEME_DEFAULT_PORTS:
        raise ConfigError(INVALID_AUTHORITY)
    hostport = parsed.netloc.rsplit("@", 1)[-1]
    if hostport.startswith("["):
        hostname = _canonical_bracketed_ipv6(hostport)
    else:
        hostname = _canonical_hostname(parsed.hostname)
    if port is None or _SPECIAL_SCHEME_DEFAULT_PORTS[scheme] == port:
        return f"{scheme}://{hostname}"
    return f"{scheme}://{hostname}:{port}"


def _validate_keyring(keyring: RoutingKeyring) -> None:
    keys: List[RoutingSigningKey] = [keyring.active, *keyring.previous]
    ids: set[str] = set()
    for key in keys:
        secret = _secret_bytes(key.secret)
        if not key.key_id.strip() or len(secret) < 32:
            raise ConfigError("AuthFn routing keys require a keyId and at least 32 bytes of secret material")
        if key.key_id in ids:
            raise ConfigError("AuthFn routing key IDs must be unique")
        ids.add(key.key_id)


def _request_id(request: Any) -> str:
    headers = getattr(request, "headers", {}) or {}
    return next(
        (value for key, value in headers.items() if key.lower() == "x-request-id"),
        f"req_{secrets.token_hex(8)}",
    )


def _isoformat(value: Any) -> str:
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise UnauthorizedError(AUTH_REQUIRED) from error
    if isinstance(value, datetime):
        aware: datetime = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        utc = aware.astimezone(timezone.utc)
        return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond:06d}"[:3] + "Z"
    raise UnauthorizedError(AUTH_REQUIRED)


def _unix(value: str) -> int:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return int(parsed.timestamp())


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(value + padding)


# Re-export for consumers that import the Python error from types.
__all__ = [
    "PlacementBoundAuthContext",
    "PlacementContextInvalidError",
    "PlacementContextIssuer",
    "PlacementContextVerifier",
    "create_placement_context_issuer",
    "create_placement_context_verifier",
]
