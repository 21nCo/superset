from typing import Any

from .indexing import index_data
from .search import search_index

MAX_LIMIT = 10_000


def _parse_limit(payload: dict[str, Any]) -> int:
    raw_limit = payload.get("limit", 20)
    if isinstance(raw_limit, bool):
        raise ValueError("Invalid limit")  # noqa: TRY004 - preserve the limit validation error contract.
    try:
        limit = int(raw_limit)
    except (TypeError, ValueError) as error:
        raise ValueError("Invalid limit") from error
    if limit <= 0 or limit > MAX_LIMIT:
        raise ValueError("Invalid limit")
    return limit

def create_searchfn_server(config: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(config, dict):
        raise TypeError("config must be a dict")

    schema = config.get("schema")
    db = config.get("db")
    table_prefix = config.get("table_prefix", "_searchfn_")
    if schema is None:
        raise ValueError("schema is required")
    if db is None:
        raise ValueError("db is required")
    if not isinstance(table_prefix, str) or not table_prefix:
        raise ValueError("table_prefix must be a non-empty string")

    async def index_handler(ctx: Any, payload: Any) -> dict[str, Any]:
        del ctx
        if payload is None:
            payload = {}
        if not isinstance(payload, dict):
            return {"ok": False, "error": "Invalid payload"}

        model = payload.get("model")
        if model is not None and not isinstance(model, str):
            return {"ok": False, "error": "Invalid payload"}

        result = await index_data(schema, db, model, table_prefix)
        return {"ok": True, "result": result}

    async def search_handler(ctx: Any, payload: Any) -> dict[str, Any]:
        del ctx
        if not isinstance(payload, dict):
            return {"ok": False, "error": "Invalid payload"}

        query = payload.get("query")
        model = payload.get("model")
        if model is not None and not isinstance(model, str):
            return {"ok": False, "error": "Invalid payload"}

        if not isinstance(query, str) or not query.strip():
            return {"ok": False, "error": "Missing query"}
        try:
            limit = _parse_limit(payload)
        except ValueError:
            return {"ok": False, "error": "Invalid limit"}

        results = await search_index(schema, db, query, model, limit, table_prefix)
        return {"ok": True, "results": results}

    return {
        "routes": {
            "POST /searchfn/index": index_handler,
            "POST /searchfn/search": search_handler,
        }
    }
