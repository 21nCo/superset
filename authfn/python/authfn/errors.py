"""Canonical Python authfn error exports and conversion helpers."""

from __future__ import annotations

from typing import Any

from .types import (
    ApiKeyRevokedError,
    AuthFnError,
    AuthFnSchemaConflictError,
    ConfigError,
    ConflictError,
    CsrfInvalidError,
    DeliveryFailedError,
    EmailNotVerifiedError,
    ExpiredCredentialsError,
    InternalError,
    InvalidCredentialsError,
    NotFoundError,
    NotImplementedAuthError,
    OAuthCallbackInvalidError,
    OAuthProviderUnsupportedError,
    OAuthStateInvalidError,
    OAuthStateReplayedError,
    OtpExpiredError,
    OtpInvalidError,
    OtpReplayedError,
    PlacementContextInvalidError,
    PlacementDirectoryUnavailableError,
    PlacementMovingError,
    PluginAbortedError,
    RateLimitedError,
    RedirectUriDisallowedError,
    RegionMismatchError,
    RegionNotFoundError,
    RoutingAssertionInvalidError,
    RoutingCellUnavailableError,
    SessionExpiredError,
    SessionRevokedError,
    TwoFactorInvalidCodeError,
    TwoFactorRequiredError,
    UnauthorizedError,
    ValidationError,
)


def to_authfn_error(error: Any) -> AuthFnError:
    """Normalize unknown errors into canonical authfn errors."""

    if isinstance(error, AuthFnError):
        return error

    code = getattr(error, "code", None)
    message = getattr(error, "message", None) or str(error) or "Internal authfn error"
    details = getattr(error, "details", None)

    if code == "OPENAPI_META_INCOMPLETE":
        return InternalError(message, details)
    if code == "PROVIDER_RATE_LIMITED":
        return RateLimitedError(message, details)
    if code == "AUTHFN_RATE_LIMITED":
        return RateLimitedError(message, details)
    if code == "AUTHFN_EMAIL_NOT_VERIFIED":
        return EmailNotVerifiedError(message, details)

    return InternalError(message, details)


__all__ = [
    "ApiKeyRevokedError",
    "AuthFnError",
    "AuthFnSchemaConflictError",
    "ConfigError",
    "ConflictError",
    "CsrfInvalidError",
    "DeliveryFailedError",
    "EmailNotVerifiedError",
    "ExpiredCredentialsError",
    "InternalError",
    "InvalidCredentialsError",
    "NotFoundError",
    "NotImplementedAuthError",
    "OAuthCallbackInvalidError",
    "OAuthProviderUnsupportedError",
    "OAuthStateInvalidError",
    "OAuthStateReplayedError",
    "OtpExpiredError",
    "OtpInvalidError",
    "OtpReplayedError",
    "PluginAbortedError",
    "RateLimitedError",
    "RedirectUriDisallowedError",
    "PlacementContextInvalidError",
    "PlacementDirectoryUnavailableError",
    "PlacementMovingError",
    "RegionMismatchError",
    "RegionNotFoundError",
    "RoutingAssertionInvalidError",
    "RoutingCellUnavailableError",
    "SessionExpiredError",
    "SessionRevokedError",
    "TwoFactorInvalidCodeError",
    "TwoFactorRequiredError",
    "UnauthorizedError",
    "ValidationError",
    "to_authfn_error",
]
