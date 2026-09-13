"""Database helper contract tests for phase 3."""

from datetime import datetime

import pytest
from superfunctions.db import CreateParams, FindManyParams, WhereClause

from sendfn.database.helpers import (
    create_email_transaction,
    find_suppression_list,
    get_email_transaction_by_provider_message_id,
)
from sendfn.database.memory import MemoryAdapter
from sendfn.errors import ValidationError
from sendfn.events.tracker import EventTracker
from sendfn.suppression.manager import SuppressionManager


@pytest.mark.asyncio
async def test_provider_message_lookup_and_event_filters() -> None:
    """Provider-message correlation should support webhook lookup and filtered queries."""
    db = MemoryAdapter()
    tracker = EventTracker(db)
    transaction_id = "00000000-0000-4000-8000-000000000001"

    await create_email_transaction(
        db,
        {
            "id": transaction_id,
            "userId": "user-123",
            "to": "user@example.com",
            "from": "noreply@example.com",
            "subject": "Hello",
            "templateId": None,
            "templateData": None,
            "provider": "aws-ses",
            "providerMessageId": "ses-123",
            "status": "sent",
            "sentAt": datetime(2026, 4, 1, 0, 0, 0),
            "deliveredAt": None,
            "bouncedAt": None,
            "complainedAt": None,
            "metadata": {},
        },
    )
    await create_email_transaction(
        db,
        {
            "id": "00000000-0000-4000-8000-000000000002",
            "userId": "user-999",
            "to": "other@example.com",
            "from": "noreply@example.com",
            "subject": "Hello",
            "templateId": None,
            "templateData": None,
            "provider": "aws-ses",
            "providerMessageId": "ses-999",
            "status": "sent",
            "sentAt": datetime(2026, 4, 1, 0, 0, 0),
            "deliveredAt": None,
            "bouncedAt": None,
            "complainedAt": None,
            "metadata": {},
        },
    )

    await db.create(
        CreateParams(
            model="communication_events",
            data={
                "id": "00000000-0000-4000-8000-000000000010",
                "referenceId": "00000000-0000-4000-8000-000000000002",
                "referenceType": "email",
                "eventType": "delivered",
                "provider": "aws-ses",
                "providerEventId": "ses-999",
                "recipientEmail": "other@example.com",
                "recipientPhone": None,
                "deviceToken": None,
                "metadata": {},
                "eventTimestamp": datetime(2026, 4, 2, 0, 0, 0),
                "createdAt": datetime(2026, 4, 2, 0, 0, 0),
            },
        )
    )
    await db.create(
        CreateParams(
            model="communication_events",
            data={
                "id": "00000000-0000-4000-8000-000000000011",
                "referenceId": transaction_id,
                "referenceType": "email",
                "eventType": "delivered",
                "provider": "aws-ses",
                "providerEventId": "ses-123",
                "recipientEmail": "user@example.com",
                "recipientPhone": None,
                "deviceToken": None,
                "metadata": {},
                "eventTimestamp": datetime(2026, 4, 2, 0, 0, 5),
                "createdAt": datetime(2026, 4, 2, 0, 0, 5),
            },
        )
    )
    await db.create(
        CreateParams(
            model="communication_events",
            data={
                "id": "00000000-0000-4000-8000-000000000012",
                "referenceId": transaction_id,
                "referenceType": "email",
                "eventType": "delivered",
                "provider": "aws-ses",
                "providerEventId": "ses-123",
                "recipientEmail": "user@example.com",
                "recipientPhone": None,
                "deviceToken": None,
                "metadata": {},
                "eventTimestamp": datetime(2026, 4, 3, 0, 0, 0),
                "createdAt": datetime(2026, 4, 3, 0, 0, 0),
            },
        )
    )

    transaction = await get_email_transaction_by_provider_message_id(db, "ses-123")
    events = await tracker.query_events(
        provider_message_id="ses-123",
        provider="aws-ses",
        user_id="user-123",
        start_at=datetime(2026, 4, 1, 0, 0, 0),
        end_at=datetime(2026, 4, 3, 0, 0, 0),
        limit=1,
    )

    assert transaction is not None
    assert str(transaction.id) == transaction_id
    assert [event.reference_id for event in events] == [transaction_id]


@pytest.mark.asyncio
async def test_query_events_uses_default_and_maximum_limits() -> None:
    """Event queries should default to 50 rows and clamp oversized limits to 200."""
    db = MemoryAdapter()
    tracker = EventTracker(db)

    for index in range(250):
        await db.create(
            CreateParams(
                model="communication_events",
                data={
                    "id": f"00000000-0000-4000-8000-{index + 100:012d}",
                    "referenceId": "sms-1",
                    "referenceType": "sms",
                    "eventType": "sent",
                    "provider": "console",
                    "providerEventId": f"provider-{index}",
                    "recipientEmail": None,
                    "recipientPhone": "+12065550100",
                    "deviceToken": None,
                    "metadata": {"index": index},
                    "eventTimestamp": datetime(2026, 4, 1, 0, index % 60, 0),
                    "createdAt": datetime(2026, 4, 1, 0, index % 60, 0),
                },
            )
        )

    default_limited = await tracker.query_events(provider="console")
    max_limited = await tracker.query_events(provider="console", limit=500)

    assert len(default_limited) == 50
    assert len(max_limited) == 200


@pytest.mark.asyncio
async def test_query_events_ignores_malformed_recipient_user_metadata() -> None:
    db = MemoryAdapter()
    tracker = EventTracker(db)
    notification_id = "00000000-0000-4000-8000-000000000020"
    await db.create(
        CreateParams(
            model="push_notifications",
            data={
                "id": notification_id,
                "userId": "owner",
                "providerMessageId": None,
                "metadata": {"recipientUserIds": None},
            },
        )
    )
    await db.create(
        CreateParams(
            model="communication_events",
            data={
                "id": "00000000-0000-4000-8000-000000000021",
                "referenceId": notification_id,
                "referenceType": "push",
                "eventType": "sent",
                "provider": "fcm",
                "providerEventId": None,
                "recipientEmail": None,
                "recipientPhone": None,
                "deviceToken": None,
                "metadata": {},
                "eventTimestamp": datetime(2026, 4, 2, 0, 0, 0),
                "createdAt": datetime(2026, 4, 2, 0, 0, 0),
            },
        )
    )

    assert await tracker.query_events(user_id="other", reference_type="push") == []


@pytest.mark.asyncio
async def test_query_events_rejects_invalid_windows() -> None:
    """Invalid time windows should fail with the shared validation code."""
    tracker = EventTracker(MemoryAdapter())

    with pytest.raises(ValidationError) as exc_info:
        await tracker.query_events(
            start_at=datetime(2026, 4, 3, 0, 0, 0),
            end_at=datetime(2026, 4, 1, 0, 0, 0),
        )

    assert exc_info.value.code == "SENDFN_VALIDATION_ERROR"
    assert str(exc_info.value) == "`startAt` must be earlier than `endAt`"


@pytest.mark.asyncio
async def test_suppression_normalization_export_and_duplicate_bulk_add() -> None:
    """Suppression flows should normalize, sort, remove, and reject duplicate bulk input."""
    db = MemoryAdapter()
    manager = SuppressionManager(db)

    await manager.bulk_add_to_suppression_list(
        [
            {
                "email": " Beta@Example.com ",
                "reason": "manual",
                "source": "admin",
                "bounceType": None,
                "metadata": {},
            },
            {
                "email": " alpha@example.com ",
                "reason": "unsubscribe",
                "source": "user",
                "bounceType": None,
                "metadata": {},
            },
        ]
    )

    entry = await manager.get_suppression_entry("  ALPHA@example.com ")
    exported = await manager.export_suppression_list()

    assert entry is not None
    assert entry.email == "alpha@example.com"
    assert [item.email for item in exported] == ["alpha@example.com", "beta@example.com"]
    assert [item.reason for item in exported] == ["unsubscribe", "manual"]

    bounce = await manager.add_to_suppression_list(
        email="bounce@example.com",
        reason="bounce",
        source="aws-ses",
        bounce_type="Permanent",
    )
    complaint = await manager.add_to_suppression_list(
        email="complaint@example.com",
        reason="complaint",
        source="aws-ses",
    )
    assert bounce.reason == "bounce"
    assert complaint.reason == "complaint"

    await manager.remove_from_suppression_list("  beta@example.com ")
    assert await manager.is_suppressed("BETA@example.com") is False

    with pytest.raises(ValidationError) as exc_info:
        await manager.bulk_add_to_suppression_list(
            [
                {"email": "USER@example.com", "reason": "manual", "source": "admin"},
                {"email": "user@example.com", "reason": "unsubscribe", "source": "user"},
            ]
        )

    assert exc_info.value.code == "SENDFN_VALIDATION_ERROR"
    assert str(exc_info.value) == "Duplicate normalized suppression email in bulk add request"

    entries = await find_suppression_list(db, {})
    assert [item.email for item in entries] == [
        "alpha@example.com",
        "bounce@example.com",
        "complaint@example.com",
        "user@example.com",
    ]


@pytest.mark.asyncio
async def test_bulk_suppression_add_rejects_malformed_entries_with_validation_error() -> None:
    """Malformed bulk suppression rows should raise the shared validation error."""
    manager = SuppressionManager(MemoryAdapter())

    with pytest.raises(ValidationError) as exc_info:
        await manager.bulk_add_to_suppression_list(
            [
                {"email": "user@example.com"},
            ]
        )

    assert exc_info.value.code == "SENDFN_VALIDATION_ERROR"
    assert str(exc_info.value) == "Each bulk suppression entry must include 'email' and 'reason'"

@pytest.mark.asyncio
async def test_memory_adapter_combines_mixed_where_connectors() -> None:
    db = MemoryAdapter()
    for identifier, enabled in [("a", True), ("b", True), ("c", False)]:
        await db.create(CreateParams(model="items", data={"id": identifier, "enabled": enabled}))
    rows = await db.find_many(FindManyParams(model="items", where=[
        WhereClause(field="id", value="a"),
        WhereClause(field="id", value="b", connector="OR"),
        WhereClause(field="enabled", value=True, connector="AND"),
    ]))
    assert sorted(row["id"] for row in rows) == ["a", "b"]
    assert db._matches_where({}, []) is True
