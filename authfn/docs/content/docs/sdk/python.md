---
title: Python SDK
description: The authfn Python kernel — same routes, same envelopes, same OpenAPI as the TypeScript kernel, on FastAPI / Flask / Starlette.
---

# Python SDK

The `authfn` Python package is a port of the Node kernel. It exposes the same `create_authfn` factory, the same plugin set, the same envelopes, and the same OpenAPI document. A client written against a Node authfn server will work against a Python authfn server without modification.

```bash
pip install authfn
# or with framework extras
pip install "authfn[fastapi]"
pip install "authfn[flask]"
pip install "authfn[starlette]"
```

## Mental model

If you've read [Concepts → Architecture](../core-concepts/architecture) for the Node kernel, the Python version is a one-to-one shape:

- `create_authfn(config)` returns an `AuthFnInstance`-shaped object with a `router`, a `provider`, `get_schema()`, and `open_api()`.
- Plugins are descriptor objects produced by factory functions (`authfn_password_plugin()`, `authfn_email_otp_plugin()`, …).
- Hooks are async callables registered under `config.hooks`.
- The router speaks WSGI, ASGI, and a couple of native framework adapters.

## Quick start

```python
from authfn import (
    AuthFnConfig,
    authfn_email_otp_plugin,
    authfn_password_plugin,
    authfn_social_oauth_plugin,
    create_authfn,
)
from authfn.adapters.memory import memory_adapter

auth = create_authfn(AuthFnConfig(
    database=memory_adapter(),
    namespace="authfn",
    plugins=[
        authfn_password_plugin(),
        authfn_email_otp_plugin({
            "delivery": my_delivery_provider,
        }),
        authfn_social_oauth_plugin({
            "providers": {
                "google": {
                    "client_id": GOOGLE_CLIENT_ID,
                    "client_secret": GOOGLE_CLIENT_SECRET,
                    "allowlisted_return_to": ["https://app.example.com/post-auth"],
                },
            },
        }),
    ],
))
```

## Mounting

### FastAPI

```python
from fastapi import FastAPI, Request
from superfunctions_fastapi import to_fastapi

app = FastAPI()
app.include_router(to_fastapi(auth.router), prefix="/auth")

@app.get("/openapi-authfn.json")
async def openapi_authfn():
    return auth.open_api()
```

### Flask

```python
from flask import Flask
from superfunctions_flask import to_flask

app = Flask(__name__)
to_flask(app, auth.router, base_path="/auth")

@app.get("/openapi-authfn.json")
def openapi_authfn():
    return auth.open_api()
```

### Starlette

```python
from starlette.applications import Starlette
from starlette.routing import Route
from superfunctions_starlette import to_starlette

routes = [*to_starlette(auth.router, base_path="/auth")]
app = Starlette(routes=routes)
```

## Reading the session

```python
session = await auth.provider.authenticate(request)
if session is None:
    return Response(status_code=401)
```

`AuthFnSession` mirrors the TypeScript shape: `id`, `actor_id`, `actor_type`, `methods`, `primary_email`, `expires_at`, `metadata`, `region_id`.

## Hooks

```python
async def before_user_create(ctx, payload):
    if is_disposable(payload["primaryEmail"]):
        raise AuthFnValidationError("disposable emails are not allowed")
    return payload

create_authfn(AuthFnConfig(
    # ...
    hooks={
        "before_user_create": before_user_create,
    },
))
```

Hook names use Python's `snake_case`. The behavior matches the Node kernel.

## Adapters

Python's `@superfunctions/db` analogue ships:

- `memory_adapter` (testing).
- `sqlalchemy_adapter` (Postgres / SQLite via SQLAlchemy).
- `drizzle-style` adapter for those who keep schema in TypeScript and run migrations cross-language.

The contract is identical to the Node adapter — see [Adapters → Database](../adapters/database).

## OpenAPI parity

```python
document = auth.open_api()
```

The output is byte-for-byte equivalent to the Node kernel's `auth.openApi()` for the same plugin set. CI diffs them.

## Type stubs

`authfn` ships type stubs (`authfn-stubs`). All public API is typed.

## Cross-language deployments

A common pattern is a Python data-science backend that uses a Node-served authfn for sign-in. As long as both share the same database (and the same `namespace`), they're interchangeable. The session cookie / bearer token works against either.

If you go this route, lock the kernel versions on both sides to versions that share the same wire contract. The [changelog](../reference/changelog) documents wire-contract bumps.

## Placement-bound auth context

Trusted gateway code can derive an immutable routing context after a valid session. This is opt-in and is not a public AuthFn route. See [Placement-bound auth context](../recipes/placement-bound-auth-context).

```python
from authfn import create_placement_context_issuer

issuer = create_placement_context_issuer(
    region_id="us-east-1",  # region owning config.database
    config=config,
    public_authority="https://account.example.com",
    placement_directory=directory,
    identity_key_for_user_id=identity_keys.from_user_id,
    subject_secret=subject_secret,
    audiences=["nucleum-datafn"],
)
context = await issuer.derive(request)
```

## Related

- [Quickstart → Python](../quickstart/python)
- [Frameworks → FastAPI / Flask / Starlette](../frameworks)
- [Adapters → Database](../adapters/database)
- [Recipes → Placement-bound auth context](../recipes/placement-bound-auth-context)
