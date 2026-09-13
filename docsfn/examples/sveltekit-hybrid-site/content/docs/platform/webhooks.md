---
title: Webhooks
description: Operational docs for receiving event notifications.
---

# Webhooks

Configure a signed HTTPS endpoint and verify the request signature before accepting the payload.

## Delivery guarantees

- Events are retried with exponential backoff.
- Duplicate deliveries are possible.
- Handlers should be idempotent.
