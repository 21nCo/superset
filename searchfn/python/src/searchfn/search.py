from __future__ import annotations

from collections import defaultdict
from typing import Any

from .utils import DEFAULT_PREFIX, tokenize


def _normalize_limit(limit: int) -> int:
    if isinstance(limit, bool):
        raise ValueError("limit must be a positive integer")  # noqa: TRY004 - bool is an invalid integer value.
    normalized = int(limit)
    if normalized <= 0:
        raise ValueError("limit must be a positive integer")
    return normalized


async def search_index(
    schema: Any,
    db: Any,
    query: str,
    model: str | None = None,
    limit: int = 20,
    table_prefix: str = DEFAULT_PREFIX,
) -> list[dict[str, Any]]:
    del schema
    index_table = f"{table_prefix}index"
    tokens = tokenize(query)
    normalized_limit = _normalize_limit(limit)

    if not tokens:
        return []

    matches: list[dict[str, Any]] = []
    for token in dict.fromkeys(tokens):
        where_clause = [{"field": "term", "operator": "eq", "value": token}]
        if model:
            where_clause.append({"field": "model", "operator": "eq", "value": model})

        token_matches = await db.find_many(index_table, where_clause)
        matches.extend(token_matches)

    scores: dict[str, dict[str, Any]] = defaultdict(lambda: {"score": 0, "matches": set()})
    for match in matches:
        key = f"{match['model']}:{match['recordId']}"
        entry = scores[key]
        if entry["score"] == 0:
            entry["id"] = match["recordId"]
            entry["model"] = match["model"]

        entry["score"] += 1
        entry["matches"].add(match["term"])

    results = [
        {
            "id": entry["id"],
            "model": entry["model"],
            "score": entry["score"],
            "matches": sorted(entry["matches"]),
        }
        for entry in scores.values()
    ]
    results.sort(key=lambda item: (-item["score"], str(item["model"]), str(item["id"])))
    return results[:normalized_limit]
