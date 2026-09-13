"""Shared OAuth core contracts and state helpers."""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field

from .storage import (
    OAuthBrowserAuthSubject,
    OAuthConnectionSubject,
    OAuthStateRecord,
    OAuthStateStore,
)

OAuthIntentSubject = Union[OAuthConnectionSubject, OAuthBrowserAuthSubject]
OAuthCoreErrorCode = Literal[
    "OAUTH_STATE_INVALID",
    "OAUTH_STATE_REPLAYED",
    "OAUTH_CALLBACK_MISMATCH",
    "OAUTH_REDIRECT_DISALLOWED",
    "OAUTH_PROVIDER_UNSUPPORTED",
    "OAUTH_RUNTIME_CONFIG_INVALID",
    "VALIDATION_ERROR",
    "OAUTH_TOKEN_REFRESH_FAILED",
]


class OAuthProviderDescriptor(BaseModel):
    """Provider metadata shared across OAuth packages."""

    id: str
    authorization_url: str = Field(alias="authorizationUrl")
    token_url: str = Field(alias="tokenUrl")
    revocation_url: Optional[str] = Field(None, alias="revocationUrl")
    default_scopes: List[str] = Field(alias="defaultScopes")
    supports_pkce: bool = Field(default=True, alias="supportsPkce")
    supports_refresh_token: bool = Field(default=False, alias="supportsRefreshToken")
    scope_separator: Optional[Literal[" ", ","]] = Field(None, alias="scopeSeparator")
    extra_auth_params: Optional[Dict[str, str]] = Field(None, alias="extraAuthParams")
    token_auth_method: Optional[Literal["client_secret_post", "client_secret_basic"]] = Field(
        None, alias="tokenAuthMethod"
    )

    class Config:
        populate_by_name = True


class AuthorizationRequestBase(BaseModel):
    """Common authorization request fields."""

    provider_id: str = Field(alias="providerId")
    redirect_uri: str = Field(alias="redirectUri")
    scopes: Optional[List[str]] = None
    connection_name: Optional[str] = Field(None, alias="connectionName")
    prompt: Optional[str] = None
    login_hint: Optional[str] = Field(None, alias="loginHint")

    class Config:
        populate_by_name = True


class AuthorizationRequest(AuthorizationRequestBase):
    """Typed authorization request including a canonical subject."""

    subject: Optional[OAuthIntentSubject] = None
    tenant_id: Optional[str] = Field(None, alias="tenantId")
    user_id: Optional[str] = Field(None, alias="userId")
    connection_id: Optional[str] = Field(None, alias="connectionId")

    class Config:
        populate_by_name = True


class AuthorizationResult(BaseModel):
    """Authorization URL generation result."""

    authorization_url: str = Field(alias="authorizationUrl")
    state_id: str = Field(alias="stateId")
    expires_at: str = Field(alias="expiresAt")

    class Config:
        populate_by_name = True


class OAuthCallbackInput(BaseModel):
    """Callback payload used to exchange an authorization code."""

    provider_id: str = Field(alias="providerId")
    code: str
    state: str
    redirect_uri: str = Field(alias="redirectUri")

    class Config:
        populate_by_name = True


class OAuthTokenSet(BaseModel):
    """Canonical token set returned by shared OAuth flows."""

    access_token: str = Field(alias="accessToken")
    refresh_token: Optional[str] = Field(None, alias="refreshToken")
    expires_at: Optional[str] = Field(None, alias="expiresAt")
    scope: Optional[str] = None
    token_type: Optional[str] = Field(None, alias="tokenType")
    id_token: Optional[str] = Field(None, alias="idToken")

    class Config:
        populate_by_name = True


class OAuthProviderRuntimeConfig(BaseModel):
    """Runtime OAuth configuration resolved per provider."""

    client_id: str = Field(alias="clientId")
    client_secret: Optional[str] = Field(None, alias="clientSecret")
    allowlisted_redirect_uris: Optional[List[str]] = Field(None, alias="allowlistedRedirectUris")
    client_secret_resolver: Any = Field(None, alias="clientSecretResolver")

    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True


class CallbackStateMatchInput(BaseModel):
    """Minimal callback payload used for redirect/provider state checks."""

    provider_id: str = Field(alias="providerId")
    redirect_uri: str = Field(alias="redirectUri")

    class Config:
        populate_by_name = True


class OAuthCoreError(Exception):
    """Structured shared OAuth core error."""

    def __init__(
        self,
        code: OAuthCoreErrorCode,
        message: str,
        *,
        status: int = 400,
        retryable: bool = False,
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message)
        self.name = "OAuthCoreError"
        self.code = code
        self.status = status
        self.retryable = retryable
        self.details = details


def assert_redirect_uri_allowed(
    redirect_uri: str, allowlisted_redirect_uris: List[str]
) -> None:
    """Raise when the redirect URI is not allowlisted."""

    if not allowlisted_redirect_uris:
        return
    if redirect_uri not in allowlisted_redirect_uris:
        raise OAuthCoreError("OAUTH_REDIRECT_DISALLOWED", "redirect URI not allowed")


def assert_callback_state_matches(
    input: Union[CallbackStateMatchInput, Dict[str, str]], state: OAuthStateRecord
) -> None:
    """Raise when callback provider or redirect mismatch the stored state."""

    resolved = (
        input
        if isinstance(input, CallbackStateMatchInput)
        else CallbackStateMatchInput.model_validate(input)
    )

    if resolved.provider_id != state.provider_id:
        raise OAuthCoreError(
            "OAUTH_CALLBACK_MISMATCH", "provider mismatch for OAuth callback"
        )

    if resolved.redirect_uri != state.redirect_uri:
        raise OAuthCoreError(
            "OAUTH_CALLBACK_MISMATCH", "redirect URI not allowed"
        )


async def consume_state_or_throw(
    state_store: OAuthStateStore, state_id: str, consumed_at: str
) -> OAuthStateRecord:
    """Consume a state record and raise shared errors for replay/expiry cases."""

    consumed = await state_store.consume(state_id, consumed_at)
    if consumed is not None:
        if consumed.expires_at <= consumed_at:
            raise OAuthCoreError(
                "OAUTH_STATE_INVALID", "OAuth state is invalid or expired"
            )
        return consumed

    existing = await state_store.get(state_id)
    if existing is not None and existing.consumed_at:
        raise OAuthCoreError("OAUTH_STATE_REPLAYED", "OAuth state already consumed")

    raise OAuthCoreError("OAUTH_STATE_INVALID", "OAuth state is invalid or expired")


__all__ = [
    "AuthorizationRequest",
    "AuthorizationRequestBase",
    "AuthorizationResult",
    "CallbackStateMatchInput",
    "OAuthCallbackInput",
    "OAuthCoreError",
    "OAuthCoreErrorCode",
    "OAuthIntentSubject",
    "OAuthProviderDescriptor",
    "OAuthProviderRuntimeConfig",
    "OAuthTokenSet",
    "assert_callback_state_matches",
    "assert_redirect_uri_allowed",
    "consume_state_or_throw",
]
