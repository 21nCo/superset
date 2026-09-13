from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from superfunctions.oauth import (
    OAuthBrowserAuthSubject,
    OAuthFlowIdentityHooks,
    OAuthFlowServiceConfig,
    OAuthFlowStartInput,
    OAuthHttpError,
    OAuthProviderDescriptor,
    OAuthProviderRuntimeConfig,
    OAuthStateRecord,
    OAuthTokenEndpointResponse,
    TokenRecord,
    create_oauth_flow_service,
)


class MemoryStateStore:
    def __init__(self) -> None:
        self.records: dict[str, OAuthStateRecord] = {}

    async def put(self, record: OAuthStateRecord) -> None:
        self.records[record.state_id] = record

    async def get(self, state_id: str) -> OAuthStateRecord | None:
        return self.records.get(state_id)

    async def consume(self, state_id: str, consumed_at: str) -> OAuthStateRecord | None:
        record = self.records.get(state_id)
        if record is None or record.consumed_at is not None:
            return None
        record.consumed_at = consumed_at
        return record


class MemoryTokenVault:
    def __init__(self) -> None:
        self.records: list[TokenRecord] = []

    async def put(self, record: TokenRecord) -> None:
        self.records.append(record)

    async def delete_by_connection(self, connection_id: str) -> None:
        self.records = [
            record for record in self.records if record.connection_id != connection_id
        ]


class RecordingTokenHttpClient:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []

    async def exchange_token(self, request: Any) -> OAuthTokenEndpointResponse:
        self.requests.append(request.model_dump(by_alias=True, exclude_none=True))
        return OAuthTokenEndpointResponse.model_validate(
            {
                "accessToken": "token_123",
                "refreshToken": "refresh_123",
                "expiresIn": 3600,
            }
        )


def build_service(*, allowlisted_redirect_uris: list[str]) -> tuple[Any, MemoryStateStore, RecordingTokenHttpClient, list[dict[str, Any]]]:
    state_store = MemoryStateStore()
    token_client = RecordingTokenHttpClient()
    token_vault = MemoryTokenVault()
    events: list[dict[str, Any]] = []

    async def resolve_identity(_input: Any) -> dict[str, Any]:
        return {
            "tenantId": "tenant_1",
            "userId": "user_1",
            "connectionId": "connection_1",
        }

    async def emit_event(event: Any) -> None:
        events.append(event.model_dump(by_alias=True, exclude_none=True))

    config = OAuthFlowServiceConfig.model_validate(
        {
            "providers": {
                "google": OAuthProviderDescriptor.model_validate(
                    {
                        "id": "google",
                        "authorizationUrl": "https://accounts.example.com/oauth/authorize",
                        "tokenUrl": "https://accounts.example.com/oauth/token",
                        "defaultScopes": ["openid", "email"],
                    }
                )
            },
            "providerRuntimeConfig": {
                "google": OAuthProviderRuntimeConfig.model_validate(
                    {
                        "clientId": "client_123",
                        "clientSecret": "secret_123",
                        "allowlistedRedirectUris": allowlisted_redirect_uris,
                    }
                )
            },
            "stateStore": state_store,
            "tokenVault": token_vault,
            "tokenHttpClient": token_client,
            "identityHooks": OAuthFlowIdentityHooks.model_validate(
                {"resolveBrowserAuthIdentity": resolve_identity}
            ),
            "keyRef": "key_1",
            "stateTtlSeconds": 600,
            "now": lambda: datetime(2026, 4, 19, 0, 0, 0, tzinfo=timezone.utc),
            "emitEvent": emit_event,
        }
    )
    return create_oauth_flow_service(config), state_store, token_client, events


@pytest.mark.asyncio
async def test_start_persists_default_scopes_and_reuses_them_during_callback() -> None:
    service, state_store, token_client, events = build_service(
        allowlisted_redirect_uris=["https://app.example.com/callback"]
    )

    started = await service.start(
        OAuthFlowStartInput.model_validate(
            {
                "providerId": "google",
                "redirectUri": "https://app.example.com/callback",
                "subject": OAuthBrowserAuthSubject.model_validate({"kind": "browser", "intentId": "test-intent"}),
            }
        )
    )

    stored_state = await state_store.get(started.state_id)
    assert stored_state is not None
    assert stored_state.requested_scopes == ["openid", "email"]

    await service.handle_callback(
        {
            "providerId": "google",
            "code": "code_123",
            "state": started.state_id,
            "requestId": "req_1",
        }
    )

    assert token_client.requests[0]["scopes"] == ["openid", "email"]
    assert events[0]["name"] == "oauth.flow.started"
    assert events[-1]["name"] == "oauth.flow.callback.success"


@pytest.mark.asyncio
async def test_start_rejects_non_allowlisted_redirect_uri_and_emits_failure() -> None:
    service, _state_store, _token_client, events = build_service(
        allowlisted_redirect_uris=["https://app.example.com/callback"]
    )

    with pytest.raises(OAuthHttpError) as exc_info:
        await service.start(
            OAuthFlowStartInput.model_validate(
                {
                    "providerId": "google",
                    "redirectUri": "https://evil.example.com/callback",
                    "subject": OAuthBrowserAuthSubject.model_validate({"kind": "browser", "intentId": "test-intent"}),
                    "requestId": "req_blocked",
                }
            )
        )

    assert exc_info.value.code == "OAUTH_REDIRECT_DISALLOWED"
    assert events == [
        {
            "name": "oauth.flow.start.failed",
            "ok": False,
            "providerId": "google",
            "requestId": "req_blocked",
            "subjectKind": "browser",
            "errorCode": "OAUTH_REDIRECT_DISALLOWED",
            "details": {"redirectUri": "https://evil.example.com/callback"},
        }
    ]
