"""Shared OAuth flow contracts for Python consumers."""

from __future__ import annotations

import base64
import hashlib
import inspect
import json
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Literal, Optional, Protocol
from urllib.parse import urlencode

from pydantic import BaseModel, Field, field_validator, model_validator

from .core import (
    AuthorizationResult,
    OAuthCoreError,
    OAuthProviderDescriptor,
    OAuthProviderRuntimeConfig,
    OAuthTokenSet,
    assert_callback_state_matches,
    assert_redirect_uri_allowed,
    consume_state_or_throw,
)
from .http import OAuthHttpError, OAuthHttpErrorCode, OAuthTokenEndpointRequest
from .storage import (
    OAuthStateRecord,
    TokenRecord,
    apply_subject_to_state_record,
    resolve_oauth_stored_subject,
)

DEFAULT_STATE_TTL_SECONDS = 600

OAuthFlowErrorCode = Literal[
    "OAUTH_HOOK_FAILED",
    "NOT_IMPLEMENTED",
    "OAUTH_STATE_INVALID",
    "OAUTH_STATE_REPLAYED",
    "OAUTH_CALLBACK_MISMATCH",
    "OAUTH_REDIRECT_DISALLOWED",
    "OAUTH_PROVIDER_UNSUPPORTED",
    "OAUTH_RUNTIME_CONFIG_INVALID",
    "OAUTH_SECRET_RESOLUTION_FAILED",
    "OAUTH_TOKEN_REFRESH_FAILED",
    "OAUTH_TOKEN_EXCHANGE_FAILED",
    "VALIDATION_ERROR",
    "INTERNAL_ERROR",
    "PROVIDER_RATE_LIMITED",
]
OAuthFlowEventName = Literal[
    "oauth.flow.started",
    "oauth.flow.start.failed",
    "oauth.flow.callback.success",
    "oauth.flow.callback.failed",
    "oauth.flow.refresh.success",
    "oauth.flow.refresh.failed",
    "oauth.flow.disconnect.success",
    "oauth.flow.disconnect.failed",
]


class OAuthFlowSubject(BaseModel):
    """Canonical subject shape returned by shared OAuth flows."""

    kind: Literal["connection", "browser-auth", "browser"]
    tenant_id: Optional[str] = Field(None, alias="tenantId")
    user_id: Optional[str] = Field(None, alias="userId")
    connection_id: Optional[str] = Field(None, alias="connectionId")
    intent_id: Optional[str] = Field(None, alias="intentId")
    region_id: Optional[str] = Field(None, alias="regionId")
    return_to: Optional[str] = Field(None, alias="returnTo")
    metadata: Optional[Dict[str, Any]] = None

    class Config:
        populate_by_name = True


class OAuthFlowResolvedIdentity(BaseModel):
    """Identity resolution result for browser-auth flows."""

    tenant_id: str = Field(alias="tenantId")
    user_id: str = Field(alias="userId")
    connection_id: Optional[str] = Field(None, alias="connectionId")
    metadata: Optional[Dict[str, Any]] = None
    persist_tokens: Optional[bool] = Field(None, alias="persistTokens")

    class Config:
        populate_by_name = True


class OAuthFlowStartInput(BaseModel):
    """Flow start input with either a canonical subject or connection identifiers."""

    provider_id: str = Field(alias="providerId")
    redirect_uri: Optional[str] = Field(None, alias="redirectUri")
    scopes: Optional[List[str]] = None
    prompt: Optional[str] = None
    login_hint: Optional[str] = Field(None, alias="loginHint")
    metadata: Optional[Dict[str, Any]] = None
    request_id: Optional[str] = Field(None, alias="requestId")
    subject: Optional[OAuthFlowSubject] = None
    tenant_id: Optional[str] = Field(None, alias="tenantId")
    user_id: Optional[str] = Field(None, alias="userId")
    connection_id: Optional[str] = Field(None, alias="connectionId")

    class Config:
        populate_by_name = True

    @field_validator("subject", mode="before")
    @classmethod
    def normalize_subject_model(cls, value: Any) -> Any:
        if isinstance(value, BaseModel):
            return value.model_dump(by_alias=True)
        return value

    @model_validator(mode="after")
    def validate_subject_fields(self) -> "OAuthFlowStartInput":
        if self.subject is None and not (self.tenant_id and self.user_id):
            raise ValueError("subject or tenantId/userId is required")
        if self.subject is None:
            return self

        if self.subject.kind in ("browser-auth", "browser") and not self.subject.intent_id:
            raise ValueError("browser subjects require intentId")

        if self.subject.kind == "connection" and not (
            self.subject.tenant_id and self.subject.user_id
        ):
            raise ValueError("connection subjects require tenantId and userId")

        return self


class OAuthFlowCallbackInput(BaseModel):
    """Flow callback input."""

    provider_id: Optional[str] = Field(None, alias="providerId")
    code: str
    state: str
    redirect_uri: Optional[str] = Field(None, alias="redirectUri")
    request_id: Optional[str] = Field(None, alias="requestId")

    class Config:
        populate_by_name = True


class OAuthFlowRefreshInput(BaseModel):
    """Token refresh input."""

    connection_id: str = Field(alias="connectionId")
    provider_id: str = Field(alias="providerId")
    redirect_uri: str = Field(alias="redirectUri")
    scopes: Optional[List[str]] = None
    request_id: Optional[str] = Field(None, alias="requestId")

    class Config:
        populate_by_name = True


class OAuthFlowDisconnectInput(BaseModel):
    """Disconnect input for local and optional remote revocation."""

    connection_id: str = Field(alias="connectionId")
    provider_id: str = Field(alias="providerId")
    revoke_remote: Optional[bool] = Field(None, alias="revokeRemote")
    token_type_hint: Optional[Literal["access_token", "refresh_token"]] = Field(
        None, alias="tokenTypeHint"
    )
    request_id: Optional[str] = Field(None, alias="requestId")

    class Config:
        populate_by_name = True


class OAuthFlowStartResult(AuthorizationResult):
    """Flow start result with explicit provider echo."""

    provider_id: str = Field(alias="providerId")

    class Config:
        populate_by_name = True


class OAuthFlowCallbackResult(BaseModel):
    """Canonical callback result for browser-auth and connection flows."""

    provider_id: str = Field(alias="providerId")
    subject: OAuthFlowSubject
    token_set: OAuthTokenSet = Field(alias="tokenSet")
    token_record_id: Optional[str] = Field(None, alias="tokenRecordId")
    connection_id: Optional[str] = Field(None, alias="connectionId")
    resolved_identity: Optional[OAuthFlowResolvedIdentity] = Field(
        None, alias="resolvedIdentity"
    )

    class Config:
        populate_by_name = True


class OAuthFlowDisconnectResult(BaseModel):
    """Disconnect operation result."""

    disconnected: bool
    remote_revoke_attempted: bool = Field(alias="remoteRevokeAttempted")
    local_token_deleted: bool = Field(alias="localTokenDeleted")
    connection_deleted: bool = Field(alias="connectionDeleted")

    class Config:
        populate_by_name = True


class OAuthFlowResolveBrowserAuthIdentityInput(BaseModel):
    """Input passed to identity-resolution hooks."""

    provider_id: str = Field(alias="providerId")
    subject: OAuthFlowSubject
    state: OAuthStateRecord
    token_set: OAuthTokenSet = Field(alias="tokenSet")

    class Config:
        populate_by_name = True


class OAuthFlowEvent(BaseModel):
    """Redaction-safe structured OAuth flow event."""

    name: OAuthFlowEventName
    request_id: str = Field(alias="requestId")
    provider_id: str = Field(alias="providerId")
    at: Optional[str] = None
    ok: bool
    subject_kind: Optional[Literal["connection", "browser-auth", "browser"]] = Field(
        None, alias="subjectKind"
    )
    connection_id: Optional[str] = Field(None, alias="connectionId")
    error_code: Optional[OAuthFlowErrorCode] = Field(None, alias="errorCode")
    details: Optional[Dict[str, Any]] = None

    class Config:
        populate_by_name = True


class OAuthFlowResolveBrowserAuthIdentityHook(Protocol):
    """Identity hook protocol."""

    async def __call__(
        self, input: OAuthFlowResolveBrowserAuthIdentityInput
    ) -> Optional[OAuthFlowResolvedIdentity]:
        pass


class OAuthFlowOnConnectedHook(Protocol):
    """Post-connect hook protocol."""

    async def __call__(self, result: OAuthFlowCallbackResult) -> None:
        pass


class OAuthFlowOnDisconnectedHook(Protocol):
    """Post-disconnect hook protocol."""

    async def __call__(self, input: OAuthFlowDisconnectInput) -> None:
        pass


class OAuthFlowIdentityHooks(BaseModel):
    """Optional hook collection for shared OAuth flows."""

    resolve_browser_auth_identity: Optional[Any] = Field(
        None, alias="resolveBrowserAuthIdentity"
    )
    on_connected: Optional[Any] = Field(None, alias="onConnected")
    on_disconnected: Optional[Any] = Field(
        None, alias="onDisconnected"
    )

    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True


class OAuthFlowServiceConfig(BaseModel):
    """Configuration contract for shared OAuth flow services."""

    providers: Dict[str, OAuthProviderDescriptor]
    provider_runtime_config: Dict[str, OAuthProviderRuntimeConfig] = Field(
        alias="providerRuntimeConfig"
    )
    state_store: Any = Field(alias="stateStore")
    token_vault: Any = Field(alias="tokenVault")
    token_http_client: Optional[Any] = Field(
        None, alias="tokenHttpClient"
    )
    identity_hooks: Optional[OAuthFlowIdentityHooks] = Field(None, alias="identityHooks")
    key_ref: Optional[str] = Field(None, alias="keyRef")
    state_ttl_seconds: int = Field(DEFAULT_STATE_TTL_SECONDS, alias="stateTtlSeconds")
    now: Optional[Callable[[], Any]] = None
    emit_event: Optional[Callable[[OAuthFlowEvent], None]] = Field(None, alias="emitEvent")

    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True


class OAuthFlowService(Protocol):
    """Shared flow service protocol."""

    async def start(self, input: OAuthFlowStartInput) -> OAuthFlowStartResult:
        pass

    async def handle_callback(
        self, input: OAuthFlowCallbackInput
    ) -> OAuthFlowCallbackResult:
        pass

    async def refresh(self, input: OAuthFlowRefreshInput) -> OAuthTokenSet:
        pass

    async def disconnect(
        self, input: OAuthFlowDisconnectInput
    ) -> OAuthFlowDisconnectResult:
        pass


class OAuthFlowError(Exception):
    """Structured shared OAuth flow error."""

    def __init__(
        self,
        code: OAuthFlowErrorCode,
        message: str,
        *,
        status: int = 400,
        retryable: bool = False,
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message)
        self.name = "OAuthFlowError"
        self.code = code
        self.status = status
        self.retryable = retryable
        self.details = details


def hook_failed_error(
    message: str = "identity hook failed", details: Optional[Dict[str, Any]] = None
) -> OAuthFlowError:
    """Return the shared structured hook failure error."""

    return OAuthFlowError(
        "OAUTH_HOOK_FAILED",
        message,
        status=500,
        details=details,
    )


def create_oauth_flow_service(config: OAuthFlowServiceConfig | Dict[str, Any]) -> OAuthFlowService:
    """Create the shared default OAuth flow service."""

    resolved = config if isinstance(config, OAuthFlowServiceConfig) else OAuthFlowServiceConfig.model_validate(config)
    return DefaultOAuthFlowService(resolved)


class DefaultOAuthFlowService:
    """Default shared OAuth flow implementation."""

    def __init__(self, config: OAuthFlowServiceConfig):
        self.config = config

    async def start(self, input: OAuthFlowStartInput | Dict[str, Any]) -> OAuthFlowStartResult:
        payload = input if isinstance(input, OAuthFlowStartInput) else OAuthFlowStartInput.model_validate(input)
        provider = self._require_provider(payload.provider_id)
        runtime = self._require_runtime_config(payload.provider_id)
        scopes = list(payload.scopes or provider.default_scopes)
        subject = self._resolve_subject(payload)
        now = self._now()
        if not payload.redirect_uri:
            error = OAuthHttpError(
                "redirectUri is required",
                code="VALIDATION_ERROR",
                status=400,
                details={"redirectUri": payload.redirect_uri},
            )
            await self._emit_event(
                {
                    "name": "oauth.flow.start.failed",
                    "requestId": payload.request_id or _create_request_id(),
                    "providerId": payload.provider_id,
                    "ok": False,
                    "subjectKind": subject.kind,
                    "errorCode": error.code,
                    "details": error.details,
                }
            )
            raise error

        try:
            assert_redirect_uri_allowed(payload.redirect_uri, runtime.allowlisted_redirect_uris or [])
        except Exception as error:  # noqa: BLE001
            details = getattr(error, "details", None)
            code: OAuthHttpErrorCode = error.code if isinstance(error, (OAuthCoreError, OAuthHttpError)) else "VALIDATION_ERROR"
            if code == "OAUTH_REDIRECT_DISALLOWED":
                details = {"redirectUri": payload.redirect_uri}
            await self._emit_event(
                {
                    "name": "oauth.flow.start.failed",
                    "requestId": payload.request_id or _create_request_id(),
                    "providerId": payload.provider_id,
                    "ok": False,
                    "subjectKind": subject.kind,
                    "errorCode": code,
                    "details": details,
                }
            )
            raise OAuthHttpError(
                str(error),
                code=code,
                status=getattr(error, "status", 400),
                retryable=getattr(error, "retryable", False),
                details=details,
            ) from error
        expires_at = now + timedelta(seconds=self.config.state_ttl_seconds)
        code_verifier = secrets.token_urlsafe(64) if provider.supports_pkce else None
        record = apply_subject_to_state_record(
            OAuthStateRecord.model_validate(
                {
                    "stateId": _create_identifier("state"),
                    "providerId": payload.provider_id,
                    "redirectUri": payload.redirect_uri,
                    "requestedScopes": scopes,
                    "subject": subject.model_dump(by_alias=True),
                    "metadata": payload.metadata,
                    "codeVerifier": code_verifier,
                    "createdAt": _isoformat(now),
                    "expiresAt": _isoformat(expires_at),
                }
            )
        )
        await self.config.state_store.put(record)

        result = OAuthFlowStartResult.model_validate(
            {
                "providerId": payload.provider_id,
                "authorizationUrl": self._build_authorization_url(provider, runtime, payload, record, scopes),
                "stateId": record.state_id,
                "expiresAt": record.expires_at,
            }
        )
        await self._emit_event(
            {
                "name": "oauth.flow.started",
                "requestId": payload.request_id or _create_request_id(),
                "providerId": payload.provider_id,
                "at": _isoformat(now),
                "ok": True,
                "subjectKind": subject.kind,
                "connectionId": getattr(subject, "connection_id", None),
            }
        )
        return result

    async def handle_callback(
        self, input: OAuthFlowCallbackInput | Dict[str, Any]
    ) -> OAuthFlowCallbackResult:
        payload = input if isinstance(input, OAuthFlowCallbackInput) else OAuthFlowCallbackInput.model_validate(input)
        now = self._now()

        try:
            consumed = await consume_state_or_throw(
                self.config.state_store,
                payload.state,
                _isoformat(now),
            )
            provider_id = payload.provider_id or consumed.provider_id
            provider = self._require_provider(provider_id)
            runtime = self._require_runtime_config(provider_id)
            redirect_uri = payload.redirect_uri or consumed.redirect_uri
            assert_callback_state_matches(
                {"providerId": provider_id, "redirectUri": redirect_uri},
                consumed,
            )
            token_response = await self._exchange_token(provider, runtime, consumed, payload, redirect_uri)
            token_set = _token_set_from_response(token_response, now)
            subject = OAuthFlowSubject.model_validate(
                resolve_oauth_stored_subject(consumed).model_dump(by_alias=True)
            )

            resolved_identity: Optional[OAuthFlowResolvedIdentity] = None
            token_record_id: Optional[str] = None
            connection_id: Optional[str] = subject.connection_id

            if subject.kind in ("browser-auth", "browser"):
                resolved_identity = await self._resolve_browser_auth_identity(
                    provider_id, subject, consumed, token_set
                )
                if resolved_identity is not None:
                    connection_id = (
                        resolved_identity.connection_id or connection_id or _create_identifier("conn")
                    )
                    if resolved_identity.persist_tokens is not False:
                        token_record_id = await self._persist_token_record(
                            tenant_id=resolved_identity.tenant_id,
                            user_id=resolved_identity.user_id,
                            provider_id=provider_id,
                            connection_id=connection_id,
                            token_set=token_set,
                            now=now,
                        )
            else:
                connection_id = connection_id or _create_identifier("conn")
                token_record_id = await self._persist_token_record(
                    tenant_id=subject.tenant_id or "",
                    user_id=subject.user_id or "",
                    provider_id=provider_id,
                    connection_id=connection_id,
                    token_set=token_set,
                    now=now,
                )

            result = OAuthFlowCallbackResult.model_validate(
                {
                    "providerId": provider_id,
                    "subject": subject,
                    "tokenSet": token_set,
                    "tokenRecordId": token_record_id,
                    "connectionId": connection_id,
                    "resolvedIdentity": resolved_identity,
                }
            )
            await self._run_on_connected(result)
            await self._emit_event(
                {
                    "name": "oauth.flow.callback.success",
                    "requestId": payload.request_id or _create_request_id(),
                    "providerId": provider_id,
                    "at": _isoformat(now),
                    "ok": True,
                    "subjectKind": subject.kind,
                    "connectionId": connection_id,
                }
            )
            return result
        except OAuthFlowError as error:
            await self._emit_event(
                {
                    "name": "oauth.flow.callback.failed",
                    "requestId": payload.request_id or _create_request_id(),
                    "providerId": payload.provider_id or "",
                    "at": _isoformat(now),
                    "ok": False,
                    "errorCode": error.code,
                    "details": error.details,
                }
            )
            raise
        except OAuthHttpError as error:
            wrapped = OAuthFlowError(
                error.code,
                str(error),
                status=error.status or 500,
                retryable=error.retryable,
                details=error.details,
            )
            await self._emit_event(
                {
                    "name": "oauth.flow.callback.failed",
                    "requestId": payload.request_id or _create_request_id(),
                    "providerId": payload.provider_id or "",
                    "at": _isoformat(now),
                    "ok": False,
                    "errorCode": wrapped.code,
                    "details": wrapped.details,
                }
            )
            raise wrapped from error
        except Exception as error:  # noqa: BLE001
            wrapped = OAuthFlowError(
                getattr(error, "code", "INTERNAL_ERROR"),
                str(error),
                status=getattr(error, "status", 500),
                retryable=getattr(error, "retryable", False),
                details=getattr(error, "details", None),
            )
            await self._emit_event(
                {
                    "name": "oauth.flow.callback.failed",
                    "requestId": payload.request_id or _create_request_id(),
                    "providerId": payload.provider_id or "",
                    "at": _isoformat(now),
                    "ok": False,
                    "errorCode": wrapped.code,
                    "details": wrapped.details,
                }
            )
            raise wrapped from error

    async def refresh(self, input: OAuthFlowRefreshInput | Dict[str, Any]) -> OAuthTokenSet:
        payload = input if isinstance(input, OAuthFlowRefreshInput) else OAuthFlowRefreshInput.model_validate(input)
        error = OAuthFlowError("NOT_IMPLEMENTED", "OAuth token refresh is not implemented")
        await self._emit_event(
            {
                "name": "oauth.flow.refresh.failed",
                "requestId": payload.request_id or _create_request_id(),
                "providerId": payload.provider_id,
                "at": _isoformat(self._now()),
                "ok": False,
                "connectionId": payload.connection_id,
                "errorCode": error.code,
                "details": error.details,
            }
        )
        raise error

    async def disconnect(
        self, input: OAuthFlowDisconnectInput | Dict[str, Any]
    ) -> OAuthFlowDisconnectResult:
        payload = input if isinstance(input, OAuthFlowDisconnectInput) else OAuthFlowDisconnectInput.model_validate(input)
        await self.config.token_vault.delete_by_connection(payload.connection_id)
        await self._run_on_disconnected(payload)
        result = OAuthFlowDisconnectResult.model_validate(
            {
                "disconnected": True,
                "remoteRevokeAttempted": False,
                "localTokenDeleted": True,
                "connectionDeleted": False,
            }
        )
        await self._emit_event(
            {
                "name": "oauth.flow.disconnect.success",
                "requestId": payload.request_id or _create_request_id(),
                "providerId": payload.provider_id,
                "at": _isoformat(self._now()),
                "ok": True,
                "connectionId": payload.connection_id,
            }
        )
        return result

    def _resolve_subject(self, input: OAuthFlowStartInput) -> OAuthFlowSubject:
        if input.subject is not None:
            return input.subject
        return OAuthFlowSubject.model_validate(
            {
                "kind": "connection",
                "tenantId": input.tenant_id,
                "userId": input.user_id,
                "connectionId": input.connection_id,
            }
        )

    def _require_provider(self, provider_id: str) -> OAuthProviderDescriptor:
        provider = self.config.providers.get(provider_id)
        if provider is None:
            raise OAuthFlowError("OAUTH_PROVIDER_UNSUPPORTED", "OAuth provider is not supported")
        return provider

    def _require_runtime_config(self, provider_id: str) -> OAuthProviderRuntimeConfig:
        runtime = self.config.provider_runtime_config.get(provider_id)
        if runtime is None:
            raise OAuthFlowError(
                "OAUTH_RUNTIME_CONFIG_INVALID",
                "OAuth runtime configuration is invalid",
                status=500,
            )
        return runtime

    def _build_authorization_url(
        self,
        provider: OAuthProviderDescriptor,
        runtime: OAuthProviderRuntimeConfig,
        input: OAuthFlowStartInput,
        record: OAuthStateRecord,
        scopes: List[str],
    ) -> str:
        params = {
            "response_type": "code",
            "client_id": runtime.client_id,
            "redirect_uri": input.redirect_uri,
            "state": record.state_id,
            "scope": (provider.scope_separator or " ").join(scopes),
        }
        if input.prompt:
            params["prompt"] = input.prompt
        if input.login_hint:
            params["login_hint"] = input.login_hint
        reserved_extra_params = {
            "state",
            "redirect_uri",
            "client_id",
            "response_type",
            "scope",
            "code_challenge",
            "code_challenge_method",
        }
        extra_auth_params = provider.extra_auth_params or {}
        overlapping_params = reserved_extra_params.intersection(extra_auth_params)
        if overlapping_params:
            raise OAuthFlowError(
                "VALIDATION_ERROR",
                "OAuth provider extra_auth_params cannot override reserved authorization fields",
                status=400,
                details={"reservedParams": sorted(overlapping_params)},
            )
        if provider.supports_pkce:
            if not record.code_verifier:
                raise OAuthFlowError(
                    "INTERNAL_ERROR",
                    "OAuth PKCE verifier was not generated",
                    status=500,
                )
            params["code_challenge"] = _pkce_s256_challenge(record.code_verifier)
            params["code_challenge_method"] = "S256"
        params.update(extra_auth_params)
        return f"{provider.authorization_url}?{urlencode(params)}"

    async def _exchange_token(
        self,
        provider: OAuthProviderDescriptor,
        runtime: OAuthProviderRuntimeConfig,
        state: OAuthStateRecord,
        input: OAuthFlowCallbackInput,
        redirect_uri: str,
    ) -> Any:
        client = self.config.token_http_client
        if client is None:
            raise OAuthFlowError(
                "OAUTH_RUNTIME_CONFIG_INVALID",
                "OAuth token client is not configured",
                status=500,
            )
        return await client.exchange_token(
            OAuthTokenEndpointRequest.model_validate(
                {
                    "provider": provider,
                    "grantType": "authorization_code",
                    "clientId": runtime.client_id,
                    "clientSecret": runtime.client_secret,
                    "clientSecretResolver": runtime.client_secret_resolver,
                    "redirectUri": redirect_uri,
                    "code": input.code,
                    "codeVerifier": state.code_verifier,
                    "scopes": state.requested_scopes,
                }
            )
        )

    async def _resolve_browser_auth_identity(
        self,
        provider_id: str,
        subject: OAuthFlowSubject,
        state: OAuthStateRecord,
        token_set: OAuthTokenSet,
    ) -> Optional[OAuthFlowResolvedIdentity]:
        hook = (
            self.config.identity_hooks.resolve_browser_auth_identity
            if self.config.identity_hooks is not None
            else None
        )
        if hook is None:
            return None
        try:
            result = hook(
                OAuthFlowResolveBrowserAuthIdentityInput.model_validate(
                    {
                        "providerId": provider_id,
                        "subject": subject,
                        "state": state,
                        "tokenSet": token_set,
                    }
                )
            )
            if inspect.isawaitable(result):
                result = await result
        except OAuthFlowError:
            raise
        except Exception as error:  # noqa: BLE001
            error_code = getattr(error, "code", None)
            if isinstance(error_code, str) and error_code.startswith("AUTHFN_"):
                raise
            raise hook_failed_error(details={"cause": str(error)}) from error
        if result is None or isinstance(result, OAuthFlowResolvedIdentity):
            return result
        return OAuthFlowResolvedIdentity.model_validate(result)

    async def _persist_token_record(
        self,
        *,
        tenant_id: str,
        user_id: str,
        provider_id: str,
        connection_id: str,
        token_set: OAuthTokenSet,
        now: datetime,
    ) -> str:
        record = TokenRecord.model_validate(
            {
                "tokenId": _create_identifier("tok"),
                "tenantId": tenant_id,
                "userId": user_id,
                "providerId": provider_id,
                "connectionId": connection_id,
                "encryptedPayload": json.dumps(token_set.model_dump(by_alias=True, exclude_none=True)),
                "keyRef": self.config.key_ref or "oauth-default",
                "createdAt": _isoformat(now),
                "updatedAt": _isoformat(now),
                "expiresAt": token_set.expires_at,
            }
        )
        await self.config.token_vault.put(record)
        return record.token_id

    async def _run_on_connected(self, result: OAuthFlowCallbackResult) -> None:
        hook = self.config.identity_hooks.on_connected if self.config.identity_hooks is not None else None
        if hook is None:
            return
        maybe = hook(result)
        if inspect.isawaitable(maybe):
            _ = await maybe

    async def _run_on_disconnected(self, input: OAuthFlowDisconnectInput) -> None:
        hook = self.config.identity_hooks.on_disconnected if self.config.identity_hooks is not None else None
        if hook is None:
            return
        maybe = hook(input)
        if inspect.isawaitable(maybe):
            _ = await maybe

    async def _emit_event(self, event: OAuthFlowEvent | Dict[str, Any]) -> None:
        emitter = self.config.emit_event
        if emitter is None:
            return
        if isinstance(event, OAuthFlowEvent):
            payload = event
        else:
            raw_event = dict(event)
            try:
                payload = OAuthFlowEvent.model_validate(raw_event)
            except Exception:
                error_code = raw_event.get("errorCode")
                details = dict(raw_event.get("details") or {})
                if error_code:
                    details.setdefault("originalErrorCode", error_code)
                raw_event["details"] = details or None
                raw_event["errorCode"] = "INTERNAL_ERROR"
                payload = OAuthFlowEvent.model_validate(raw_event)
        try:
            maybe = emitter(payload)
            if inspect.isawaitable(maybe):
                await maybe
        except Exception:  # noqa: BLE001
            return

    def _now(self) -> datetime:
        raw = self.config.now() if self.config.now is not None else datetime.now(timezone.utc)
        if isinstance(raw, datetime):
            return raw if raw.tzinfo is not None else raw.replace(tzinfo=timezone.utc)
        raise OAuthFlowError("INTERNAL_ERROR", "OAuth flow clock returned an invalid value", status=500)


def _token_set_from_response(response: Any, now: datetime) -> OAuthTokenSet:
    expires_at = None
    expires_in = getattr(response, "expires_in", None)
    if isinstance(expires_in, int):
        expires_at = _isoformat(now + timedelta(seconds=expires_in))
    return OAuthTokenSet.model_validate(
        {
            "accessToken": response.access_token,
            "refreshToken": getattr(response, "refresh_token", None),
            "expiresAt": expires_at,
            "scope": getattr(response, "scope", None),
            "tokenType": getattr(response, "token_type", None),
            "idToken": getattr(response, "id_token", None),
        }
    )


def _create_identifier(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(8)}"


def _create_request_id() -> str:
    return f"req_{secrets.token_hex(5)}"


def _isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _pkce_s256_challenge(code_verifier: str) -> str:
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


__all__ = [
    "DefaultOAuthFlowService",
    "OAuthFlowCallbackInput",
    "OAuthFlowCallbackResult",
    "OAuthFlowDisconnectInput",
    "OAuthFlowDisconnectResult",
    "OAuthFlowError",
    "OAuthFlowErrorCode",
    "OAuthFlowEvent",
    "OAuthFlowEventName",
    "OAuthFlowIdentityHooks",
    "OAuthFlowOnConnectedHook",
    "OAuthFlowOnDisconnectedHook",
    "OAuthFlowRefreshInput",
    "OAuthFlowResolveBrowserAuthIdentityHook",
    "OAuthFlowResolveBrowserAuthIdentityInput",
    "OAuthFlowResolvedIdentity",
    "OAuthFlowService",
    "OAuthFlowServiceConfig",
    "OAuthFlowStartInput",
    "OAuthFlowStartResult",
    "OAuthFlowSubject",
    "create_oauth_flow_service",
    "hook_failed_error",
]
