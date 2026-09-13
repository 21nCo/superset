import re
from typing import Any

DEFAULT_PREFIX = "_searchfn_"


def tokenize(text: str) -> list[str]:
    if not text:
        return []
    clean = re.sub(r"[^\w\s]", "", str(text).lower())
    return [token for token in clean.split() if token]


def _coerce_named_models(candidate: Any) -> dict[str, dict[str, Any]]:
    if isinstance(candidate, dict):
        return {
            str(name): value
            for name, value in candidate.items()
            if isinstance(name, str) and isinstance(value, dict)
        }
    if isinstance(candidate, list):
        models: dict[str, dict[str, Any]] = {}
        for item in candidate:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            if isinstance(name, str) and name:
                models[name] = item
        return models
    return {}


def get_schema_models(schema: Any) -> dict[str, dict[str, Any]]:
    if isinstance(schema, dict):
        resources = _coerce_named_models(schema.get("resources"))
        if resources:
            return resources
        models = _coerce_named_models(schema.get("models"))
        if models:
            return models
        return {}

    resources = _coerce_named_models(getattr(schema, "resources", None))
    if resources:
        return resources

    models = _coerce_named_models(getattr(schema, "models", None))
    if models:
        return models

    return {}
