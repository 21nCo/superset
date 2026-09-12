# authfn Python SDK

The Python `authfn` package mirrors the TypeScript authfn contract for backend runtimes that want the same routes, schema output, plugin surface, and canonical error envelopes.

## What It Covers

- Browser session routes and cookie handling
- Password sign-up/sign-in and password reset
- Email OTP send/verify
- Google, Apple, and GitHub social OAuth sign-in
- User-owned API keys
- TOTP-based 2FA
- Multi-region lookup and runtime resolution
- Shared OpenAPI generation through the Python `superfunctions.http.openapi` layer

## Quick Start

```python
from authfn import (
    AuthFnConfig,
    authfn_email_otp_plugin,
    authfn_multi_region_plugin,
    authfn_password_plugin,
    authfn_social_oauth_plugin,
    authfn_two_factor_plugin,
    create_authfn,
)

auth = create_authfn(
    AuthFnConfig(
        database=my_database_adapter,
        namespace="authfn",
        plugins=[
            authfn_password_plugin(),
            authfn_email_otp_plugin(
                {
                    "delivery": my_delivery_provider,
                }
            ),
            authfn_social_oauth_plugin(
                {
                    "providers": {
                        "google": {
                            "client_id": "google-client-id",
                            "client_secret": "google-client-secret",
                            "allowlisted_return_to": [
                                "https://app.example.com/post-auth",
                            ],
                        }
                    }
                }
            ),
            authfn_two_factor_plugin(),
            authfn_multi_region_plugin(),
        ],
    )
)
```

Mount the emitted routes through the shared adapters:

- `superfunctions-fastapi`
- `superfunctions-flask`

## Route Surface

- `GET /auth/session`
- `GET /auth/sessions`
- `POST /auth/sign-out`
- `POST /auth/sessions/:sessionId/revoke`
- `POST /auth/sign-up/password`
- `POST /auth/sign-in/password`
- `POST /auth/password/reset/start`
- `POST /auth/password/reset/complete`
- `POST /auth/otp/send`
- `POST /auth/otp/verify`
- `POST /auth/social/start`
- `GET /auth/social/callback/:provider`
- `POST /auth/social/disconnect/:provider`
- `POST /auth/api-keys`
- `GET /auth/api-keys`
- `DELETE /auth/api-keys/:keyId`
- `POST /auth/2fa/enroll`
- `POST /auth/2fa/confirm`
- `POST /auth/2fa/challenge`
- `POST /auth/2fa/disable`
- `POST /auth/regions/lookup`
- `GET /auth/environment`
- `GET /auth/runtime` (compatibility alias for `/auth/environment`)

## OpenAPI

Python authfn uses the shared OpenAPI generator rather than maintaining a custom authfn-specific implementation:

```python
document = auth.open_api()
```

The output is deterministic and matches the TypeScript path surface.

## Notes

- Python authfn follows the same canonical envelopes and error codes as TypeScript.
- FastAPI and Flask cookie propagation is covered by the shared package layer and authfn parity tests.
- Sensitive values such as passwords, OTP codes, API key secrets, and OAuth tokens are omitted or redacted from observability events.

### Awaiting placement verification telemetry

Use `await verifier.verify_signed_async(assertion)` (also available on the issuer) in request-scoped or serverless runtimes. It waits for configured verification event delivery on both success and rejection. The synchronous verification API remains available, but cannot guarantee asynchronous telemetry completes before the request lifetime ends.
