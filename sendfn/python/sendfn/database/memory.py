"""In-memory database adapter for testing.

This adapter implements the superfunctions.db.Adapter protocol for in-memory storage.
"""

from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import uuid4

from superfunctions.db import (
    AdapterCapabilities,
    CountParams,
    CreateManyParams,
    CreateParams,
    CreateSchemaParams,
    DeleteManyParams,
    DeleteParams,
    FindManyParams,
    FindOneParams,
    HealthStatus,
    Operator,
    SchemaCreation,
    TableSchema,
    UpdateManyParams,
    UpdateParams,
    UpsertParams,
    ValidationResult,
    WhereClause,
)

from ..errors import DatabaseError


class MemoryAdapter:
    """In-memory database adapter for testing sendfn operations.

    Implements the superfunctions.db.Adapter protocol using in-memory dictionaries.
    """

    def __init__(self) -> None:
        """Initialize the memory adapter with empty storage."""
        self.id = "memory"
        self.name = "Memory Adapter"
        self.version = "0.1.0"
        self.capabilities = AdapterCapabilities(
            transactions=False,
            nestedTransactions=False,
            joins=False,
            fullTextSearch=False,
            jsonOperations=True,
            schemaManagement=False,
            migrationSupport=False,
            batchOperations=True,
        )

        # Storage: model_name -> {id -> record}
        self._storage: Dict[str, Dict[str, Dict[str, Any]]] = {}
        self._start_time = datetime.utcnow()

    async def create(self, params: CreateParams) -> Dict[str, Any]:
        """Create a single record."""
        storage = self._get_or_create_storage(params.model)
        record_id = params.data.get("id", str(uuid4()))
        if record_id in storage:
            raise DatabaseError(
                f"Duplicate id `{record_id}` for model `{params.model}`",
                code="SENDFN_UNIQUE_CONSTRAINT",
                retryable=False,
                details={"model": params.model, "id": record_id},
            )
        record = {**params.data, "id": record_id}
        storage[record_id] = record
        return record

    async def find_one(self, params: FindOneParams) -> Optional[Dict[str, Any]]:
        """Find a single record."""
        storage = self._get_or_create_storage(params.model)

        for record in storage.values():
            if self._matches_where(record, params.where):
                return record

        return None

    async def find_many(self, params: FindManyParams) -> List[Dict[str, Any]]:
        """Find multiple records."""
        storage = self._get_or_create_storage(params.model)
        where = params.where or []

        results = [
            record for record in storage.values()
            if self._matches_where(record, where)
        ]

        # Apply ordering
        if params.order_by:
            for order in reversed(params.order_by):
                field = order.field
                reverse = order.direction == "desc"
                results.sort(key=lambda x: x.get(field, ""), reverse=reverse)

        # Apply pagination
        if params.offset is not None:
            results = results[params.offset:]
        if params.limit is not None:
            results = results[:params.limit]

        return results

    async def update(self, params: UpdateParams) -> Dict[str, Any]:
        """Update a single record."""
        storage = self._get_or_create_storage(params.model)

        for record in storage.values():
            if self._matches_where(record, params.where):
                record.update(params.data)
                return record

        raise ValueError("Record not found matching where clause")

    async def delete(self, params: DeleteParams) -> None:
        """Delete a single record."""
        storage = self._get_or_create_storage(params.model)

        for record_id, record in list(storage.items()):
            if self._matches_where(record, params.where):
                del storage[record_id]
                return

        raise ValueError("Record not found matching where clause")

    async def create_many(self, params: CreateManyParams) -> List[Dict[str, Any]]:
        """Create multiple records."""
        storage = self._get_or_create_storage(params.model)
        results: list[dict[str, Any]] = []
        seen_ids: set[str] = set()

        for data in params.data:
            record_id = data.get("id", str(uuid4()))
            if record_id in storage or record_id in seen_ids:
                raise DatabaseError(
                    f"Duplicate id `{record_id}` for model `{params.model}`",
                    code="SENDFN_UNIQUE_CONSTRAINT",
                    retryable=False,
                    details={"model": params.model, "id": record_id},
                )
            seen_ids.add(record_id)
            results.append({**data, "id": record_id})

        for record in results:
            storage[record["id"]] = record

        return results

    async def update_many(self, params: UpdateManyParams) -> int:
        """Update multiple records, returns count."""
        storage = self._get_or_create_storage(params.model)
        count = 0

        for record in storage.values():
            if self._matches_where(record, params.where):
                record.update(params.data)
                count += 1

        return count

    async def delete_many(self, params: DeleteManyParams) -> int:
        """Delete multiple records, returns count."""
        storage = self._get_or_create_storage(params.model)
        count = 0

        for record_id, record in list(storage.items()):
            if self._matches_where(record, params.where):
                del storage[record_id]
                count += 1

        return count

    async def upsert(self, params: UpsertParams) -> Dict[str, Any]:
        """Upsert a record."""
        existing = await self.find_one(
            FindOneParams(model=params.model, where=params.where)
        )

        if existing:
            return await self.update(
                UpdateParams(
                    model=params.model,
                    where=params.where,
                    data=params.update,
                )
            )
        else:
            return await self.create(
                CreateParams(model=params.model, data=params.create)
            )

    async def count(self, params: CountParams) -> int:
        """Count records."""
        storage = self._get_or_create_storage(params.model)
        where = params.where or []

        count = sum(
            1 for record in storage.values()
            if self._matches_where(record, where)
        )

        return count

    async def transaction(self, callback: Any) -> Any:
        """Execute operations within a transaction (not supported in memory adapter)."""
        # Memory adapter doesn't support transactions
        # Just execute the callback directly
        return await callback(self)

    async def initialize(self) -> None:
        """Initialize the adapter."""
        pass

    async def is_healthy(self) -> HealthStatus:
        """Check adapter health."""
        uptime = int((datetime.utcnow() - self._start_time).total_seconds())
        return HealthStatus(
            healthy=True,
            connections={"total": 1, "active": 1},
            lastError=None,
            uptime=uptime,
        )

    async def close(self) -> None:
        """Close the adapter."""
        self._storage.clear()

    async def get_schema_version(self, namespace: str) -> int:
        """Get the current schema version."""
        return 0

    async def set_schema_version(self, namespace: str, version: int) -> None:
        """Set the schema version."""
        pass

    async def validate_schema(self, schema: TableSchema) -> ValidationResult:
        """Validate a schema."""
        return ValidationResult(valid=True)

    async def create_schema(self, params: CreateSchemaParams) -> SchemaCreation:
        """Create database schema."""
        return SchemaCreation(success=True)

    def _get_or_create_storage(self, model: str) -> Dict[str, Dict[str, Any]]:
        """Get or create storage for a model."""
        if model not in self._storage:
            self._storage[model] = {}
        return self._storage[model]

    def _matches_where(self, record: Dict[str, Any], where: List[WhereClause]) -> bool:
        """Combine predicates left-to-right, matching the SQLAlchemy adapter."""
        if not where:
            return True
        matched = self._matches_condition(record, where[0])
        for condition in where[1:]:
            current = self._matches_condition(record, condition)
            matched = (matched or current) if condition.connector == "OR" else (matched and current)
        return matched

    def _matches_condition(self, record: Dict[str, Any], condition: WhereClause) -> bool:
        field = condition.field
        operator = condition.operator
        value = condition.value

        record_value = record.get(field)

        if operator == Operator.EQ or operator == "eq":
            if record_value != value:
                return False
        elif operator == Operator.NE or operator == "ne":
            if record_value == value:
                return False
        elif operator == Operator.GT or operator == "gt":
            if record_value is None or record_value <= value:
                return False
        elif operator == Operator.GTE or operator == "gte":
            if record_value is None or record_value < value:
                return False
        elif operator == Operator.LT or operator == "lt":
            if record_value is None or record_value >= value:
                return False
        elif operator == Operator.LTE or operator == "lte":
            if record_value is None or record_value > value:
                return False
        elif operator == Operator.IN or operator == "in":
            if record_value not in value:
                return False
        elif operator == Operator.CONTAINS or operator == "contains":
            if record_value is None or value not in record_value:
                return False
        return True

    async def clear_all(self) -> None:
        """Clear all data (useful for testing)."""
        self._storage.clear()
