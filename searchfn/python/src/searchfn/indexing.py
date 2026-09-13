from __future__ import annotations

from typing import Any

from .utils import DEFAULT_PREFIX, get_schema_models, tokenize


def _is_duplicate_error(error: Exception) -> bool:
    message = str(error).lower()
    return (
        "duplicate" in message
        or "unique constraint" in message
        or "already exists" in message
    )


async def _delete_existing_index_rows(
    db: Any,
    index_table: str,
    model_name: str,
    record_id: Any,
) -> None:
    while True:
        existing_rows = await db.find_many(
            index_table,
            [
                {"field": "model", "operator": "eq", "value": model_name},
                {"field": "recordId", "operator": "eq", "value": str(record_id)},
            ],
            limit=200,
        )
        if not existing_rows:
            return

        for row in existing_rows:
            if not isinstance(row, dict):
                continue

            row_id = row.get("id")
            if row_id is not None:
                await db.delete(
                    index_table,
                    [{"field": "id", "operator": "eq", "value": row_id}],
                )
                continue

            delete_where = [
                {"field": "model", "operator": "eq", "value": model_name},
                {"field": "recordId", "operator": "eq", "value": str(record_id)},
            ]
            term = row.get("term")
            field = row.get("field")
            if term is not None:
                delete_where.append({"field": "term", "operator": "eq", "value": term})
            if field is not None:
                delete_where.append({"field": "field", "operator": "eq", "value": field})
            await db.delete(index_table, delete_where)


async def index_data(
    schema: Any,
    db: Any,
    model: str | None = None,
    table_prefix: str = DEFAULT_PREFIX,
) -> dict[str, Any]:
    index_table = f"{table_prefix}index"
    models = get_schema_models(schema)

    target_models = [model] if model else list(models.keys())
    total_indexed = 0
    total_terms = 0

    for model_name in target_models:
        model_def = models.get(model_name)
        if not isinstance(model_def, dict):
            continue

        fields = model_def.get("fields", {})
        if not isinstance(fields, dict):
            continue

        string_fields = [
            name for name, field in fields.items()
            if isinstance(field, dict) and field.get("type") == "string"
        ]
        if not string_fields:
            continue

        records = await db.find_many(model_name, [])

        for record in records:
            if not isinstance(record, dict):
                continue

            record_id = record.get("id")
            if record_id is None:
                continue

            indexed_terms_for_record = 0
            await _delete_existing_index_rows(db, index_table, model_name, record_id)

            for field in string_fields:
                value = record.get(field)
                if not isinstance(value, str):
                    continue

                for token in tokenize(value):
                    try:
                        await db.create(index_table, {
                            "term": token,
                            "model": model_name,
                            "recordId": str(record_id),
                            "field": field,
                        })
                    except Exception as error:
                        if _is_duplicate_error(error):
                            continue
                        raise
                    indexed_terms_for_record += 1

            if indexed_terms_for_record > 0:
                total_indexed += 1
                total_terms += indexed_terms_for_record

    return {
        "totalIndexed": total_indexed,
        "totalTerms": total_terms,
    }
