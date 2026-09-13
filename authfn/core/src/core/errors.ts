export type AuthFnErrorCode =
  | 'AUTHFN_2FA_INVALID_CODE'
  | 'AUTHFN_2FA_REQUIRED'
  | 'AUTHFN_ADMIN_AMBIGUOUS_USER'
  | 'AUTHFN_ADMIN_CONFIG_INVALID'
  | 'AUTHFN_ADMIN_UNAUTHORIZED'
  | 'AUTHFN_API_KEY_REVOKED'
  | 'AUTHFN_CONFLICT'
  | 'AUTHFN_CONFIG_INVALID'
  | 'AUTHFN_CSRF_INVALID'
  | 'AUTHFN_DELIVERY_FAILED'
  | 'AUTHFN_EMAIL_NOT_VERIFIED'
  | 'AUTHFN_INTERNAL_ERROR'
  | 'AUTHFN_INVALID_CREDENTIALS'
  | 'AUTHFN_NOT_FOUND'
  | 'AUTHFN_NOT_IMPLEMENTED'
  | 'AUTHFN_OAUTH_CALLBACK_INVALID'
  | 'AUTHFN_OAUTH_PROVIDER_UNSUPPORTED'
  | 'AUTHFN_OAUTH_STATE_INVALID'
  | 'AUTHFN_OAUTH_STATE_REPLAYED'
  | 'AUTHFN_OTP_EXPIRED'
  | 'AUTHFN_OTP_INVALID'
  | 'AUTHFN_OTP_REPLAYED'
  | 'AUTHFN_PLUGIN_ABORTED'
  | 'AUTHFN_RATE_LIMITED'
  | 'AUTHFN_REDIRECT_URI_DISALLOWED'
  | 'AUTHFN_REGION_MISMATCH'
  | 'AUTHFN_REGION_NOT_FOUND'
  | 'AUTHFN_PLACEMENT_DIRECTORY_UNAVAILABLE'
  | 'AUTHFN_PLACEMENT_MOVING'
  | 'AUTHFN_ROUTING_ASSERTION_INVALID'
  | 'AUTHFN_ROUTING_CELL_UNAVAILABLE'
  | 'AUTHFN_PLACEMENT_CONTEXT_INVALID'
  | 'AUTHFN_SESSION_EXPIRED'
  | 'AUTHFN_SESSION_REVOKED'
  | 'AUTHFN_UNAUTHENTICATED'
  | 'AUTHFN_VALIDATION_ERROR';

export class AuthFnError extends Error {
  readonly code: AuthFnErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AuthFnErrorCode,
    message: string,
    options?: {
      status?: number;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'AuthFnError';
    this.code = code;
    this.status = options?.status ?? 500;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details;
  }
}

export class AuthFnConflictError extends AuthFnError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('AUTHFN_CONFLICT', message, {
      status: 409,
      details
    });
    this.name = 'AuthFnConflictError';
  }
}

export class AuthFnTwoFactorRequiredError extends AuthFnError {
  constructor(message: string = 'Two-factor authentication required', details?: Record<string, unknown>) {
    super('AUTHFN_2FA_REQUIRED', message, {
      status: 401,
      details
    });
    this.name = 'AuthFnTwoFactorRequiredError';
  }
}

export class AuthFnTwoFactorInvalidCodeError extends AuthFnError {
  constructor(message: string = 'Two-factor authentication code is invalid', details?: Record<string, unknown>) {
    super('AUTHFN_2FA_INVALID_CODE', message, {
      status: 400,
      details
    });
    this.name = 'AuthFnTwoFactorInvalidCodeError';
  }
}

export class AuthFnApiKeyRevokedError extends AuthFnError {
  constructor(message: string = 'API key has been revoked', details?: Record<string, unknown>) {
    super('AUTHFN_API_KEY_REVOKED', message, {
      status: 401,
      details
    });
    this.name = 'AuthFnApiKeyRevokedError';
  }
}

export class AuthFnAdminConfigError extends AuthFnError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('AUTHFN_ADMIN_CONFIG_INVALID', message, {
      status: 400,
      details
    });
    this.name = 'AuthFnAdminConfigError';
  }
}

export class AuthFnAdminUnauthorizedError extends AuthFnError {
  constructor(message: string = 'Admin authorization required', details?: Record<string, unknown>) {
    super('AUTHFN_ADMIN_UNAUTHORIZED', message, {
      status: 401,
      details
    });
    this.name = 'AuthFnAdminUnauthorizedError';
  }
}

export class AuthFnAdminAmbiguousUserError extends AuthFnError {
  constructor(message: string = 'Multiple users matched this identifier', details?: Record<string, unknown>) {
    super('AUTHFN_ADMIN_AMBIGUOUS_USER', message, {
      status: 409,
      details
    });
    this.name = 'AuthFnAdminAmbiguousUserError';
  }
}

export class AuthFnRegionMismatchError extends AuthFnError {
  constructor(message: string = 'Request must continue on a different region authority', details?: Record<string, unknown>) {
    super('AUTHFN_REGION_MISMATCH', message, {
      status: 409,
      details
    });
    this.name = 'AuthFnRegionMismatchError';
  }
}

export class AuthFnRegionNotFoundError extends AuthFnError {
  constructor(message: string = 'Region routing information not found', details?: Record<string, unknown>) {
    super('AUTHFN_REGION_NOT_FOUND', message, {
      status: 404,
      details
    });
    this.name = 'AuthFnRegionNotFoundError';
  }
}

export class AuthFnPlacementDirectoryUnavailableError extends AuthFnError {
  constructor(message: string = 'Identity placement directory is unavailable', details?: Record<string, unknown>) {
    super('AUTHFN_PLACEMENT_DIRECTORY_UNAVAILABLE', message, {
      status: 503,
      retryable: true,
      details
    });
    this.name = 'AuthFnPlacementDirectoryUnavailableError';
  }
}

export class AuthFnPlacementMovingError extends AuthFnError {
  constructor(message: string = 'Identity placement is moving', details?: Record<string, unknown>) {
    super('AUTHFN_PLACEMENT_MOVING', message, {
      status: 503,
      retryable: true,
      details
    });
    this.name = 'AuthFnPlacementMovingError';
  }
}

export class AuthFnRoutingAssertionInvalidError extends AuthFnError {
  constructor(message: string = 'Gateway routing assertion is invalid', details?: Record<string, unknown>) {
    super('AUTHFN_ROUTING_ASSERTION_INVALID', message, {
      status: 401,
      details
    });
    this.name = 'AuthFnRoutingAssertionInvalidError';
  }
}

export class AuthFnRoutingCellUnavailableError extends AuthFnError {
  constructor(message: string = 'Regional AuthFn cell is unavailable', details?: Record<string, unknown>) {
    super('AUTHFN_ROUTING_CELL_UNAVAILABLE', message, {
      status: 503,
      details
    });
    this.name = 'AuthFnRoutingCellUnavailableError';
  }
}

export class AuthFnPlacementContextInvalidError extends AuthFnError {
  constructor(message: string = 'Placement-bound auth context is invalid', details?: Record<string, unknown>) {
    super('AUTHFN_PLACEMENT_CONTEXT_INVALID', message, {
      status: 401,
      details
    });
    this.name = 'AuthFnPlacementContextInvalidError';
  }
}

export class AuthFnConfigError extends AuthFnError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('AUTHFN_CONFIG_INVALID', message, {
      status: 400,
      details
    });
    this.name = 'AuthFnConfigError';
  }
}

export class AuthFnValidationError extends AuthFnError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('AUTHFN_VALIDATION_ERROR', message, {
      status: 400,
      details
    });
    this.name = 'AuthFnValidationError';
  }
}

export class AuthFnInvalidCredentialsError extends AuthFnError {
  constructor(message: string = 'Authentication required', details?: Record<string, unknown>) {
    super('AUTHFN_INVALID_CREDENTIALS', message, {
      status: 401,
      details
    });
    this.name = 'AuthFnInvalidCredentialsError';
  }
}

export class AuthFnUnauthenticatedError extends AuthFnError {
  constructor(message: string = 'Authentication required', details?: Record<string, unknown>) {
    super('AUTHFN_UNAUTHENTICATED', message, {
      status: 401,
      details
    });
    this.name = 'AuthFnUnauthenticatedError';
  }
}

export class AuthFnSessionExpiredError extends AuthFnError {
  constructor(message: string = 'Session expired', details?: Record<string, unknown>) {
    super('AUTHFN_SESSION_EXPIRED', message, {
      status: 401,
      details
    });
    this.name = 'AuthFnSessionExpiredError';
  }
}

export class AuthFnSessionRevokedError extends AuthFnError {
  constructor(message: string = 'Session revoked', details?: Record<string, unknown>) {
    super('AUTHFN_SESSION_REVOKED', message, {
      status: 401,
      details
    });
    this.name = 'AuthFnSessionRevokedError';
  }
}

export class AuthFnCsrfInvalidError extends AuthFnError {
  constructor(message: string = 'CSRF token invalid', details?: Record<string, unknown>) {
    super('AUTHFN_CSRF_INVALID', message, {
      status: 403,
      details
    });
    this.name = 'AuthFnCsrfInvalidError';
  }
}

export class AuthFnNotFoundError extends AuthFnError {
  constructor(message: string = 'Resource not found', details?: Record<string, unknown>) {
    super('AUTHFN_NOT_FOUND', message, {
      status: 404,
      details
    });
    this.name = 'AuthFnNotFoundError';
  }
}

export class AuthFnOtpInvalidError extends AuthFnError {
  constructor(message: string = 'OTP code is invalid', details?: Record<string, unknown>) {
    super('AUTHFN_OTP_INVALID', message, {
      status: 400,
      details
    });
    this.name = 'AuthFnOtpInvalidError';
  }
}

export class AuthFnOtpExpiredError extends AuthFnError {
  constructor(message: string = 'OTP code has expired', details?: Record<string, unknown>) {
    super('AUTHFN_OTP_EXPIRED', message, {
      status: 400,
      details
    });
    this.name = 'AuthFnOtpExpiredError';
  }
}

export class AuthFnOtpReplayedError extends AuthFnError {
  constructor(message: string = 'OTP code has already been used', details?: Record<string, unknown>) {
    super('AUTHFN_OTP_REPLAYED', message, {
      status: 409,
      details
    });
    this.name = 'AuthFnOtpReplayedError';
  }
}

export class AuthFnDeliveryFailedError extends AuthFnError {
  constructor(message: string = 'OTP delivery failed', details?: Record<string, unknown>) {
    super('AUTHFN_DELIVERY_FAILED', message, {
      status: 503,
      retryable: true,
      details
    });
    this.name = 'AuthFnDeliveryFailedError';
  }
}

export class AuthFnEmailNotVerifiedError extends AuthFnError {
  constructor(message: string = 'Email address must be verified before continuing', details?: Record<string, unknown>) {
    super('AUTHFN_EMAIL_NOT_VERIFIED', message, {
      status: 403,
      details
    });
    this.name = 'AuthFnEmailNotVerifiedError';
  }
}

export class AuthFnRateLimitedError extends AuthFnError {
  constructor(message: string = 'Request is temporarily rate limited', details?: Record<string, unknown>) {
    super('AUTHFN_RATE_LIMITED', message, {
      status: 429,
      retryable: true,
      details
    });
    this.name = 'AuthFnRateLimitedError';
  }
}

export class AuthFnOAuthStateInvalidError extends AuthFnError {
  constructor(message: string = 'OAuth state is invalid or expired', details?: Record<string, unknown>) {
    super('AUTHFN_OAUTH_STATE_INVALID', message, {
      status: 400,
      details
    });
    this.name = 'AuthFnOAuthStateInvalidError';
  }
}

export class AuthFnOAuthStateReplayedError extends AuthFnError {
  constructor(message: string = 'OAuth state has already been used', details?: Record<string, unknown>) {
    super('AUTHFN_OAUTH_STATE_REPLAYED', message, {
      status: 409,
      details
    });
    this.name = 'AuthFnOAuthStateReplayedError';
  }
}

export class AuthFnOAuthCallbackInvalidError extends AuthFnError {
  constructor(message: string = 'OAuth callback is invalid', details?: Record<string, unknown>) {
    super('AUTHFN_OAUTH_CALLBACK_INVALID', message, {
      status: 400,
      details
    });
    this.name = 'AuthFnOAuthCallbackInvalidError';
  }
}

export class AuthFnRedirectUriDisallowedError extends AuthFnError {
  constructor(message: string = 'Redirect target is not allowed', details?: Record<string, unknown>) {
    super('AUTHFN_REDIRECT_URI_DISALLOWED', message, {
      status: 400,
      details
    });
    this.name = 'AuthFnRedirectUriDisallowedError';
  }
}

export class AuthFnOAuthProviderUnsupportedError extends AuthFnError {
  constructor(message: string = 'OAuth provider is not supported', details?: Record<string, unknown>) {
    super('AUTHFN_OAUTH_PROVIDER_UNSUPPORTED', message, {
      status: 400,
      details
    });
    this.name = 'AuthFnOAuthProviderUnsupportedError';
  }
}

export class AuthFnPluginAbortedError extends AuthFnError {
  constructor(message: string = 'Plugin hook aborted operation', details?: Record<string, unknown>) {
    super('AUTHFN_PLUGIN_ABORTED', message, {
      status: 500,
      details
    });
    this.name = 'AuthFnPluginAbortedError';
  }
}

export class AuthFnInternalError extends AuthFnError {
  constructor(message: string = 'Internal authfn error', details?: Record<string, unknown>) {
    super('AUTHFN_INTERNAL_ERROR', message, {
      status: 500,
      retryable: true,
      details
    });
    this.name = 'AuthFnInternalError';
  }
}

export class AuthFnNotImplementedError extends AuthFnError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('AUTHFN_NOT_IMPLEMENTED', message, {
      status: 501,
      details
    });
    this.name = 'AuthFnNotImplementedError';
  }
}

export function toAuthFnError(error: unknown): AuthFnError {
  if (error instanceof AuthFnError) {
    return error;
  }

  const maybeOAuthError = mapOAuthError(error);
  if (maybeOAuthError) {
    return maybeOAuthError;
  }

  return new AuthFnInternalError();
}

function mapOAuthError(error: unknown): AuthFnError | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const raw = error as {
    code?: unknown;
    message?: unknown;
    details?: Record<string, unknown>;
    retryable?: unknown;
    status?: unknown;
  };
  const code = typeof raw.code === 'string' ? raw.code : undefined;
  const message = typeof raw.message === 'string' && raw.message.length > 0
    ? raw.message
    : 'OAuth request failed';
  const details = sanitizeOAuthDetails(raw.details);
  const status = typeof raw.status === 'number' ? raw.status : undefined;

  switch (code) {
    case 'OAUTH_PROVIDER_UNSUPPORTED':
      return new AuthFnOAuthProviderUnsupportedError(message, details);
    case 'OAUTH_REDIRECT_DISALLOWED':
      return new AuthFnRedirectUriDisallowedError(message, details);
    case 'OAUTH_CALLBACK_MISMATCH':
    case 'OAUTH_HOOK_FAILED':
      return new AuthFnOAuthCallbackInvalidError(message, details);
    case 'OAUTH_STATE_INVALID':
      return new AuthFnOAuthStateInvalidError(message, details);
    case 'OAUTH_STATE_REPLAYED':
      return new AuthFnOAuthStateReplayedError(message, details);
    case 'OAUTH_TOKEN_EXCHANGE_FAILED':
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return new AuthFnOAuthCallbackInvalidError(message, details);
      }
      return new AuthFnInternalError(resolveOAuthInternalMessage(code, message), details);
    case 'OAUTH_RUNTIME_CONFIG_INVALID':
    case 'OAUTH_SECRET_RESOLUTION_FAILED':
      return new AuthFnInternalError(resolveOAuthInternalMessage(code, message), details);
    case 'PROVIDER_RATE_LIMITED':
      return new AuthFnRateLimitedError(resolveOAuthInternalMessage(code, message), details);
    case 'VALIDATION_ERROR':
      return new AuthFnValidationError(message, details);
    default:
      return null;
  }
}

function sanitizeOAuthDetails(
  details: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      shouldRedactOAuthDetail(key) ? '[REDACTED]' : sanitizeOAuthValue(value)
    ])
  );
}

function sanitizeOAuthValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return shouldRedactOAuthDetail(value) ? '[REDACTED]' : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeOAuthValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        shouldRedactOAuthDetail(key) ? '[REDACTED]' : sanitizeOAuthValue(entry)
      ])
    );
  }

  return value;
}

function shouldRedactOAuthDetail(key: string): boolean {
  return /(token|secret|authorization|bearer|password|key)/i.test(key);
}

function resolveOAuthInternalMessage(code: string, message: string): string {
  const sanitizedMessage = /(token|secret|authorization|bearer|password|key)/i.test(message)
    ? ''
    : message;

  switch (code) {
    case 'OAUTH_TOKEN_EXCHANGE_FAILED':
      return sanitizedMessage || 'OAuth token exchange failed';
    case 'OAUTH_RUNTIME_CONFIG_INVALID':
      return sanitizedMessage || 'OAuth runtime configuration is invalid';
    case 'OAUTH_SECRET_RESOLUTION_FAILED':
      return sanitizedMessage || 'OAuth secret resolution failed';
    case 'PROVIDER_RATE_LIMITED':
      return sanitizedMessage || 'OAuth provider is temporarily rate limited';
    default:
      return sanitizedMessage || 'OAuth request failed';
  }
}
