from __future__ import annotations

from typing import Optional

import pytest

from superfunctions.oauth import (
    OAuthCoreError,
    OAuthFlowStartInput,
    OAuthProviderDescriptor,
    OAuthSecretResolverContext,
    OAuthStateRecord,
    OAuthStateStore,
    OAuthStateStoreError,
    OAuthTokenEndpointRequest,
    apply_subject_to_state_record,
    assert_callback_state_matches,
    consume_state_or_throw,
    get_oauth_subject_key,
    normalize_oauth_error_body,
    resolve_oauth_stored_subject,
    secret_resolution_failed_error,
    validate_oauth_state_record,
)


class MemoryStateStore(OAuthStateStore):
    def __init__(self, record: Optional[OAuthStateRecord]) -> None:
        self.record = record
        self.consumed = False

    async def put(self, record: OAuthStateRecord) -> None:
        self.record = record

    async def get(self, state_id: str) -> Optional[OAuthStateRecord]:
        if self.record is not None and self.record.state_id == state_id:
            return self.record
        return None

    async def consume(self, state_id: str, consumed_at: str) -> Optional[OAuthStateRecord]:
        if self.record is None or self.record.state_id != state_id:
            return None
        if self.consumed:
            replay = self.record.model_copy(deep=True)
            replay.consumed_at = consumed_at
            self.record = replay
            return None

        consumed = self.record.model_copy(deep=True)
        consumed.consumed_at = consumed_at
        self.record = consumed
        self.consumed = True
        return consumed

    async def delete_expired(self, before: str) -> int:
        return 0


def test_python_oauth_modules_support_browser_auth_state_parity() -> None:
    record = OAuthStateRecord.model_validate(
        {
            "stateId": "state_01",
            "providerId": "google",
            "redirectUri": "https://app.example.com/auth/callback",
            "requestedScopes": ["openid", "email"],
            "intentId": "intent_01",
            "tenantId": "tenant_01",
            "regionId": "ap-south-1",
            "returnTo": "https://app.example.com/home",
            "metadata": {"mode": "signin"},
            "createdAt": "2026-03-22T08:00:00Z",
            "expiresAt": "2026-03-22T08:10:00Z",
        }
    )

    validate_oauth_state_record(record)
    subject = resolve_oauth_stored_subject(record)
    normalized = apply_subject_to_state_record(record)

    assert subject.kind == "browser-auth"
    assert subject.intent_id == "intent_01"
    assert subject.region_id == "ap-south-1"
    assert get_oauth_subject_key(subject) == "browser-auth:intent_01"
    assert normalized.subject is not None
    assert normalized.subject.kind == "browser-auth"
    assert normalized.metadata == {"mode": "signin"}


@pytest.mark.asyncio
async def test_python_oauth_core_consume_state_or_throw_replays() -> None:
    record = OAuthStateRecord.model_validate(
        {
            "stateId": "state_02",
            "providerId": "github",
            "redirectUri": "https://app.example.com/auth/callback",
            "requestedScopes": ["read:user"],
            "tenantId": "tenant_01",
            "userId": "user_01",
            "createdAt": "2026-03-22T08:00:00Z",
            "expiresAt": "2026-03-22T08:10:00Z",
        }
    )
    store = MemoryStateStore(record)

    consumed = await consume_state_or_throw(store, "state_02", "2026-03-22T08:05:00Z")
    assert consumed.provider_id == "github"

    with pytest.raises(OAuthCoreError) as exc_info:
        await consume_state_or_throw(store, "state_02", "2026-03-22T08:06:00Z")

    assert exc_info.value.code == "OAUTH_STATE_REPLAYED"


def test_python_oauth_http_secret_resolution_errors_redact_secrets() -> None:
    provider = OAuthProviderDescriptor.model_validate(
        {
            "id": "apple",
            "authorizationUrl": "https://appleid.apple.com/auth/authorize",
            "tokenUrl": "https://appleid.apple.com/auth/token",
            "defaultScopes": ["name", "email"],
            "supportsPkce": True,
            "supportsRefreshToken": True,
        }
    )
    context = OAuthSecretResolverContext.model_validate(
        {
            "provider": provider,
            "operation": "exchange",
            "clientId": "client_123",
            "grantType": "authorization_code",
        }
    )
    error = secret_resolution_failed_error(
        context, RuntimeError("JWT generation failed for private key SECRET_ABC")
    )

    assert error.code == "OAUTH_SECRET_RESOLUTION_FAILED"
    assert error.details is not None
    assert error.details["providerId"] == "apple"
    assert "clientSecret" not in error.details


def test_python_oauth_core_matches_callback_and_runtime_shapes() -> None:
    provider = OAuthProviderDescriptor.model_validate(
        {
            "id": "google",
            "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth",
            "tokenUrl": "https://oauth2.googleapis.com/token",
            "defaultScopes": ["openid", "email"],
            "supportsPkce": True,
            "supportsRefreshToken": True,
        }
    )
    state = OAuthStateRecord.model_validate(
        {
            "stateId": "state_03",
            "providerId": "google",
            "redirectUri": "https://app.example.com/auth/callback",
            "requestedScopes": ["openid", "email"],
            "intentId": "intent_03",
            "createdAt": "2026-03-22T08:00:00Z",
            "expiresAt": "2026-03-22T08:10:00Z",
        }
    )
    request = OAuthTokenEndpointRequest.model_validate(
        {
            "provider": provider,
            "grantType": "authorization_code",
            "clientId": "google-client",
            "code": "code_123",
            "redirectUri": "https://app.example.com/auth/callback",
        }
    )
    start_input = OAuthFlowStartInput.model_validate(
        {
            "providerId": "google",
            "redirectUri": "https://app.example.com/auth/callback",
            "subject": {
                "kind": "browser-auth",
                "intentId": "intent_03",
                "returnTo": "https://app.example.com/home",
            },
        }
    )

    assert_callback_state_matches(
        {"providerId": "google", "redirectUri": "https://app.example.com/auth/callback"},
        state,
    )

    assert request.grant_type == "authorization_code"
    assert start_input.subject is not None
    assert start_input.subject.kind == "browser-auth"
    assert normalize_oauth_error_body({"error_description": "invalid_grant"}) == {
        "message": "invalid_grant",
        "details": {"error_description": "invalid_grant"},
    }


def test_python_oauth_state_validation_rejects_invalid_subject() -> None:
    record = OAuthStateRecord.model_validate(
        {
            "stateId": "state_04",
            "providerId": "github",
            "redirectUri": "https://app.example.com/auth/callback",
            "requestedScopes": ["read:user"],
            "subject": {"kind": "browser-auth", "intentId": "", "metadata": {"flow": "signin"}},
            "createdAt": "2026-03-22T08:00:00Z",
            "expiresAt": "2026-03-22T08:10:00Z",
        }
    )

    with pytest.raises(OAuthStateStoreError) as exc_info:
        validate_oauth_state_record(record)

    assert exc_info.value.code == "VALIDATION_ERROR"
