"""SQLAlchemy adapter implementation."""

import inspect
import time
from typing import Any, Callable, Dict, List, Optional

from sqlalchemy import MetaData, Table, and_, delete, func, insert, or_, select, text, update
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError, OperationalError
from superfunctions.db import (
    Adapter,
    AdapterCapabilities,
    ConstraintViolationError,
    CountParams,
    CreateManyParams,
    CreateParams,
    CreateSchemaParams,
    DeleteManyParams,
    DeleteParams,
    DuplicateKeyError,
    FindManyParams,
    FindOneParams,
    HealthStatus,
    NotFoundError,
    Operator,
    QueryFailedError,
    SchemaCreation,
    TableSchema,
    UpdateManyParams,
    UpdateParams,
    UpsertParams,
    ValidationResult,
    WhereClause,
)
from superfunctions.db import AdapterConnectionError as ConnectionError


class SQLAlchemyAdapter:
    """SQLAlchemy adapter for superfunctions.db"""

    def __init__(self, engine: Engine, namespace_prefix: str = ""):
        """
        Initialize SQLAlchemy adapter.

        Args:
            engine: SQLAlchemy Engine
            namespace_prefix: Prefix for table names (for namespacing)
        """
        self.engine = engine
        self.namespace_prefix = namespace_prefix
        self.metadata = MetaData()
        self._start_time = time.time()

        # Metadata
        self.id = "sqlalchemy"
        self.name = "SQLAlchemy Adapter"
        self.version = "0.1.0"
        self.capabilities = AdapterCapabilities(
            transactions=True,
            nestedTransactions=False,
            joins=False,
            fullTextSearch=False,
            jsonOperations=True,
            schemaManagement=False,
            migrationSupport=False,
            batchOperations=True,
        )

    def _get_table_name(self, model: str, namespace: Optional[str] = None) -> str:
        """Get full table name with namespace."""
        parts = [part for part in (self.namespace_prefix, namespace, model) if part]
        return "_".join(parts)

    def _build_where_clause(self, table: Table, where: List[WhereClause]) -> Any:
        """Build SQLAlchemy where clause from WhereClause list."""
        if not where:
            return None

        conditions = []
        for clause in where:
            column = self._get_column(table, clause.field, "where clause")

            if clause.operator == Operator.EQ:
                conditions.append(column == clause.value)
            elif clause.operator == Operator.NE:
                conditions.append(column != clause.value)
            elif clause.operator == Operator.GT:
                conditions.append(column > clause.value)
            elif clause.operator == Operator.GTE:
                conditions.append(column >= clause.value)
            elif clause.operator == Operator.LT:
                conditions.append(column < clause.value)
            elif clause.operator == Operator.LTE:
                conditions.append(column <= clause.value)
            elif clause.operator == Operator.IN:
                conditions.append(column.in_(clause.value))
            elif clause.operator == Operator.NOT_IN:
                conditions.append(column.notin_(clause.value))
            elif clause.operator == Operator.LIKE:
                conditions.append(column.like(clause.value))
            elif clause.operator == Operator.ILIKE:
                conditions.append(column.ilike(clause.value))
            elif clause.operator == Operator.IS_NULL:
                conditions.append(column.is_(None))
            elif clause.operator == Operator.IS_NOT_NULL:
                conditions.append(column.isnot(None))
            elif clause.operator == Operator.CONTAINS:
                conditions.append(column.contains(clause.value))
            elif clause.operator == Operator.STARTS_WITH:
                conditions.append(column.startswith(clause.value))
            elif clause.operator == Operator.ENDS_WITH:
                conditions.append(column.endswith(clause.value))
            else:
                raise QueryFailedError(f"Unsupported operator in where clause: {clause.operator}")

        combined = conditions[0]
        for i in range(1, len(conditions)):
            connector = getattr(where[i], "connector", "AND") or "AND"
            combined = or_(combined, conditions[i]) if connector == "OR" else and_(combined, conditions[i])

        return combined

    def _get_table(self, model: str, namespace: Optional[str] = None) -> Table:
        """Get or reflect table from database."""
        table_name = self._get_table_name(model, namespace)

        if table_name in self.metadata.tables:
            return self.metadata.tables[table_name]

        # Reflect table from database
        return Table(table_name, self.metadata, autoload_with=self.engine)

    def _apply_where(self, query: Any, where_clause: Any) -> Any:
        if where_clause is None:
            return query
        return query.where(where_clause)

    def _get_column(self, table: Table, field: str, context: str) -> Any:
        try:
            return table.c[field]
        except KeyError as exc:
            raise QueryFailedError(f"Unknown field in {context}: {field}") from exc

    def _project_row(self, row: Dict[str, Any], select_fields: Optional[List[str]]) -> Dict[str, Any]:
        if not select_fields:
            return row
        return {field: row.get(field) for field in select_fields}

    def _apply_select(self, table: Table, params: FindOneParams | FindManyParams) -> Any:
        columns = [self._get_column(table, field, "select projection") for field in params.select] if params.select else [table]
        return select(*columns).select_from(table)

    def _build_data_where_clause(self, table: Table, data: Dict[str, Any]) -> Any:
        conditions = [self._get_column(table, key, "data lookup") == value for key, value in data.items() if key in table.c]
        if not conditions:
            return None
        return and_(*conditions) if len(conditions) > 1 else conditions[0]

    def _fetch_one_by_clause(
        self,
        connection: Any,
        table: Table,
        where_clause: Any,
        select_fields: Optional[List[str]] = None,
    ) -> Optional[Dict[str, Any]]:
        if where_clause is None:
            return None

        query = self._apply_where(
            select(*[self._get_column(table, field, "select projection") for field in select_fields]).select_from(table)
            if select_fields
            else select(table),
            where_clause,
        )
        row = connection.execute(query).fetchone()
        return dict(row._mapping) if row else None

    def _fetch_one_by_primary_key(
        self,
        connection: Any,
        table: Table,
        row_data: Dict[str, Any],
        select_fields: Optional[List[str]] = None,
    ) -> Optional[Dict[str, Any]]:
        primary_key_columns = list(table.primary_key.columns)
        if not primary_key_columns:
            return None

        conditions = []
        for column in primary_key_columns:
            value = row_data.get(column.name)
            if value is None:
                return None
            conditions.append(column == value)

        where_clause = and_(*conditions) if len(conditions) > 1 else conditions[0]
        return self._fetch_one_by_clause(connection, table, where_clause, select_fields)

    def _build_primary_key_where_clause(self, table: Table, row_data: Dict[str, Any]) -> Any:
        primary_key_columns = list(table.primary_key.columns)
        if not primary_key_columns:
            return None

        conditions = []
        for column in primary_key_columns:
            value = row_data.get(column.name)
            if value is None:
                return None
            conditions.append(column == value)

        return and_(*conditions) if len(conditions) > 1 else conditions[0]

    def _resolve_target_where_clause(self, table: Table, row_data: Dict[str, Any], fallback_clause: Any) -> Any:
        primary_key_clause = self._build_primary_key_where_clause(table, row_data)
        if primary_key_clause is not None:
            return primary_key_clause

        data_clause = self._build_data_where_clause(table, row_data)
        if data_clause is not None:
            return data_clause

        return fallback_clause

    def _coerce_params(self, param_type: Any, params: Any = None, kwargs: Optional[Dict[str, Any]] = None) -> Any:
        kwargs = kwargs or {}
        if params is not None and kwargs:
            raise TypeError("Pass either a params object or keyword arguments, not both")
        if params is None:
            if not kwargs:
                raise TypeError(f"{param_type.__name__} params are required")
            return param_type(**kwargs)
        if isinstance(params, param_type):
            return params
        if isinstance(params, dict):
            return param_type(**params)
        if hasattr(params, "model_dump"):
            return param_type(**params.model_dump())
        raise TypeError(f"Unsupported params type for {param_type.__name__}")

    async def _create(self, params: CreateParams, connection=None) -> Dict[str, Any]:
        """Create a single record."""
        try:
            table = self._get_table(params.model, params.namespace)
            conn = connection
            if conn is not None:
                result = conn.execute(insert(table).values(**params.data))
                inserted = None
                inserted_primary_key = list(getattr(result, "inserted_primary_key", ()) or [])
                if inserted_primary_key:
                    inserted = self._fetch_one_by_primary_key(
                        conn,
                        table,
                        {
                            column.name: value
                            for column, value in zip(table.primary_key.columns, inserted_primary_key, strict=True)
                        },
                        params.select,
                    )
                if inserted is None:
                    inserted = self._fetch_one_by_clause(
                        conn,
                        table,
                        self._build_data_where_clause(table, params.data),
                        params.select,
                    )
                return inserted if inserted is not None else self._project_row(dict(params.data), params.select)

            with self.engine.begin() as managed_conn:
                return await self._create(params, managed_conn)

        except IntegrityError as e:
            if "unique" in str(e).lower() or "duplicate" in str(e).lower():
                raise DuplicateKeyError(str(e), cause=e)
            raise ConstraintViolationError(str(e), cause=e)
        except OperationalError as e:
            raise ConnectionError(str(e), cause=e)
        except (DuplicateKeyError, ConstraintViolationError, ConnectionError, QueryFailedError):
            raise
        except Exception as e:
            raise QueryFailedError(f"Create failed: {str(e)}", cause=e)

    async def create(self, params: Optional[CreateParams] = None, **kwargs: Any) -> Dict[str, Any]:
        return await self._create(self._coerce_params(CreateParams, params, kwargs))

    async def _find_one(self, params: FindOneParams, connection=None) -> Optional[Dict[str, Any]]:
        """Find a single record."""
        try:
            table = self._get_table(params.model, params.namespace)
            where_clause = self._build_where_clause(table, params.where) if params.where else None
            query = self._apply_where(self._apply_select(table, params), where_clause)

            conn = connection
            if conn is not None:
                row = conn.execute(query).fetchone()
                return dict(row._mapping) if row else None

            with self.engine.connect() as managed_conn:
                return await self._find_one(params, managed_conn)
        except OperationalError as e:
            raise ConnectionError(str(e), cause=e)
        except (ConnectionError, QueryFailedError):
            raise
        except Exception as e:
            raise QueryFailedError(f"FindOne failed: {str(e)}", cause=e)

    async def find_one(self, params: Optional[FindOneParams] = None, **kwargs: Any) -> Optional[Dict[str, Any]]:
        return await self._find_one(self._coerce_params(FindOneParams, params, kwargs))

    async def _find_many(self, params: FindManyParams, connection=None) -> List[Dict[str, Any]]:
        """Find multiple records."""
        try:
            table = self._get_table(params.model, params.namespace)
            where_clause = self._build_where_clause(table, params.where) if params.where else None
            query = self._apply_where(self._apply_select(table, params), where_clause)

            if params.order_by:
                for order in params.order_by:
                    column = self._get_column(table, order.field, "order by")
                    query = query.order_by(column.desc() if order.direction == "desc" else column)

            if params.limit is not None:
                query = query.limit(params.limit)

            if params.offset is not None:
                query = query.offset(params.offset)

            conn = connection
            if conn is not None:
                result = conn.execute(query)
                return [dict(row._mapping) for row in result.fetchall()]

            with self.engine.connect() as managed_conn:
                return await self._find_many(params, managed_conn)
        except OperationalError as e:
            raise ConnectionError(str(e), cause=e)
        except (ConnectionError, QueryFailedError):
            raise
        except Exception as e:
            raise QueryFailedError(f"FindMany failed: {str(e)}", cause=e)

    async def find_many(self, params: Optional[FindManyParams] = None, **kwargs: Any) -> List[Dict[str, Any]]:
        return await self._find_many(self._coerce_params(FindManyParams, params, kwargs))

    async def _update(self, params: UpdateParams, connection=None) -> Dict[str, Any]:
        """Update a single record."""
        try:
            table = self._get_table(params.model, params.namespace)
            where_clause = self._build_where_clause(table, params.where)

            conn = connection
            if conn is not None:
                existing = self._fetch_one_by_clause(conn, table, where_clause)
                if existing is None:
                    raise NotFoundError("Record not found for update")
                target_where_clause = self._resolve_target_where_clause(table, existing, where_clause)
                conn.execute(update(table).where(target_where_clause).values(**params.data))
                updated_row = {**existing, **params.data}
                refreshed = self._fetch_one_by_primary_key(conn, table, updated_row, params.select)
                if refreshed is not None:
                    return refreshed
                return self._project_row(updated_row, params.select)

            with self.engine.begin() as managed_conn:
                return await self._update(params, managed_conn)

        except NotFoundError:
            raise
        except IntegrityError as e:
            raise ConstraintViolationError(str(e), cause=e)
        except OperationalError as e:
            raise ConnectionError(str(e), cause=e)
        except (ConstraintViolationError, ConnectionError, QueryFailedError):
            raise
        except Exception as e:
            raise QueryFailedError(f"Update failed: {str(e)}", cause=e)

    async def update(self, params: Optional[UpdateParams] = None, **kwargs: Any) -> Dict[str, Any]:
        return await self._update(self._coerce_params(UpdateParams, params, kwargs))

    async def _delete(self, params: DeleteParams, connection=None) -> None:
        """Delete a single record."""
        try:
            table = self._get_table(params.model, params.namespace)
            where_clause = self._build_where_clause(table, params.where)

            conn = connection
            if conn is not None:
                existing = self._fetch_one_by_clause(conn, table, where_clause)
                if existing is None:
                    raise NotFoundError("Record not found for deletion")
                target_where_clause = self._resolve_target_where_clause(table, existing, where_clause)
                result = conn.execute(delete(table).where(target_where_clause))
                if result.rowcount == 0:
                    raise NotFoundError("Record not found for deletion")

            else:
                with self.engine.begin() as managed_conn:
                    await self._delete(params, managed_conn)

        except NotFoundError:
            raise
        except IntegrityError as e:
            raise ConstraintViolationError(str(e), cause=e)
        except OperationalError as e:
            raise ConnectionError(str(e), cause=e)
        except (ConstraintViolationError, ConnectionError, QueryFailedError):
            raise
        except Exception as e:
            raise QueryFailedError(f"Delete failed: {str(e)}", cause=e)

    async def delete(self, params: Optional[DeleteParams] = None, **kwargs: Any) -> None:
        await self._delete(self._coerce_params(DeleteParams, params, kwargs))

    async def create_many(self, params: Optional[CreateManyParams] = None, **kwargs: Any) -> List[Dict[str, Any]]:
        """Create multiple records."""
        normalized = self._coerce_params(CreateManyParams, params, kwargs)
        try:
            with self.engine.begin() as conn:
                created_rows: List[Dict[str, Any]] = []
                for row in normalized.data:
                    created_rows.append(
                        await self._create(
                            CreateParams(
                                model=normalized.model,
                                data=row,
                                select=normalized.select,
                                namespace=normalized.namespace,
                            ),
                            conn,
                        )
                    )
                return created_rows

        except (DuplicateKeyError, ConstraintViolationError, ConnectionError, QueryFailedError):
            raise
        except IntegrityError as e:
            raise ConstraintViolationError(str(e), cause=e)
        except OperationalError as e:
            raise ConnectionError(str(e), cause=e)
        except Exception as e:
            raise QueryFailedError(f"CreateMany failed: {str(e)}", cause=e)

    async def update_many(self, params: Optional[UpdateManyParams] = None, **kwargs: Any) -> int:
        """Update multiple records."""
        normalized = self._coerce_params(UpdateManyParams, params, kwargs)
        try:
            table = self._get_table(normalized.model, normalized.namespace)
            where_clause = self._build_where_clause(table, normalized.where)
            if where_clause is None:
                raise QueryFailedError("UpdateMany failed: update_many requires a where clause")

            with self.engine.begin() as conn:
                result = conn.execute(update(table).where(where_clause).values(**normalized.data))
                return result.rowcount

        except QueryFailedError:
            raise
        except IntegrityError as e:
            raise ConstraintViolationError(str(e), cause=e)
        except OperationalError as e:
            raise ConnectionError(str(e), cause=e)
        except Exception as e:
            raise QueryFailedError(f"UpdateMany failed: {str(e)}", cause=e)

    async def delete_many(self, params: Optional[DeleteManyParams] = None, **kwargs: Any) -> int:
        """Delete multiple records."""
        normalized = self._coerce_params(DeleteManyParams, params, kwargs)
        try:
            table = self._get_table(normalized.model, normalized.namespace)
            where_clause = self._build_where_clause(table, normalized.where)
            if where_clause is None:
                raise QueryFailedError("DeleteMany failed: delete_many requires a where clause")

            with self.engine.begin() as conn:
                result = conn.execute(delete(table).where(where_clause))
                return result.rowcount

        except QueryFailedError:
            raise
        except IntegrityError as e:
            raise ConstraintViolationError(str(e), cause=e)
        except OperationalError as e:
            raise ConnectionError(str(e), cause=e)
        except Exception as e:
            raise QueryFailedError(f"DeleteMany failed: {str(e)}", cause=e)

    async def upsert(self, params: Optional[UpsertParams] = None, **kwargs: Any) -> Dict[str, Any]:
        """Upsert a record."""
        normalized = self._coerce_params(UpsertParams, params, kwargs)
        # Try to find existing record
        existing = await self.find_one(
            FindOneParams(
                model=normalized.model,
                where=normalized.where,
                select=normalized.select,
                namespace=normalized.namespace,
            )
        )

        if existing:
            return await self.update(
                UpdateParams(
                    model=normalized.model,
                    where=normalized.where,
                    data=normalized.update,
                    select=normalized.select,
                    namespace=normalized.namespace,
                )
            )
        try:
            return await self.create(
                CreateParams(
                    model=normalized.model,
                    data=normalized.create,
                    select=normalized.select,
                    namespace=normalized.namespace,
                )
            )
        except DuplicateKeyError:
            return await self.update(
                UpdateParams(
                    model=normalized.model,
                    where=normalized.where,
                    data=normalized.update,
                    select=normalized.select,
                    namespace=normalized.namespace,
                )
            )

    async def count(self, params: Optional[CountParams] = None, **kwargs: Any) -> int:
        """Count records."""
        normalized = self._coerce_params(CountParams, params, kwargs)
        try:
            table = self._get_table(normalized.model, normalized.namespace)
            query = select(func.count()).select_from(table)

            if normalized.where:
                where_clause = self._build_where_clause(table, normalized.where)
                query = query.where(where_clause)

            with self.engine.connect() as conn:
                result = conn.execute(query)
                return result.scalar() or 0
        except OperationalError as e:
            raise ConnectionError(str(e), cause=e)
        except (ConnectionError, QueryFailedError):
            raise
        except Exception as e:
            raise QueryFailedError(f"Count failed: {str(e)}", cause=e)

    async def transaction(self, callback: Callable) -> Any:
        """Execute operations within a transaction."""
        with self.engine.begin() as conn:
            # Create transaction adapter
            trx_adapter = SQLAlchemyTransactionAdapter(conn, self)
            result = callback(trx_adapter)
            return await result if inspect.isawaitable(result) else result

    async def initialize(self) -> None:
        """Initialize the adapter."""
        # Test connection
        try:
            with self.engine.connect() as conn:
                conn.execute(text("SELECT 1"))
        except Exception as e:
            raise ConnectionError(f"Failed to initialize: {str(e)}", cause=e)

    async def is_healthy(self) -> HealthStatus:
        """Check adapter health."""
        try:
            with self.engine.connect() as conn:
                conn.execute(text("SELECT 1"))

            return HealthStatus(
                healthy=True,
                lastError=None,
                uptime=int(time.time() - self._start_time),
            )
        except Exception as e:
            return HealthStatus(
                healthy=False,
                lastError=str(e),
                uptime=int(time.time() - self._start_time),
            )

    async def close(self) -> None:
        """Close the adapter."""
        self.engine.dispose()

    async def get_schema_version(self, namespace: str) -> int:
        """Get the current schema version."""
        return 0  # TODO: Implement schema versioning

    async def set_schema_version(self, namespace: str, version: int) -> None:
        """Set the schema version."""
        pass  # TODO: Implement schema versioning

    async def validate_schema(self, schema: TableSchema) -> ValidationResult:
        """Validate a schema."""
        return ValidationResult(valid=True)  # TODO: Implement validation

    async def create_schema(self, params: CreateSchemaParams) -> SchemaCreation:
        """Create database schema."""
        return SchemaCreation(success=False, errors=["Schema creation not yet implemented"])


class SQLAlchemyTransactionAdapter:
    """Transaction adapter for SQLAlchemy."""

    def __init__(self, connection, parent_adapter: SQLAlchemyAdapter):
        self.connection = connection
        self.parent = parent_adapter

    async def commit(self) -> None:
        """Commit handled by context manager."""
        pass

    async def rollback(self) -> None:
        """Rollback the transaction."""
        self.connection.rollback()

    async def create(self, params: Optional[CreateParams] = None, **kwargs: Any) -> Dict[str, Any]:
        return await self.parent._create(self.parent._coerce_params(CreateParams, params, kwargs), self.connection)

    async def find_one(self, params: Optional[FindOneParams] = None, **kwargs: Any) -> Optional[Dict[str, Any]]:
        return await self.parent._find_one(self.parent._coerce_params(FindOneParams, params, kwargs), self.connection)

    async def find_many(self, params: Optional[FindManyParams] = None, **kwargs: Any) -> List[Dict[str, Any]]:
        return await self.parent._find_many(self.parent._coerce_params(FindManyParams, params, kwargs), self.connection)

    async def update(self, params: Optional[UpdateParams] = None, **kwargs: Any) -> Dict[str, Any]:
        return await self.parent._update(self.parent._coerce_params(UpdateParams, params, kwargs), self.connection)

    async def delete(self, params: Optional[DeleteParams] = None, **kwargs: Any) -> None:
        await self.parent._delete(self.parent._coerce_params(DeleteParams, params, kwargs), self.connection)


def create_adapter(engine: Engine, namespace_prefix: str = "") -> Adapter:
    """
    Create a SQLAlchemy adapter.

    Args:
        engine: SQLAlchemy Engine
        namespace_prefix: Optional prefix for table names

    Returns:
        SQLAlchemy adapter instance

    Example:
        >>> from sqlalchemy import create_engine
        >>> from superfunctions_sqlalchemy import create_adapter
        >>>
        >>> engine = create_engine("postgresql://localhost/mydb")
        >>> adapter = create_adapter(engine)
    """
    return SQLAlchemyAdapter(engine, namespace_prefix)
