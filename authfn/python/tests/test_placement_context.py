"""Placement-bound auth context tests."""

from __future__ import annotations

import base64
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import pytest

TESTS_DIR = os.path.dirname(__file__)
AUTHFN_PYTHON_ROOT = os.path.abspath(os.path.join(TESTS_DIR, ".."))
PYTHON_CORE_ROOT = os.path.abspath(
    os.path.join(TESTS_DIR, "..", "..", "..", "packages", "python-core")
)

for path in (AUTHFN_PYTHON_ROOT, PYTHON_CORE_ROOT):
    if path not in sys.path:
        sys.path.insert(0, path)

from authfn import (
    AuthFnConfig,
    ConfigError,
    IdentityPlacement,
    InMemoryIdentityPlacementDirectory,
    PlacementContextInvalidError,
    PlacementDirectoryUnavailableError,
    PlacementMovingError,
    RegionNotFoundError,
    RoutingKeyring,
    RoutingSigningKey,
    SessionExpiredError,
    SessionRevokedError,
    UnauthorizedError,
    ValidationError,
    create_placement_context_issuer,
    create_placement_context_verifier,
)
from authfn.http import _hash_secret, issue_session, revoke_session_by_id
from authfn.observability import resolve_request_id
from authfn.plugins.placement_context import (
    _credential_expired,
    _isoformat,
    _normalize_authority,
    _strip_routing_headers,
    _telemetry_hash,
)

from .support import InMemoryDatabaseAdapter, TestRequest


@dataclass
class _Setup:
    issuer: Any
    request: TestRequest
    user: Dict[str, Any]
    issued: Dict[str, Any]
    config: AuthFnConfig
    directory: Any

SUBJECT_SECRET = "placement-subject-secret-with-enough-entropy"
KEYRING = RoutingKeyring(
    active=RoutingSigningKey(
        key_id="context-2026-09",
        secret="test-context-secret-with-enough-entropy",
    )
)


@pytest.mark.asyncio
async def test_derives_opaque_context_from_valid_session() -> None:
    setup = await _setup()
    context = await setup.issuer.derive(setup.request)
    user = setup.user
    assert user["id"] not in context.subject
    assert "ada@example.com" not in context.subject
    assert context.home_region == "us-east-1"
    assert context.placement_epoch == 4
    assert context.issuer == "https://account.example.com"
    assert context.audience == "nucleum-datafn"
    assert context.user_id is None
    assert "ada@example.com" not in str(context)
    assert "cell://" not in str(context)


@pytest.mark.asyncio
async def test_ignores_client_supplied_routing_headers() -> None:
    setup = await _setup(
        extra_headers={
            "x-authfn-routing-region": "eu-west-1",
            "x-authfn-routing-epoch": "99",
        }
    )
    context = await setup.issuer.derive(setup.request)
    assert context.home_region == "us-east-1"
    assert context.placement_epoch == 4


def test_sanitized_request_keeps_adapter_attributes() -> None:
    request = TestRequest(
        "GET",
        "https://account.example.com/auth/session?region=us",
        headers={"x-authfn-routing-region": "eu-west-1", "cookie": "session=1"},
    )
    sanitized = _strip_routing_headers(request)
    assert sanitized.path == request.path
    assert sanitized.query_params == request.query_params
    assert sanitized.headers.get("cookie") == "session=1"
    assert "x-authfn-routing-region" not in {key.lower() for key in sanitized.headers}


@pytest.mark.asyncio
async def test_treats_whitespace_only_request_ids_as_absent() -> None:
    events: List[Any] = []
    setup = await _setup(
        extra_headers={"x-request-id": "   "},
        on_event=events.append,
    )
    context = await setup.issuer.derive(setup.request)
    assert context.request_id.strip()
    assert context.request_id != "   "
    issued = next(
        event
        for event in events
        if (getattr(event, "type", None) or event.get("type")) == "authfn.placement_context.issued"
    )
    assert (getattr(issued, "requestId", None) or issued.get("requestId")) == context.request_id


@pytest.mark.asyncio
async def test_fails_closed_for_unauthenticated_revoked_expired_and_deleted() -> None:
    setup = await _setup()
    unauthenticated = TestRequest("GET", "https://account.example.com/auth/session")
    with pytest.raises(UnauthorizedError):
        await setup.issuer.derive(unauthenticated)

    await revoke_session_by_id(setup.config, setup.issued["record"]["id"], user_id=setup.user["id"])
    with pytest.raises(SessionRevokedError):
        await setup.issuer.derive(setup.request)

    expired = await _setup()
    await expired.config.database.update(
        model="sessions",
        where=[{"field": "id", "operator": "eq", "value": expired.issued["record"]["id"]}],
        data={"expiresAt": datetime.now(timezone.utc) - timedelta(seconds=1)},
        namespace="authfn",
    )
    with pytest.raises(SessionExpiredError):
        await expired.issuer.derive(expired.request)

    deleted = await _setup()
    await deleted.config.database.delete_many(
        model="users",
        where=[{"field": "id", "operator": "eq", "value": deleted.user["id"]}],
        namespace="authfn",
    )
    with pytest.raises(UnauthorizedError):
        await deleted.issuer.derive(deleted.request)


@pytest.mark.asyncio
async def test_fails_closed_for_moving_deleting_tombstoned_missing_and_unavailable() -> None:
    moving = await _setup(
        placement=IdentityPlacement(
            identity_key="person:ada",
            region_id="us-east-1",
            epoch=5,
            state="moving",
            updated_at="2026-09-04T00:00:00.000Z",
        ),
        identity_key="person:ada",
    )
    with pytest.raises(PlacementMovingError):
        await moving.issuer.derive(moving.request)

    deleting = await _setup(
        placement=IdentityPlacement(
            identity_key="person:ada",
            region_id="us-east-1",
            epoch=5,
            state="deleting",
            updated_at="2026-09-04T00:00:00.000Z",
        ),
        identity_key="person:ada",
    )
    with pytest.raises(PlacementMovingError):
        await deleting.issuer.derive(deleting.request)

    tombstoned = await _setup()
    await tombstoned.directory.compare_and_set(
        identity_key=f"person:{tombstoned.user['id']}",
        expected_epoch=4,
        expected_state="active",
        placement=IdentityPlacement(
            identity_key=f"person:{tombstoned.user['id']}",
            region_id="us-east-1",
            epoch=4,
            state="tombstoned",
            updated_at="2026-09-04T00:00:00.000Z",
        ),
    )
    with pytest.raises(RegionNotFoundError):
        await tombstoned.issuer.derive(tombstoned.request)

    missing = await _setup(skip_placement=True)
    with pytest.raises(RegionNotFoundError):
        await missing.issuer.derive(missing.request)

    class DownDirectory:
        async def get(self, _identity_key: str) -> None:
            raise RuntimeError("directory down")

        async def put_if_absent(self, _placement: IdentityPlacement) -> Dict[str, Any]:
            raise RuntimeError("directory down")

        async def compare_and_set(self, **_kwargs: Any) -> Dict[str, Any]:
            raise RuntimeError("directory down")

    down = await _setup(directory=DownDirectory())
    with pytest.raises(PlacementDirectoryUnavailableError):
        await down.issuer.derive(down.request)

    class NonStringRegionDirectory:
        async def get(self, identity_key: str) -> IdentityPlacement:
            placement = IdentityPlacement(
                identity_key=identity_key,
                region_id="us-east-1",
                epoch=4,
                state="active",
                updated_at="2026-09-04T00:00:00.000Z",
            )
            placement.region_id = 123  # type: ignore[assignment]
            return placement

        async def put_if_absent(self, _placement: IdentityPlacement) -> Dict[str, Any]:
            return {"inserted": False}

        async def compare_and_set(self, **_kwargs: Any) -> Dict[str, Any]:
            return {"updated": False}

    malformed = await _setup(directory=NonStringRegionDirectory())
    with pytest.raises(PlacementDirectoryUnavailableError):
        await malformed.issuer.derive(malformed.request)


@pytest.mark.asyncio
async def test_signed_private_consumer_and_in_process_ticket_exchange() -> None:
    setup = await _setup()
    issued = await setup.issuer.issue_signed(setup.request)
    remote = create_placement_context_verifier(
        audiences=["nucleum-datafn"],
        public_authority="https://account.example.com",
        keyring=KEYRING,
        config=setup.config,
    )
    verified = remote.verify_signed(issued["assertion"])
    assert verified.home_region == "us-east-1"
    assert verified.subject == issued["context"].subject
    encoded = issued["assertion"].split(".", 1)[0]
    padding = "=" * ((4 - len(encoded) % 4) % 4)
    payload = json.loads(base64.urlsafe_b64decode(encoded + padding))
    assert "userId" not in payload
    assert "scopes" not in payload
    with pytest.raises(ValidationError):
        await setup.issuer.derive(setup.request, audience="other-service")
    with pytest.raises(PlacementContextInvalidError):
        remote.verify_signed(issued["assertion"], audience="other-service")

    ticket = await setup.issuer.with_context(
        setup.request,
        lambda context: {
            "regionId": context.home_region,
            "epoch": context.placement_epoch,
            "subject": context.subject,
        },
    )
    assert ticket["regionId"] == "us-east-1"
    assert "cell://" not in str(ticket)


@pytest.mark.asyncio
async def test_keeps_issued_grants_after_revoke_and_uses_new_epoch_after_move() -> None:
    setup = await _setup()
    signed = await setup.issuer.issue_signed(setup.request)
    await revoke_session_by_id(setup.config, setup.issued["record"]["id"], user_id=setup.user["id"])
    with pytest.raises(SessionRevokedError):
        await setup.issuer.derive(setup.request)
    assert setup.issuer.verify_signed(signed["assertion"]).session_binding == signed["context"].session_binding

    moved = await _setup()
    first = await moved.issuer.derive(moved.request)
    await moved.directory.compare_and_set(
        identity_key=f"person:{moved.user['id']}",
        expected_epoch=4,
        expected_state="active",
        placement=IdentityPlacement(
            identity_key=f"person:{moved.user['id']}",
            region_id="eu-west-1",
            epoch=6,
            state="active",
            previous_region_id="us-east-1",
            updated_at="2026-09-04T13:00:00.000Z",
        ),
    )
    with pytest.raises(PlacementMovingError):
        await moved.issuer.derive(moved.request)
    assert first.home_region == "us-east-1"

    current = await _setup(region_id="eu-west-1", directory=moved.directory)
    await current.config.database.create(
        model="sessions", namespace="authfn",
        data={**moved.issued["record"], "revokedAt": datetime.now(timezone.utc)},
    )
    with pytest.raises(SessionRevokedError):
        await current.issuer.derive(moved.request)
    fresh_context = await current.issuer.derive(current.request)
    assert fresh_context.home_region == "eu-west-1"
    assert fresh_context.placement_epoch == 6
    assert fresh_context.subject == first.subject

    padded = await _setup(region_id="  us-east-1  ")
    assert (await padded.issuer.derive(padded.request)).home_region == "us-east-1"


@pytest.mark.asyncio
async def test_falls_back_to_authorization_when_cookie_is_stale() -> None:
    setup = await _setup()
    fresh = await issue_session(
        setup.config,
        TestRequest("GET", "https://account.example.com/auth/session"),
        user=setup.user,
        methods=["password"],
    )
    await revoke_session_by_id(setup.config, setup.issued["record"]["id"], user_id=setup.user["id"])
    with pytest.raises(SessionRevokedError):
        await setup.issuer.derive(setup.request)

    mixed = TestRequest(
        "GET",
        "https://account.example.com/auth/session",
        headers={
            "cookie": setup.request.headers["cookie"],
            "authorization": f"Bearer {fresh['sessionToken']}",
        },
    )
    context = await setup.issuer.derive(mixed)
    bearer_only = await setup.issuer.derive(
        TestRequest(
            "GET",
            "https://account.example.com/auth/session",
            headers={"authorization": f"Bearer {fresh['sessionToken']}"},
        )
    )
    assert context.home_region == "us-east-1"
    assert context.session_binding == bearer_only.session_binding


@pytest.mark.asyncio
async def test_falls_back_to_stale_cookie_error_after_credential_miss() -> None:
    setup = await _setup()
    await revoke_session_by_id(setup.config, setup.issued["record"]["id"], user_id=setup.user["id"])
    mixed = TestRequest(
        "GET",
        "https://account.example.com/auth/session",
        headers={
            "cookie": setup.request.headers["cookie"],
            "authorization": "Bearer not-a-real-secret",
        },
    )
    with pytest.raises(SessionRevokedError):
        await setup.issuer.derive(mixed)


@pytest.mark.asyncio
async def test_uses_stored_authentication_time_for_cookie_and_bearer() -> None:
    setup = await _setup()
    authenticated_at = datetime(2026, 9, 1, tzinfo=timezone.utc)
    await setup.config.database.update(
        model="sessions",
        where=[{"field": "id", "operator": "eq", "value": setup.issued["record"]["id"]}],
        data={"lastAuthenticatedAt": authenticated_at, "updatedAt": authenticated_at},
        namespace="authfn",
    )
    cookie_context = await setup.issuer.derive(setup.request)
    bearer_context = await setup.issuer.derive(
        TestRequest(
            "GET",
            "https://account.example.com/auth/session",
            headers={"authorization": f"Bearer {setup.issued['sessionToken']}"},
        )
    )
    again = await setup.issuer.derive(setup.request)
    expected = "2026-09-01T00:00:00.000Z"
    assert cookie_context.authenticated_at == expected
    assert bearer_context.authenticated_at == expected
    assert again.authenticated_at == expected
    assert again.session_version == cookie_context.session_version


@pytest.mark.asyncio
async def test_emits_configured_observability_events() -> None:
    events: List[Any] = []
    setup = await _setup(on_event=events.append)
    context = await setup.issuer.derive(setup.request)
    types = [getattr(event, "type", None) or event.get("type") for event in events]
    assert "authfn.placement_context.issued" in types
    issued = next(
        event
        for event in events
        if (getattr(event, "type", None) or event.get("type")) == "authfn.placement_context.issued"
    )
    issued_metadata = getattr(issued, "metadata", None) or issued.get("metadata")
    assert issued_metadata["actorType"] == "user"
    assert (getattr(issued, "actorId", None) or issued.get("actorId")) == _telemetry_hash(
        context.subject
    )
    with pytest.raises(ValidationError):
        await setup.issuer.derive(setup.request, audience="other-service")
    types = [getattr(event, "type", None) or event.get("type") for event in events]
    assert "authfn.placement_context.rejected" in types
    signed = await setup.issuer.issue_signed(setup.request)
    with pytest.raises(PlacementContextInvalidError):
        setup.issuer.verify_signed(signed["assertion"], audience="other-service")
    failed = [
        event
        for event in events
        if (getattr(event, "type", None) or event.get("type")) == "authfn.placement_context.verification_failed"
    ]
    assert failed
    metadata = getattr(failed[-1], "metadata", None) or failed[-1].get("metadata")
    assert metadata.get("errorType")
    assert metadata.get("audience") == "other-service"


@pytest.mark.asyncio
async def test_normalizes_default_https_port_like_typescript_origin() -> None:
    setup = await _setup(public_authority="https://account.example.com:443")
    context = await setup.issuer.derive(setup.request)
    assert context.issuer == "https://account.example.com"


@pytest.mark.asyncio
async def test_reuses_original_request_correlation_id() -> None:
    setup = await _setup()
    context = await setup.issuer.derive(setup.request)
    assert context.request_id == resolve_request_id(setup.request)


@pytest.mark.asyncio
async def test_accepts_lowercase_authorization_scheme() -> None:
    setup = await _setup()
    await setup.config.database.create(
        model="api_keys",
        data={
            "id": "key_lower",
            "secretHash": _hash_secret("secret_lower"),
            "userId": setup.user["id"],
            "name": "lower",
            "scopes": [],
            "createdAt": datetime(2026, 9, 1, tzinfo=timezone.utc),
            "updatedAt": datetime(2026, 9, 1, tzinfo=timezone.utc),
        },
        namespace="authfn",
    )
    request = TestRequest(
        "GET",
        "https://account.example.com/auth/session",
        headers={"authorization": "bearer secret_lower"},
    )
    context = await setup.issuer.derive(request)
    assert context.actor_type == "api-key"
    assert context.home_region == "us-east-1"
    assert context.scopes == ()
    signed = await setup.issuer.issue_signed(request)
    encoded = signed["assertion"].split(".", 1)[0]
    padding = "=" * ((4 - len(encoded) % 4) % 4)
    payload = json.loads(base64.urlsafe_b64decode(encoded + padding))
    assert payload["scopes"] == []


@pytest.mark.asyncio
async def test_api_key_scheme_skips_session_lookup() -> None:
    setup = await _setup()
    await setup.config.database.create(
        model="api_keys",
        data={
            "id": "key_scheme",
            "secretHash": _hash_secret("secret_scheme"),
            "userId": setup.user["id"],
            "name": "scheme",
            "createdAt": datetime(2026, 9, 1, tzinfo=timezone.utc),
            "updatedAt": datetime(2026, 9, 1, tzinfo=timezone.utc),
        },
        namespace="authfn",
    )
    original = setup.config.database.find_one

    async def find_one(
        model: str,
        where: List[Dict[str, Any]],
        namespace: str,
    ) -> Any:
        if model == "sessions":
            raise RuntimeError("sessions table unavailable")
        return await original(model=model, where=where, namespace=namespace)

    setup.config.database.find_one = find_one  # type: ignore[method-assign]
    cookie_free = TestRequest(
        "GET",
        "https://account.example.com/auth/session",
        headers={"authorization": "Api-Key secret_scheme"},
    )
    context = await setup.issuer.derive(cookie_free)
    assert context.actor_type == "api-key"
    assert context.home_region == "us-east-1"

    setup.config.database.find_one = original  # type: ignore[method-assign]
    session_as_api_key = TestRequest(
        "GET",
        "https://account.example.com/auth/session",
        headers={"authorization": f"Api-Key {setup.issued['sessionToken']}"},
    )
    with pytest.raises(UnauthorizedError):
        await setup.issuer.derive(session_as_api_key)


@pytest.mark.asyncio
async def test_omits_absent_api_key_scopes_from_signed_payload() -> None:
    setup = await _setup()
    await setup.config.database.create(
        model="api_keys",
        data={
            "id": "key_no_scopes",
            "secretHash": _hash_secret("secret_no_scopes"),
            "userId": setup.user["id"],
            "name": "no-scopes",
            "createdAt": datetime(2026, 9, 1, tzinfo=timezone.utc),
            "updatedAt": datetime(2026, 9, 1, tzinfo=timezone.utc),
        },
        namespace="authfn",
    )
    request = TestRequest(
        "GET",
        "https://account.example.com/auth/session",
        headers={"authorization": "api-key secret_no_scopes"},
    )
    context = await setup.issuer.derive(request)
    assert context.actor_type == "api-key"
    assert context.scopes is None
    signed = await setup.issuer.issue_signed(request)
    encoded = signed["assertion"].split(".", 1)[0]
    padding = "=" * ((4 - len(encoded) % 4) % 4)
    payload = json.loads(base64.urlsafe_b64decode(encoded + padding))
    assert "scopes" not in payload


@pytest.mark.asyncio
async def test_awaits_async_identity_key_resolver() -> None:
    async def resolve(user_id: str) -> str:
        return f"person:{user_id}"

    setup = await _setup(identity_key_for_user_id=resolve)
    context = await setup.issuer.derive(setup.request)
    assert context.home_region == "us-east-1"
    assert context.placement_epoch == 4


@pytest.mark.asyncio
async def test_rejects_explicitly_empty_audience() -> None:
    setup = await _setup()
    with pytest.raises(ValidationError):
        await setup.issuer.derive(setup.request, audience="")
    signed = await setup.issuer.issue_signed(setup.request)
    with pytest.raises(PlacementContextInvalidError):
        setup.issuer.verify_signed(signed["assertion"], audience="")


@pytest.mark.asyncio
async def test_canonicalizes_idn_authority_to_punycode() -> None:
    setup = await _setup(public_authority="https://münich.example")
    context = await setup.issuer.derive(setup.request)
    assert context.issuer == "https://xn--mnich-kva.example"
    assert _normalize_authority("https://faß.de") == "https://xn--fa-hia.de"
    assert _normalize_authority("https://xn--fa-hia.de") == "https://xn--fa-hia.de"
    assert _normalize_authority("https://auth_service.example") == "https://auth_service.example"
    assert _normalize_authority("https://-edge.example") == "https://-edge.example"
    assert _normalize_authority("https://AUTH_SERVICE.EXAMPLE") == "https://auth_service.example"
    assert (
        _normalize_authority("https://auth_service.münich.example")
        == "https://auth_service.xn--mnich-kva.example"
    )
    assert _normalize_authority("http://AUTH_SERVICE.example:80") == "http://auth_service.example"
    assert _normalize_authority("https://-é.example") == "https://xn----bga.example"
    assert _normalize_authority("https://é-.example") == "https://xn----9fa.example"
    assert (
        _normalize_authority("https://" + ("é" * 64) + ".example")
        == "https://xn--9caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.example"
    )


def test_rejects_out_of_range_authority_ports_as_config_error() -> None:
    with pytest.raises(ConfigError):
        _normalize_authority("https://example.com:99999")
    with pytest.raises(ConfigError):
        _normalize_authority("https://example.com:65536")
    with pytest.raises(ConfigError):
        _normalize_authority("https://example.com:abc")
    with pytest.raises(ConfigError):
        _normalize_authority("https://[::1")
    with pytest.raises(ConfigError):
        _normalize_authority("https://[::1]:99999")
    assert _normalize_authority("https://example.com:65535") == "https://example.com:65535"
    assert _normalize_authority("https://example.com:0") == "https://example.com:0"


def test_treats_special_scheme_backslashes_as_path_separators() -> None:
    assert (
        _normalize_authority(r"https://account.example.com\@evil.example")
        == "https://account.example.com"
    )
    assert (
        _normalize_authority(r"https://account.example.com:8443\@evil.example")
        == "https://account.example.com:8443"
    )
    assert _normalize_authority(r"https://[::1]\@evil.example") == "https://[::1]"


def test_canonicalizes_slashless_special_scheme_authorities() -> None:
    assert _normalize_authority("https:account.example.com") == "https://account.example.com"
    assert _normalize_authority("https:/account.example.com") == "https://account.example.com"
    assert _normalize_authority("https:///account.example.com") == "https://account.example.com"
    assert (
        _normalize_authority("https:" + chr(92) + "account.example.com")
        == "https://account.example.com"
    )
    assert (
        _normalize_authority("https:account.example.com:8443")
        == "https://account.example.com:8443"
    )
    assert _normalize_authority("https:/account.example.com:443") == "https://account.example.com"
    assert _normalize_authority("http:account.example.com") == "http://account.example.com"
    assert _normalize_authority("http:/account.example.com:80") == "http://account.example.com"
    assert _normalize_authority("https:[::1]") == "https://[::1]"
    assert _normalize_authority("https:/[::1]") == "https://[::1]"
    assert _normalize_authority("https:127.1") == "https://127.0.0.1"
    with pytest.raises(ConfigError):
        _normalize_authority("https:")
    with pytest.raises(ConfigError):
        _normalize_authority("https:/")
    assert _normalize_authority("ftp:account.example.com") == "ftp://account.example.com"
    assert _normalize_authority("ws:account.example.com") == "ws://account.example.com"
    assert _normalize_authority("wss:/account.example.com") == "wss://account.example.com"
    assert (
        _normalize_authority("ftp://account.example.com" + chr(92) + "@evil.example")
        == "ftp://account.example.com"
    )
    assert (
        _normalize_authority("wss://account.example.com" + chr(92) + "@evil.example")
        == "wss://account.example.com"
    )


def test_rejects_idna_joiner_labels_like_whatwg_origin() -> None:
    with pytest.raises(ConfigError):
        _normalize_authority("https://a\u200db.example")
    with pytest.raises(ConfigError):
        _normalize_authority("https://a\u200cb.example")


def test_rejects_compound_idna_failures_like_whatwg_origin() -> None:
    with pytest.raises(ConfigError):
        _normalize_authority("https://-a\u200db.example")
    with pytest.raises(ConfigError):
        _normalize_authority("https://-a\u200cb.example")
    with pytest.raises(ConfigError):
        _normalize_authority("https://-\u05d0a.example")
    with pytest.raises(ConfigError):
        _normalize_authority("https://\u05d0-.example")
    assert _normalize_authority("https://-\u05d0.example") == "https://xn----0hc.example"
    assert _normalize_authority("https://-é.example") == "https://xn----bga.example"
    assert _normalize_authority("https://é-.example") == "https://xn----9fa.example"
    assert _normalize_authority("https://-a·b.example") == "https://xn---ab-mga.example"
    assert _normalize_authority("https://-͵a.example") == "https://xn---a-63b.example"
    assert _normalize_authority("https://-a・.example") == "https://xn---a-4n4a.example"
    assert _normalize_authority("https://a·b.example") == "https://xn--ab-0ea.example"
    assert _normalize_authority("https://͵a.example") == "https://xn--a-jib.example"
    assert _normalize_authority("https://a・.example") == "https://xn--a-iju.example"
    assert _normalize_authority("https://☃.net") == "https://xn--n3h.net"
    assert _normalize_authority("https://💩.example") == "https://xn--ls8h.example"
    assert _normalize_authority("https://a\u0661.example") == "https://xn--a-bqc.example"
    assert _normalize_authority("https://a\u05d0.example") == "https://xn--a-0hc.example"
    assert _normalize_authority("https://a1\u0661.example") == "https://xn--a1-cyd.example"
    with pytest.raises(ConfigError):
        _normalize_authority("https://1a\u05d0.example")
    with pytest.raises(ConfigError):
        _normalize_authority("https://-a\u05d0.example")
    with pytest.raises(ConfigError):
        _normalize_authority("https://a\u0661\u0661.example")
    with pytest.raises(ConfigError):
        _normalize_authority("https://a\u06611.example")
    with pytest.raises(ConfigError):
        _normalize_authority("https://-\u05d0!.example")
    with pytest.raises(ConfigError):
        _normalize_authority("https://-\u0661\u06f2.example")
    assert _normalize_authority("https://-\u05d0\u05b0.example") == "https://xn----6fc9g.example"
    assert _normalize_authority("https://xn----6fc9g.example") == "https://xn----6fc9g.example"


def test_rejects_malformed_ace_labels_like_whatwg_origin() -> None:
    with pytest.raises(ConfigError):
        _normalize_authority("https://xn--a.example")
    with pytest.raises(ConfigError):
        _normalize_authority("https://xn--.example")
    with pytest.raises(ConfigError):
        _normalize_authority("https://xn---.example")
    with pytest.raises(ConfigError):
        _normalize_authority("https://xn---a.example")
    with pytest.raises(ConfigError):
        _normalize_authority("https://xn--1ug.example")
    with pytest.raises(ConfigError):
        _normalize_authority("https://xn--123.example")
    assert _normalize_authority("https://xn--a-.example") == "https://xn--a-.example"
    assert _normalize_authority("https://xn--n3h.example") == "https://xn--n3h.example"
    assert _normalize_authority("https://XN--N3H.example") == "https://xn--n3h.example"
    assert _normalize_authority("https://foo_bar.example") == "https://foo_bar.example"


def test_omits_default_ports_for_special_schemes() -> None:
    assert _normalize_authority("ftp://example.com:21") == "ftp://example.com"
    assert _normalize_authority("ws://example.com:80") == "ws://example.com"
    assert _normalize_authority("wss://example.com:443") == "wss://example.com"
    assert _normalize_authority("ftp://example.com:2121") == "ftp://example.com:2121"
    assert _normalize_authority("ws://example.com:8080") == "ws://example.com:8080"
    assert _normalize_authority("wss://example.com:8443") == "wss://example.com:8443"


def test_rejects_opaque_url_origins() -> None:
    with pytest.raises(ConfigError):
        _normalize_authority("file://auth.example")
    with pytest.raises(ConfigError):
        _normalize_authority("mailto:auth@example.com")
    with pytest.raises(ConfigError):
        _normalize_authority("data:text/plain,hello")
    with pytest.raises(ConfigError):
        _normalize_authority("custom://example.com")
    with pytest.raises(ConfigError):
        _normalize_authority("blob:https://account.example.com")


def test_strips_surrounding_c0_and_space_from_authorities() -> None:
    assert _normalize_authority("https://account.example.com ") == "https://account.example.com"
    assert _normalize_authority(" https://account.example.com") == "https://account.example.com"
    assert _normalize_authority("https://account.example.com\t") == "https://account.example.com"


def test_canonicalizes_ipv4_authorities_like_whatwg_origin() -> None:
    assert _normalize_authority("https://127.1") == "https://127.0.0.1"
    assert _normalize_authority("https://0x") == "https://0.0.0.0"
    assert _normalize_authority("https://1.0x") == "https://1.0.0.0"
    assert _normalize_authority("https://0x7f.1") == "https://127.0.0.1"
    assert _normalize_authority("https://0177.0.0.1") == "https://127.0.0.1"
    assert _normalize_authority("https://2130706433") == "https://127.0.0.1"
    assert _normalize_authority("https://127.1:8443") == "https://127.0.0.1:8443"
    assert _normalize_authority("http://127.1:80") == "http://127.0.0.1"
    with pytest.raises(ConfigError):
        _normalize_authority("https://08.0.0.1")
    with pytest.raises(ConfigError):
        _normalize_authority("https://hello.1")
    with pytest.raises(ConfigError):
        _normalize_authority("https://example.09")
    with pytest.raises(ConfigError):
        _normalize_authority("https://example.0x")
    assert _normalize_authority("https://example.0xg") == "https://example.0xg"
    assert _normalize_authority("https://0.0.0.1_0") == "https://0.0.0.1_0"
    assert _normalize_authority("https://0.0.0.+1") == "https://0.0.0.+1"


def test_canonicalizes_ipv6_authorities_like_whatwg_origin() -> None:
    assert _normalize_authority("https://[2001:0db8:0:0:0:0:0:1]") == "https://[2001:db8::1]"
    assert _normalize_authority("https://[0:0:0:0:0:0:0:1]") == "https://[::1]"
    assert _normalize_authority("https://[::ffff:127.0.0.1]") == "https://[::ffff:7f00:1]"
    assert _normalize_authority("https://[2001:0DB8::1]:8443") == "https://[2001:db8::1]:8443"
    with pytest.raises(ConfigError):
        _normalize_authority("https://[::%31]")
    with pytest.raises(ConfigError):
        _normalize_authority("https://[fe80::1%25eth0]")


def test_canonicalizes_percent_encoded_hosts_like_whatwg_origin() -> None:
    assert _normalize_authority("https://%65xample.com") == "https://example.com"
    assert _normalize_authority("https://ex%61mple.com") == "https://example.com"
    assert _normalize_authority("https://%31%32%37.0.0.1") == "https://127.0.0.1"
    assert _normalize_authority("https://%e4%b8%ad.com") == "https://xn--fiq.com"
    assert _normalize_authority("http://%65xample.com:80") == "http://example.com"
    assert _normalize_authority("https://%65xample.com:8443") == "https://example.com:8443"
    with pytest.raises(ConfigError):
        _normalize_authority("https://%2565xample.com")
    with pytest.raises(ConfigError):
        _normalize_authority("https://%00example.com")


def test_canonicalizes_timestamps_like_javascript_to_iso_string() -> None:
    assert _isoformat(datetime(2026, 8, 1, tzinfo=timezone.utc)) == "2026-08-01T00:00:00.000Z"
    assert _isoformat("2026-08-01T00:00:00Z") == "2026-08-01T00:00:00.000Z"
    assert _isoformat(datetime(2026, 8, 1, 0, 0, 0, 123000, tzinfo=timezone.utc)) == "2026-08-01T00:00:00.123Z"


def test_treats_naive_credential_expiry_as_utc() -> None:
    naive = datetime(2026, 1, 1, 0, 0, 0)
    aware = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
    now = aware.timestamp() + 1
    assert _credential_expired(naive, lambda: now) is True
    assert _credential_expired(aware, lambda: now) is True
    assert _credential_expired(naive, lambda: now) is _credential_expired(aware, lambda: now)


@pytest.mark.asyncio
async def test_evaluates_cookie_and_bearer_expiry_against_issuer_clock() -> None:
    expires_at = datetime.now(timezone.utc) - timedelta(seconds=60)
    issuer_now = (expires_at - timedelta(seconds=60)).timestamp()
    setup = await _setup(clock=lambda: issuer_now)
    await setup.config.database.update(
        model="sessions",
        where=[{"field": "id", "operator": "eq", "value": setup.issued["record"]["id"]}],
        data={"expiresAt": expires_at},
        namespace="authfn",
    )
    cookie_context = await setup.issuer.derive(setup.request)
    bearer_context = await setup.issuer.derive(
        TestRequest(
            "GET",
            "https://account.example.com/auth/session",
            headers={"authorization": f"Bearer {setup.issued['sessionToken']}"},
        )
    )
    assert cookie_context.home_region == "us-east-1"
    assert bearer_context.session_binding == cookie_context.session_binding


@pytest.mark.asyncio
async def test_keeps_subsecond_session_expiry_when_capping_ttl() -> None:
    issued_at = datetime(2026, 9, 4, 12, 0, 10, 100000, tzinfo=timezone.utc)
    session_expires_at = datetime(2026, 9, 4, 12, 0, 10, 800000, tzinfo=timezone.utc)
    setup = await _setup(clock=lambda: issued_at.timestamp())
    await setup.config.database.update(
        model="sessions",
        where=[{"field": "id", "operator": "eq", "value": setup.issued["record"]["id"]}],
        data={"expiresAt": session_expires_at},
        namespace="authfn",
    )
    context = await setup.issuer.derive(setup.request)
    assert context.issued_at == "2026-09-04T12:00:10.100Z"
    assert context.expires_at == "2026-09-04T12:00:10.800Z"


@pytest.mark.asyncio
async def test_keeps_signed_request_id_on_post_signature_verification_failure() -> None:
    events: List[Any] = []
    setup = await _setup(on_event=events.append)
    signed = await setup.issuer.issue_signed(setup.request)
    with pytest.raises(PlacementContextInvalidError):
        setup.issuer.verify_signed(signed["assertion"], audience="other-service")
    failed = [
        event
        for event in events
        if (getattr(event, "type", None) or event.get("type")) == "authfn.placement_context.verification_failed"
    ]
    assert failed
    assert (getattr(failed[-1], "requestId", None) or failed[-1].get("requestId")) == signed["context"].request_id


def test_rejects_fractional_and_boolean_ttl() -> None:
    config = AuthFnConfig.model_validate(
        {"database": InMemoryDatabaseAdapter(), "namespace": "authfn", "plugins": []}
    )
    directory = InMemoryIdentityPlacementDirectory()
    kwargs = {
        "region_id": "us-east-1",
        "config": config,
        "subject_secret": SUBJECT_SECRET,
        "audiences": ["nucleum-datafn"],
        "public_authority": "https://account.example.com",
        "placement_directory": directory,
        "identity_key_for_user_id": lambda user_id: f"person:{user_id}",
    }
    with pytest.raises(ConfigError):
        create_placement_context_issuer(**kwargs, ttl_seconds=1.5)
    with pytest.raises(ConfigError):
        create_placement_context_issuer(**kwargs, ttl_seconds=True)
    with pytest.raises(ConfigError):
        create_placement_context_issuer(**kwargs, clock_skew_seconds=2.5)


async def _setup(
    *,
    region_id: str = "us-east-1",
    extra_headers: Optional[Dict[str, str]] = None,
    placement: Optional[IdentityPlacement] = None,
    identity_key: Optional[str] = None,
    identity_key_for_user_id: Optional[Any] = None,
    skip_placement: bool = False,
    on_event: Optional[Any] = None,
    public_authority: str = "https://account.example.com",
    directory: Optional[Any] = None,
    clock: Optional[Any] = None,
) -> _Setup:
    config = AuthFnConfig.model_validate(
        {
            "database": InMemoryDatabaseAdapter(),
            "namespace": "authfn",
            "plugins": [],
            "observability": {"emit": on_event} if on_event is not None else None,
        }
    )
    user = {
        "id": "user_ada",
        "primaryEmail": "ada@example.com",
        "createdAt": datetime.now(timezone.utc),
        "updatedAt": datetime.now(timezone.utc),
    }
    await config.database.create(model="users", data=user, namespace="authfn")
    resolved_key = identity_key or f"person:{user['id']}"
    records: List[IdentityPlacement] = []
    if not skip_placement:
        records.append(
            placement
            or IdentityPlacement(
                identity_key=resolved_key,
                region_id="us-east-1",
                epoch=4,
                state="active",
                updated_at="2026-09-04T00:00:00.000Z",
            )
        )
    resolved_directory = directory or InMemoryIdentityPlacementDirectory(records)
    issued = await issue_session(
        config,
        TestRequest("GET", "https://account.example.com/auth/session"),
        user=user,
        methods=["password"],
    )
    cookie_header = "; ".join(
        f"{cookie.name}={cookie.value}" for cookie in issued["cookies"]
    )
    request = TestRequest(
        "GET",
        "https://account.example.com/auth/session",
        headers={
            "cookie": cookie_header,
            "x-session-id": issued["record"]["id"],
            **(extra_headers or {}),
        },
    )
    issuer = create_placement_context_issuer(
        config=config,
        region_id=region_id,
        subject_secret=SUBJECT_SECRET,
        audiences=["nucleum-datafn"],
        public_authority=public_authority,
        placement_directory=resolved_directory,
        identity_key_for_user_id=identity_key_for_user_id
        or (lambda user_id: identity_key or f"person:{user_id}"),
        keyring=KEYRING,
        on_event=on_event,
        **({"clock": clock} if clock is not None else {}),
    )
    return _Setup(
        issuer=issuer,
        request=request,
        user=user,
        issued=issued,
        config=config,
        directory=resolved_directory,
    )
