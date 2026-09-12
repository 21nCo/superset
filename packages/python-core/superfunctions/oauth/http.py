"""Shared OAuth HTTP contracts and structured errors."""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Protocol

from pydantic import BaseModel, Field

from .core import OAuthCoreErrorCode, OAuthProviderDescriptor

OAuthTokenGrantType = Literal["authorization_code", "refresh_token", "client_credentials"]
OAuthTokenAuthMethod = Literal["client_secret_post", "client_secret_basic"]
OAuthHttpErrorCode = Literal[
    OAuthCoreErrorCode,
    "OAUTH_TOKEN_EXCHANGE_FAILED",
    "OAUTH_TOKEN_REFRESH_FAILED",
    "PROVIDER_RATE_LIMITED",
    "VALIDATION_ERROR",
    "INTERNAL_ERROR",
    "OAUTH_RUNTIME_CONFIG_INVALID",
    "OAUTH_SECRET_RESOLUTION_FAILED",
]


class OAuthResolvedClientSecret(BaseModel):
    """Resolved runtime client secret plus optional auth method override."""

    client_secret: str = Field(alias="clientSecret")
    token_auth_method: Optional[OAuthTokenAuthMethod] = Field(None, alias="tokenAuthMethod")

    class Config:
        populate_by_name = True


class OAuthSecretResolverContext(BaseModel):
    """Runtime context passed to dynamic client-secret resolvers."""

    provider: OAuthProviderDescriptor
    operation: Literal["exchange", "revoke"]
    client_id: str = Field(alias="clientId")
    grant_type: Optional[OAuthTokenGrantType] = Field(None, alias="grantType")
    redirect_uri: Optional[str] = Field(None, alias="redirectUri")
    scopes: Optional[List[str]] = None
    token_type_hint: Optional[Literal["access_token", "refresh_token"]] = Field(
        None, alias="tokenTypeHint"
    )

    class Config:
        populate_by_name = True


class OAuthClientSecretResolver(Protocol):
    """Protocol for runtime secret resolution."""

    async def __call__(
        self, input: OAuthSecretResolverContext
    ) -> OAuthResolvedClientSecret:
        pass


class OAuthTokenEndpointRequest(BaseModel):
    """Token endpoint exchange request."""

    provider: OAuthProviderDescriptor
    grant_type: OAuthTokenGrantType = Field(alias="grantType")
    client_id: str = Field(alias="clientId")
    client_secret: Optional[str] = Field(None, alias="clientSecret")
    client_secret_resolver: Any = Field(None, alias="clientSecretResolver")
    redirect_uri: Optional[str] = Field(None, alias="redirectUri")
    code: Optional[str] = None
    code_verifier: Optional[str] = Field(None, alias="codeVerifier")
    refresh_token: Optional[str] = Field(None, alias="refreshToken")
    scopes: Optional[List[str]] = None

    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True


class OAuthTokenEndpointResponse(BaseModel):
    """Normalized OAuth token endpoint response."""

    access_token: str = Field(alias="accessToken")
    refresh_token: Optional[str] = Field(None, alias="refreshToken")
    expires_in: Optional[int] = Field(None, alias="expiresIn")
    token_type: Optional[str] = Field(None, alias="tokenType")
    scope: Optional[str] = None
    id_token: Optional[str] = Field(None, alias="idToken")
    raw: Optional[Any] = None

    class Config:
        populate_by_name = True


class OAuthRevocationRequest(BaseModel):
    """Remote token revocation request."""

    provider: OAuthProviderDescriptor
    client_id: str = Field(alias="clientId")
    client_secret: Optional[str] = Field(None, alias="clientSecret")
    client_secret_resolver: Any = Field(None, alias="clientSecretResolver")
    token: str
    token_type_hint: Optional[Literal["access_token", "refresh_token"]] = Field(
        None, alias="tokenTypeHint"
    )

    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True


class OAuthTokenHttpClient(Protocol):
    """Protocol used by shared flows to exchange and revoke tokens."""

    async def exchange_token(
        self, input: OAuthTokenEndpointRequest
    ) -> OAuthTokenEndpointResponse:
        pass

    async def revoke_token(self, input: OAuthRevocationRequest) -> None:
        pass


class OAuthHttpError(Exception):
    """Structured OAuth HTTP error."""

    def __init__(
        self,
        message: str,
        *,
        code: OAuthHttpErrorCode,
        status: Optional[int] = None,
        retryable: bool = False,
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message)
        self.name = "OAuthHttpError"
        self.code = code
        self.status = status
        self.retryable = retryable
        self.details = details


def unsupported_token_auth_method_error(token_auth_method: str) -> OAuthHttpError:
    """Return a structured error for unsupported token auth methods."""

    return OAuthHttpError(
        "unsupported token auth method",
        code="VALIDATION_ERROR",
        status=400,
        details={"tokenAuthMethod": token_auth_method},
    )


def invalid_runtime_config_error(
    message: str, details: Optional[Dict[str, Any]] = None
) -> OAuthHttpError:
    """Return a structured runtime config error."""

    return OAuthHttpError(
        message,
        code="OAUTH_RUNTIME_CONFIG_INVALID",
        status=500,
        details=details,
    )


def secret_resolution_failed_error(
    context: OAuthSecretResolverContext,
    cause: Optional[BaseException] = None,
    message: str = "failed to resolve OAuth client secret",
) -> OAuthHttpError:
    """Return a structured secret-resolution error without leaking secret values."""

    return OAuthHttpError(
        message,
        code="OAUTH_SECRET_RESOLUTION_FAILED",
        status=500,
        details={
            "providerId": context.provider.id,
            "operation": context.operation,
            "grantType": context.grant_type,
            "hasResolver": True,
            "causeType": type(cause).__name__ if cause is not None else None,
        },
    )


def normalize_oauth_error_body(raw_body: Any) -> Dict[str, Any]:
    """Normalize arbitrary provider error payloads into a message-first shape."""

    if not isinstance(raw_body, dict):
        return {"message": "OAuth provider request failed"}

    description = (
        _as_non_empty_string(raw_body.get("error_description"))
        or _as_non_empty_string(raw_body.get("message"))
        or _as_non_empty_string(raw_body.get("error"))
        or _as_non_empty_string(raw_body.get("detail"))
        or "OAuth provider request failed"
    )

    return {"message": description, "details": raw_body}


def _as_non_empty_string(value: Any) -> Optional[str]:
    return value if isinstance(value, str) and value else None


__all__ = [
    "OAuthClientSecretResolver",
    "OAuthHttpError",
    "OAuthHttpErrorCode",
    "OAuthResolvedClientSecret",
    "OAuthRevocationRequest",
    "OAuthSecretResolverContext",
    "OAuthTokenAuthMethod",
    "OAuthTokenEndpointRequest",
    "OAuthTokenEndpointResponse",
    "OAuthTokenGrantType",
    "OAuthTokenHttpClient",
    "invalid_runtime_config_error",
    "normalize_oauth_error_body",
    "secret_resolution_failed_error",
    "unsupported_token_auth_method_error",
]
