"""Schema helpers for the Python billfn SDK."""

from __future__ import annotations

from typing import Any, Dict, List

BILLFN_SCHEMA_VERSION = 3


def get_schema() -> Dict[str, Any]:
    billing_accounts: Dict[str, Any] = {
        "modelName": "billingAccounts",
        "fields": {
            "id": {"type": "string", "required": True, "unique": True},
            "ownerType": {"type": "string", "required": True},
            "ownerId": {"type": "string", "required": True},
            "currency": {"type": "string", "required": False},
            "region": {"type": "string", "required": False},
            "metadata": {"type": "json", "required": False},
            "createdAt": {"type": "string", "required": True},
            "updatedAt": {"type": "string", "required": True},
        },
    }

    subscriptions: Dict[str, Any] = {
        "modelName": "subscriptions",
        "fields": {
            "id": {"type": "string", "required": True, "unique": True},
            "billingAccountId": {"type": "string", "required": True},
            "planKey": {"type": "string", "required": True},
            "priceId": {"type": "string", "required": True},
            "provider": {"type": "string", "required": True},
            "providerSubscriptionId": {"type": "string", "required": False},
            "providerCheckoutId": {"type": "string", "required": False},
            "providerChargeId": {"type": "string", "required": False},
            "status": {"type": "string", "required": True},
            "currentPeriodStart": {"type": "string", "required": False},
            "currentPeriodEnd": {"type": "string", "required": False},
            "cancelAt": {"type": "string", "required": False},
            "canceledAt": {"type": "string", "required": False},
            "trialEnd": {"type": "string", "required": False},
            "autoRenew": {"type": "boolean", "required": True},
            "metadata": {"type": "json", "required": False},
            "createdAt": {"type": "string", "required": True},
            "updatedAt": {"type": "string", "required": True},
        },
        "indexes": [
            {"name": "subscriptions_billing_account_updated_idx", "fields": ["billingAccountId", "updatedAt"]},
            {
                "name": "subscriptions_provider_subscription_idx",
                "fields": ["provider", "providerSubscriptionId"],
                "unique": True,
            },
            {
                "name": "subscriptions_provider_charge_idx",
                "fields": ["provider", "providerChargeId"],
                "unique": True,
            },
        ],
    }

    checkout_sessions: Dict[str, Any] = {
        "modelName": "checkoutSessions",
        "fields": {
            "checkoutSessionId": {"type": "string", "required": True, "unique": True},
            "billingAccountId": {"type": "string", "required": True},
            "planKey": {"type": "string", "required": True},
            "priceId": {"type": "string", "required": True},
            "provider": {"type": "string", "required": True},
            "providerCheckoutId": {"type": "string", "required": False},
            "providerSubscriptionId": {"type": "string", "required": False},
            "providerChargeId": {"type": "string", "required": False},
            "status": {"type": "string", "required": True},
            "checkoutUrl": {"type": "string", "required": False},
            "clientAction": {"type": "json", "required": False},
            "metadata": {"type": "json", "required": False},
            "createdAt": {"type": "string", "required": True},
            "updatedAt": {"type": "string", "required": True},
        },
        "indexes": [
            {"name": "checkout_sessions_billing_account_idx", "fields": ["billingAccountId", "updatedAt"]},
            {"name": "checkout_sessions_provider_checkout_idx", "fields": ["provider", "providerCheckoutId"]},
            {"name": "checkout_sessions_provider_subscription_idx", "fields": ["provider", "providerSubscriptionId"]},
            {"name": "checkout_sessions_provider_charge_idx", "fields": ["provider", "providerChargeId"]},
        ],
    }

    entitlement_snapshots: Dict[str, Any] = {
        "modelName": "entitlementSnapshots",
        "fields": {
            "id": {"type": "string", "required": True, "unique": True},
            "billingAccountId": {"type": "string", "required": True},
            "planKey": {"type": "string", "required": True},
            "status": {"type": "string", "required": True},
            "features": {"type": "json", "required": True},
            "limits": {"type": "json", "required": True},
            "effectiveAt": {"type": "string", "required": True},
            "expiresAt": {"type": "string", "required": False},
            "sourceEventId": {"type": "string", "required": False},
            "createdAt": {"type": "string", "required": True},
            "updatedAt": {"type": "string", "required": True},
        },
        "indexes": [
            {"name": "entitlements_billing_account_idx", "fields": ["billingAccountId"], "unique": True},
        ],
    }

    usage_meters: Dict[str, Any] = {
        "modelName": "usageMeters",
        "fields": {
            "id": {"type": "string", "required": True, "unique": True},
            "billingAccountId": {"type": "string", "required": True},
            "resource": {"type": "string", "required": True},
            "current": {"type": "number", "required": True},
            "updatedAt": {"type": "string", "required": True},
        },
        "indexes": [
            {"name": "usage_meters_billing_account_resource_idx", "fields": ["billingAccountId", "resource"], "unique": True},
        ],
    }

    usage_ledger: Dict[str, Any] = {
        "modelName": "usageLedger",
        "fields": {
            "id": {"type": "string", "required": True, "unique": True},
            "billingAccountId": {"type": "string", "required": True},
            "resource": {"type": "string", "required": True},
            "amount": {"type": "number", "required": True},
            "createdAt": {"type": "string", "required": True},
        },
    }

    webhook_receipts: Dict[str, Any] = {
        "modelName": "webhookReceipts",
        "fields": {
            "id": {"type": "string", "required": True, "unique": True},
            "provider": {"type": "string", "required": True},
            "providerEventId": {"type": "string", "required": True},
            "eventType": {"type": "string", "required": True},
            "signatureVerified": {"type": "boolean", "required": True},
            "rawPayload": {"type": "json", "required": True},
            "createdAt": {"type": "string", "required": True},
            "processingJobId": {"type": "string", "required": False},
            "processingClaimedAt": {"type": "string", "required": False},
            "processedAt": {"type": "string", "required": False},
        },
        "indexes": [
            {"name": "webhook_receipts_provider_event_idx", "fields": ["provider", "providerEventId"], "unique": True},
        ],
    }

    billing_events: Dict[str, Any] = {
        "modelName": "billingEvents",
        "fields": {
            "id": {"type": "string", "required": True, "unique": True},
            "billingAccountId": {"type": "string", "required": True},
            "type": {"type": "string", "required": True},
            "payload": {"type": "json", "required": True},
            "createdAt": {"type": "string", "required": True},
        },
    }

    refunds: Dict[str, Any] = {
        "modelName": "refunds",
        "fields": {
            "id": {"type": "string", "required": True, "unique": True},
            "billingAccountId": {"type": "string", "required": True},
            "subscriptionId": {"type": "string", "required": False},
            "provider": {"type": "string", "required": True},
            "providerChargeId": {"type": "string", "required": False},
            "providerRefundId": {"type": "string", "required": False},
            "mode": {"type": "string", "required": True},
            "amount": {"type": "number", "required": False},
            "currency": {"type": "string", "required": False},
            "reason": {"type": "string", "required": False},
            "status": {"type": "string", "required": True},
            "operationStatus": {"type": "string", "required": True},
            "metadata": {"type": "json", "required": False},
            "createdAt": {"type": "string", "required": True},
            "updatedAt": {"type": "string", "required": True},
        },
        "indexes": [
            {"name": "refunds_subscription_idx", "fields": ["subscriptionId", "updatedAt"]},
            {"name": "refunds_provider_charge_idx", "fields": ["provider", "providerChargeId"]},
            {
                "name": "refunds_provider_refund_idx",
                "fields": ["provider", "providerRefundId"],
                "unique": True,
            },
        ],
    }

    subscription_change_requests: Dict[str, Any] = {
        "modelName": "subscriptionChangeRequests",
        "fields": {
            "id": {"type": "string", "required": True, "unique": True},
            "billingAccountId": {"type": "string", "required": True},
            "subscriptionId": {"type": "string", "required": True},
            "provider": {"type": "string", "required": True},
            "currentPriceId": {"type": "string", "required": True},
            "targetPriceId": {"type": "string", "required": True},
            "effectiveAt": {"type": "string", "required": True},
            "prorationBehavior": {"type": "string", "required": True},
            "status": {"type": "string", "required": True},
            "operationStatus": {"type": "string", "required": True},
            "clientAction": {"type": "json", "required": False},
            "metadata": {"type": "json", "required": False},
            "createdAt": {"type": "string", "required": True},
            "updatedAt": {"type": "string", "required": True},
        },
        "indexes": [
            {
                "name": "subscription_change_requests_subscription_idx",
                "fields": ["subscriptionId", "updatedAt"],
            }
        ],
    }

    reconciliation_jobs: Dict[str, Any] = {
        "modelName": "reconciliationJobs",
        "fields": {
            "id": {"type": "string", "required": True, "unique": True},
            "kind": {"type": "string", "required": True},
            "status": {"type": "string", "required": True},
            "provider": {"type": "string", "required": False},
            "billingAccountId": {"type": "string", "required": False},
            "subscriptionId": {"type": "string", "required": False},
            "providerEventId": {"type": "string", "required": False},
            "cursor": {"type": "string", "required": False},
            "attempts": {"type": "number", "required": True},
            "error": {"type": "string", "required": False},
            "payload": {"type": "json", "required": False},
            "createdAt": {"type": "string", "required": True},
            "updatedAt": {"type": "string", "required": True},
            "completedAt": {"type": "string", "required": False},
        },
        "indexes": [
            {
                "name": "reconciliation_jobs_kind_status_idx",
                "fields": ["kind", "status", "updatedAt"],
            },
            {
                "name": "reconciliation_jobs_subscription_idx",
                "fields": ["subscriptionId", "updatedAt"],
            },
            {
                "name": "reconciliation_jobs_account_idx",
                "fields": ["billingAccountId", "updatedAt"],
            },
        ],
    }

    reconciliation_cursors: Dict[str, Any] = {
        "modelName": "reconciliationCursors",
        "fields": {
            "id": {"type": "string", "required": True, "unique": True},
            "provider": {"type": "string", "required": True},
            "cursorKey": {"type": "string", "required": True},
            "cursor": {"type": "string", "required": False},
            "updatedAt": {"type": "string", "required": True},
            "metadata": {"type": "json", "required": False},
        },
        "indexes": [
            {
                "name": "reconciliation_cursors_provider_key_idx",
                "fields": ["provider", "cursorKey"],
                "unique": True,
            }
        ],
    }

    schemas: List[Dict[str, Any]] = [
        billing_accounts,
        subscriptions,
        checkout_sessions,
        entitlement_snapshots,
        usage_meters,
        usage_ledger,
        webhook_receipts,
        billing_events,
        refunds,
        subscription_change_requests,
        reconciliation_jobs,
        reconciliation_cursors,
    ]

    return {"version": BILLFN_SCHEMA_VERSION, "schemas": schemas}
