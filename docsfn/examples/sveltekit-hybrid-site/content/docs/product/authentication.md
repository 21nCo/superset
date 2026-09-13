---
title: Authentication
description: A second page in the same docs section to prove pagination and shared sidebar behavior.
---

# Authentication

Use workspace-scoped API keys for server traffic and short-lived session tokens for browser traffic.

## Token model

- Server integrations use long-lived keys.
- Browser sessions use temporary tokens minted by your backend.
- Rotating a key invalidates new requests immediately.
