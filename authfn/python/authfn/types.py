"""Core type definitions for authfn Python SDK."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Literal, Optional, Protocol, TypedDict

from pydantic import BaseModel, Field
from superfunctions.auth import AuthSubject
from superfunctions.db import OrderBy as OrderByClause
from superfunctions.db import WhereClause


class AuthFnFieldSchema(TypedDict, total=False):
    """Serializable field schema used by AuthFn plugins."""

    type: str
    required: bool
    unique: bool
    fieldName: str


class AuthFnIndexSchema(TypedDict, total=False):
    """Serializable index schema used by AuthFn plugins."""

    name: str
    fields: List[str]
    unique: bool


class TableSchema(TypedDict, total=False):
    """Plain schema descriptor composed before an adapter is selected."""

    modelName: str
    fields: Dict[str, AuthFnFieldSchema]
    indexes: List[AuthFnIndexSchema]


class ApiKeySession(BaseModel):
    """API key session extends base auth session."""

    id: str
    type: str = "api-key"
    key_id: str = Field(alias="keyId")
    name: str
    resource_ids: List[str] = Field(alias="resourceIds")
    scopes: Optional[List[str]] = None
    expires_at: Optional[datetime] = Field(None, alias="expiresAt")
    metadata: Optional[Dict[str, Any]] = None

    class Config:
        populate_by_name = True


class ApiKey(BaseModel):
    """API key data stored in database."""

    id: str
    key: str
    name: str
    resource_ids: List[str] = Field(alias="resourceIds")
    scopes: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None
    expires_at: Optional[datetime] = Field(None, alias="expiresAt")
    last_used_at: Optional[datetime] = Field(None, alias="lastUsedAt")
    revoked_at: Optional[datetime] = Field(None, alias="revokedAt")
    created_at: datetime = Field(alias="createdAt")

    class Config:
        populate_by_name = True


class ApiKeyCreate(BaseModel):
    """Data for creating a new API key."""

    name: str
    resource_ids: List[str] = Field(alias="resourceIds")
    scopes: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None
    expires_at: Optional[datetime] = Field(None, alias="expiresAt")

    class Config:
        populate_by_name = True


class ApiKeyResponse(BaseModel):
    """Response when creating an API key."""

    id: str
    key: str


class ApiKeySanitized(BaseModel):
    """API key without the secret key field."""

    id: str
    name: str
    resource_ids: List[str] = Field(alias="resourceIds")
    scopes: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None
    expires_at: Optional[datetime] = Field(None, alias="expiresAt")
    last_used_at: Optional[datetime] = Field(None, alias="lastUsedAt")
    revoked_at: Optional[datetime] = Field(None, alias="revokedAt")
    created_at: datetime = Field(alias="createdAt")

    class Config:
        populate_by_name = True


class AuthFnCookieConfig(BaseModel):
    """Cookie policy configuration."""

    prefix: Optional[str] = None
    domain: Optional[str] = None
    secure: Optional[bool] = None
    same_site: Optional[Literal["lax", "strict", "none"]] = Field(None, alias="sameSite")
    path: Optional[str] = None
    session_max_age_seconds: Optional[int] = Field(None, alias="sessionMaxAgeSeconds")
    csrf_max_age_seconds: Optional[int] = Field(None, alias="csrfMaxAgeSeconds")

    class Config:
        populate_by_name = True


class AuthFnRuntimeResolution(BaseModel):
    """Resolved request-aware runtime information."""

    issuer: str
    base_url: str = Field(alias="baseUrl")
    region_id: Optional[str] = Field(None, alias="regionId")
    cookie: Optional[AuthFnCookieConfig] = None
    oauth: Optional[Dict[str, Dict[str, Any]]] = None

    class Config:
        populate_by_name = True

    @property
    def baseUrl(self) -> str:
        return self.base_url

    @property
    def regionId(self) -> Optional[str]:
        return self.region_id


class AuthFnSession(BaseModel):
    """Actor-centric auth session contract for the multi-package authfn platform."""

    id: str
    type: Literal["session", "api-key"]
    subject: Optional[AuthSubject] = None
    actor_type: Literal["user", "api-key"] = Field(alias="actorType")
    actor_id: str = Field(alias="actorId")
    tenant_id: Optional[str] = Field(None, alias="tenantId")
    region_id: Optional[str] = Field(None, alias="regionId")
    resource_ids: Optional[List[str]] = Field(None, alias="resourceIds")
    methods: List[
        Literal[
            "password",
            "email-otp",
            "oauth-google",
            "oauth-apple",
            "oauth-github",
            "api-key",
            "two-factor",
        ]
    ]
    primary_email: Optional[str] = Field(None, alias="primaryEmail")
    expires_at: Optional[datetime] = Field(None, alias="expiresAt")
    metadata: Optional[Dict[str, Any]] = None

    class Config:
        populate_by_name = True


class AuthFnEvent(BaseModel):
    """Structured authfn observability event."""

    type: str
    request_id: str = Field(alias="requestId")
    actor_id: Optional[str] = Field(None, alias="actorId")
    session_id: Optional[str] = Field(None, alias="sessionId")
    user_id: Optional[str] = Field(None, alias="userId")
    region_id: Optional[str] = Field(None, alias="regionId")
    provider: Optional[str] = None
    plugin_name: Optional[str] = Field(None, alias="pluginName")
    hook_name: Optional[str] = Field(None, alias="hookName")
    outcome: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None

    class Config:
        populate_by_name = True


class AuthFnObservabilityConfig(BaseModel):
    """Optional observability sink."""

    emit: Optional[Any] = None

    class Config:
        arbitrary_types_allowed = True


class AuthFnConfig(BaseModel):
    """Configuration for authfn."""

    database: Any
    namespace: str = "authfn"
    base_path: str = Field("/auth", alias="basePath")
    cookie: Optional[AuthFnCookieConfig] = None
    runtime: Optional[Any] = None
    hooks: Optional["AuthFnHooks"] = None
    plugins: List["AuthFnPlugin"] = Field(default_factory=list)
    open_api: Optional[Any] = Field(None, alias="openApi")
    enable_api: bool = Field(False, alias="enableApi")
    api_config: Optional[Dict[str, Any]] = Field(None, alias="apiConfig")
    observability: Optional[AuthFnObservabilityConfig] = None

    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True


class Request(Protocol):
    """Protocol for HTTP requests."""

    @property
    def headers(self) -> Dict[str, str]:
        """Request headers."""
        ...


class AuthFnRuntimeResolver(Protocol):
    """Protocol for request-aware runtime resolution."""

    def resolve(self, request: Request) -> AuthFnRuntimeResolution:
        ...


class AuthFnHookContext(BaseModel):
    """Hook execution context."""

    config: Optional["AuthFnConfig"] = None
    request: Optional[Any] = None
    runtime: Optional[AuthFnRuntimeResolution] = None
    plugin_name: Optional[str] = Field(None, alias="pluginName")
    session: Optional[AuthFnSession] = None
    actor_id: Optional[str] = Field(None, alias="actorId")

    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True


class AuthFnHooks(BaseModel):
    """Hook contract exposed by authfn plugins and configs."""

    before_user_create: Optional[Any] = Field(None, alias="beforeUserCreate")
    after_user_create: Optional[Any] = Field(None, alias="afterUserCreate")
    before_session_issue: Optional[Any] = Field(None, alias="beforeSessionIssue")
    after_session_issue: Optional[Any] = Field(None, alias="afterSessionIssue")
    before_challenge_send: Optional[Any] = Field(None, alias="beforeChallengeSend")
    after_challenge_send: Optional[Any] = Field(None, alias="afterChallengeSend")
    before_oauth_start: Optional[Any] = Field(None, alias="beforeOAuthStart")
    after_oauth_callback: Optional[Any] = Field(None, alias="afterOAuthCallback")

    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True


class AuthFnPluginRuntimeContext(BaseModel):
    """Plugin runtime context."""

    config: AuthFnConfig
    namespace: str
    base_path: str = Field(alias="basePath")
    hooks: Optional[AuthFnHooks] = None
    runtime_resolver: Optional[Any] = Field(None, alias="runtimeResolver")

    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True


@dataclass
class AuthFnPlugin:
    """Public plugin contract."""

    name: str
    schema_factory: Optional[Callable[[AuthFnConfig], List[TableSchema]]] = None
    routes_factory: Optional[Callable[[AuthFnPluginRuntimeContext], List[Dict[str, Any]]]] = None
    hooks: Optional[AuthFnHooks] = None
    validate_config: Optional[Callable[[AuthFnConfig], None]] = None
    _authfn_config: Any = field(default_factory=dict, init=False, repr=False, compare=False)

    def schema(self, config: AuthFnConfig) -> List[TableSchema]:
        return self.schema_factory(config) if self.schema_factory else []

    def routes(self, ctx: AuthFnPluginRuntimeContext) -> List[Dict[str, Any]]:
        return self.routes_factory(ctx) if self.routes_factory else []


class AuthProvider(Protocol):
    """Protocol for auth providers."""

    async def authenticate(self, request: Request) -> Optional[ApiKeySession]:
        ...

    async def authorize(self, session: ApiKeySession, resource_id: str) -> bool:
        ...

    async def revoke(self, session_id: str) -> None:
        ...


class AuthFnError(Exception):
    """Base exception for authfn."""

    code = "AUTHFN_ERROR"
    status = 500
    retryable = False

    def __init__(
        self,
        message: str = "AuthFn error",
        details: Optional[Dict[str, Any]] = None,
        *,
        status: Optional[int] = None,
        retryable: Optional[bool] = None,
    ):
        super().__init__(message)
        self.message = message
        self.details = details
        if status is not None:
            self.status = status
        if retryable is not None:
            self.retryable = retryable


class InvalidCredentialsError(AuthFnError):
    """Invalid credentials error."""

    code = "AUTHFN_INVALID_CREDENTIALS"
    status = 401


class ExpiredCredentialsError(AuthFnError):
    """Expired credentials error."""

    code = "AUTHFN_SESSION_EXPIRED"
    status = 401


class UnauthorizedError(AuthFnError):
    """Unauthorized error."""

    code = "AUTHFN_UNAUTHENTICATED"
    status = 401


class NotFoundError(AuthFnError):
    """Not found error."""

    code = "AUTHFN_NOT_FOUND"
    status = 404


class ConflictError(AuthFnError):
    """Conflict error."""

    code = "AUTHFN_CONFLICT"
    status = 409


class ConfigError(AuthFnError):
    """Invalid config error."""

    code = "AUTHFN_CONFIG_INVALID"
    status = 400


class InternalError(AuthFnError):
    """Internal authfn error."""

    code = "AUTHFN_INTERNAL_ERROR"
    status = 500
    retryable = True


class NotImplementedAuthError(AuthFnError):
    """Feature not implemented."""

    code = "AUTHFN_NOT_IMPLEMENTED"
    status = 501


class PluginAbortedError(AuthFnError):
    """Plugin hook abort."""

    code = "AUTHFN_PLUGIN_ABORTED"
    status = 500


class SessionExpiredError(ExpiredCredentialsError):
    """Expired session."""


class SessionRevokedError(AuthFnError):
    """Revoked session."""

    code = "AUTHFN_SESSION_REVOKED"
    status = 401


class CsrfInvalidError(AuthFnError):
    """Invalid CSRF token."""

    code = "AUTHFN_CSRF_INVALID"
    status = 403


class ValidationError(AuthFnError):
    """Validation error."""

    code = "AUTHFN_VALIDATION_ERROR"
    status = 400


class OtpInvalidError(AuthFnError):
    """Invalid OTP error."""

    code = "AUTHFN_OTP_INVALID"


class OtpExpiredError(AuthFnError):
    """Expired OTP error."""

    code = "AUTHFN_OTP_EXPIRED"


class OtpReplayedError(AuthFnError):
    """Replayed OTP error."""

    code = "AUTHFN_OTP_REPLAYED"


class DeliveryFailedError(AuthFnError):
    """Delivery failure error."""

    code = "AUTHFN_DELIVERY_FAILED"
    status = 503
    retryable = True


class EmailNotVerifiedError(AuthFnError):
    """Email verification is required before continuing."""

    code = "AUTHFN_EMAIL_NOT_VERIFIED"
    status = 403


class RateLimitedError(AuthFnError):
    """Request is temporarily rate limited."""

    code = "AUTHFN_RATE_LIMITED"
    status = 429
    retryable = True


class OAuthCallbackInvalidError(AuthFnError):
    """Invalid OAuth callback error."""

    code = "AUTHFN_OAUTH_CALLBACK_INVALID"
    status = 400


class OAuthProviderUnsupportedError(AuthFnError):
    """Unsupported OAuth provider error."""

    code = "AUTHFN_OAUTH_PROVIDER_UNSUPPORTED"
    status = 400


class OAuthStateInvalidError(AuthFnError):
    """Invalid OAuth state error."""

    code = "AUTHFN_OAUTH_STATE_INVALID"
    status = 400


class OAuthStateReplayedError(AuthFnError):
    """Replayed OAuth state error."""

    code = "AUTHFN_OAUTH_STATE_REPLAYED"
    status = 409


class RedirectUriDisallowedError(AuthFnError):
    """Disallowed redirect target error."""

    code = "AUTHFN_REDIRECT_URI_DISALLOWED"
    status = 400


class TwoFactorRequiredError(AuthFnError):
    """Second factor required before session completion."""

    code = "AUTHFN_2FA_REQUIRED"
    status = 401


class TwoFactorInvalidCodeError(AuthFnError):
    """Invalid TOTP or recovery code."""

    code = "AUTHFN_2FA_INVALID_CODE"
    status = 400


class ApiKeyRevokedError(AuthFnError):
    """Revoked API key error."""

    code = "AUTHFN_API_KEY_REVOKED"
    status = 401


class RegionMismatchError(AuthFnError):
    """Sign-in must continue on another region authority."""

    code = "AUTHFN_REGION_MISMATCH"
    status = 409


class RegionNotFoundError(AuthFnError):
    """No deterministic routing information was found."""

    code = "AUTHFN_REGION_NOT_FOUND"
    status = 404


class PlacementDirectoryUnavailableError(AuthFnError):
    """Canonical identity placement cannot be read or updated."""

    code = "AUTHFN_PLACEMENT_DIRECTORY_UNAVAILABLE"
    status = 503
    retryable = True

    def __init__(
        self,
        message: str = "Identity placement directory is unavailable",
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message, details)


class PlacementMovingError(AuthFnError):
    """Identity writes are fenced while ownership moves between cells."""

    code = "AUTHFN_PLACEMENT_MOVING"
    status = 503
    retryable = True

    def __init__(
        self,
        message: str = "Identity placement is moving",
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message, details)


class RoutingAssertionInvalidError(AuthFnError):
    """A regional cell rejected an untrusted or replayed gateway assertion."""

    code = "AUTHFN_ROUTING_ASSERTION_INVALID"
    status = 401

    def __init__(
        self,
        message: str = "Gateway routing assertion is invalid",
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message, details)


class RoutingCellUnavailableError(AuthFnError):
    """The selected regional cell cannot accept the routed request."""

    code = "AUTHFN_ROUTING_CELL_UNAVAILABLE"
    status = 503

    def __init__(
        self,
        message: str = "Regional AuthFn cell is unavailable",
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message, details)


class PlacementContextInvalidError(AuthFnError):
    """A signed placement-bound auth context failed verification."""

    code = "AUTHFN_PLACEMENT_CONTEXT_INVALID"
    status = 401

    def __init__(
        self,
        message: str = "Placement-bound auth context is invalid",
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message, details)


class AuthFnSchemaConflictError(AuthFnError):
    """Deterministic schema composition conflict."""

    code = "AUTHFN_CONFLICT"
    status = 409


def _build_plugin(
    name: str,
    tables: List[TableSchema],
    routes: List[Dict[str, Any]],
) -> AuthFnPlugin:
    return AuthFnPlugin(
        name=name,
        schema_factory=lambda _config: tables,
        routes_factory=lambda _ctx: routes,
    )


def authfn_password_plugin() -> AuthFnPlugin:
    plugin = _build_plugin(
        "password",
        [
            {
                "modelName": "password_credentials",
                "fields": {
                    "id": {"type": "string", "required": True, "fieldName": "id"},
                    "userId": {"type": "string", "required": True, "fieldName": "user_id"},
                    "passwordHash": {
                        "type": "string",
                        "required": True,
                        "fieldName": "password_hash",
                    },
                    "createdAt": {
                        "type": "date",
                        "required": True,
                        "fieldName": "created_at",
                    },
                    "updatedAt": {
                        "type": "date",
                        "required": True,
                        "fieldName": "updated_at",
                    },
                },
                "indexes": [
                    {
                        "name": "idx_authfn_password_credentials_user_id",
                        "fields": ["userId"],
                        "unique": True,
                    }
                ],
            }
        ],
        [
            {"method": "POST", "path": "/sign-up/password"},
            {"method": "POST", "path": "/sign-in/password"},
        ],
    )
    plugin._authfn_config = {}
    return plugin


def authfn_email_otp_plugin(config: Optional[Any] = None) -> AuthFnPlugin:
    from .plugins.email_otp import authfn_email_otp_plugin as plugin_factory

    return plugin_factory(config)


def authfn_social_oauth_plugin(config: Optional[Any] = None) -> AuthFnPlugin:
    from .plugins.social_oauth import authfn_social_oauth_plugin as plugin_factory

    return plugin_factory(config)


def authfn_api_key_plugin(config: Optional[Any] = None) -> AuthFnPlugin:
    from .plugins.api_keys import authfn_api_key_plugin as plugin_factory

    return plugin_factory(config)


def authfn_two_factor_plugin(config: Optional[Any] = None) -> AuthFnPlugin:
    from .plugins.two_factor import authfn_two_factor_plugin as plugin_factory

    return plugin_factory(config)


def authfn_multi_region_plugin(config: Optional[Any] = None) -> AuthFnPlugin:
    from .plugins.multi_region import authfn_multi_region_plugin as plugin_factory

    return plugin_factory(config)


__all__ = [
    "ApiKey",
    "ApiKeyCreate",
    "ApiKeyResponse",
    "ApiKeySanitized",
    "ApiKeySession",
    "AuthFnConfig",
    "AuthFnCookieConfig",
    "AuthFnError",
    "AuthFnHookContext",
    "AuthFnHooks",
    "AuthFnPlugin",
    "AuthFnPluginRuntimeContext",
    "AuthFnRuntimeResolution",
    "AuthFnRuntimeResolver",
    "AuthFnSchemaConflictError",
    "AuthFnSession",
    "AuthProvider",
    "ApiKeyRevokedError",
    "ConfigError",
    "ConflictError",
    "CsrfInvalidError",
    "DeliveryFailedError",
    "ExpiredCredentialsError",
    "InvalidCredentialsError",
    "InternalError",
    "NotFoundError",
    "NotImplementedAuthError",
    "OAuthCallbackInvalidError",
    "OAuthProviderUnsupportedError",
    "OAuthStateInvalidError",
    "OAuthStateReplayedError",
    "OrderByClause",
    "PluginAbortedError",
    "RedirectUriDisallowedError",
    "RegionMismatchError",
    "RegionNotFoundError",
    "PlacementDirectoryUnavailableError",
    "PlacementMovingError",
    "PlacementContextInvalidError",
    "RoutingAssertionInvalidError",
    "RoutingCellUnavailableError",
    "Request",
    "SessionExpiredError",
    "SessionRevokedError",
    "TwoFactorInvalidCodeError",
    "TwoFactorRequiredError",
    "UnauthorizedError",
    "ValidationError",
    "WhereClause",
    "authfn_api_key_plugin",
    "authfn_email_otp_plugin",
    "authfn_multi_region_plugin",
    "authfn_password_plugin",
    "authfn_social_oauth_plugin",
    "authfn_two_factor_plugin",
]
