---
title: Architecture
description: Service layout, data flow, and failure boundaries.
---

# Architecture

The edge tier should be thin, cache-aware, and able to fail independently of the control plane.

## Principles

- Keep state replication explicit
- Push read-heavy paths to the edge
- Keep write coordination centralized when consistency matters
