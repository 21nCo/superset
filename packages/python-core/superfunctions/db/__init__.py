"""
superfunctions.db - Database adapter system.

Provides protocol-based database abstractions that work with any ORM.

Example:
    >>> from superfunctions.db import Adapter, CreateParams, FindManyParams
    >>>
    >>> # Use with any adapter implementation
    >>> user = await adapter.create(
    ...     CreateParams(model="users", data={"name": "Alice"})
    ... )
"""

from .errors import (
    AdapterConnectionError,
    AdapterError,
    AdapterErrorCode,
    AdapterTimeoutError,
    ConstraintViolationError,
    DuplicateKeyError,
    NotFoundError,
    OperationNotSupportedError,
    QueryFailedError,
    SchemaValidationError,
    TransactionError,
)
from .namespace import NamespaceManager, create_namespace_manager
from .types import (
    Adapter,
    AdapterCapabilities,
    AdapterConfig,
    ConstraintSchema,
    CountParams,
    CreateManyParams,
    CreateParams,
    CreateSchemaParams,
    DeleteManyParams,
    DeleteParams,
    Direction,
    FieldSchema,
    FieldType,
    FindManyParams,
    FindOneParams,
    HealthStatus,
    IndexSchema,
    JoinConfig,
    NamespaceConfig,
    Operator,
    OrderBy,
    SchemaCreation,
    TableSchema,
    TransactionAdapter,
    TransactionIsolation,
    UpdateManyParams,
    UpdateParams,
    UpsertParams,
    ValidationResult,
    WhereClause,
)

__all__ = [
    # Core protocols
    "Adapter",
    "TransactionAdapter",
    # Configuration
    "AdapterCapabilities",
    "AdapterConfig",
    "NamespaceConfig",
    "HealthStatus",
    # Operation parameters
    "CreateParams",
    "FindOneParams",
    "FindManyParams",
    "UpdateParams",
    "DeleteParams",
    "CreateManyParams",
    "UpdateManyParams",
    "DeleteManyParams",
    "UpsertParams",
    "CountParams",
    # Query builders
    "WhereClause",
    "OrderBy",
    "JoinConfig",
    "Operator",
    "Direction",
    # Schema types
    "FieldSchema",
    "FieldType",
    "ConstraintSchema",
    "IndexSchema",
    "TableSchema",
    "ValidationResult",
    "CreateSchemaParams",
    "SchemaCreation",
    "TransactionIsolation",
    # Errors
    "AdapterError",
    "AdapterErrorCode",
    "AdapterConnectionError",
    "ConstraintViolationError",
    "NotFoundError",
    "DuplicateKeyError",
    "QueryFailedError",
    "TransactionError",
    "SchemaValidationError",
    "OperationNotSupportedError",
    "AdapterTimeoutError",
    # Utils
    "NamespaceManager",
    "create_namespace_manager",
]
