"""Core type definitions for the database adapter system."""

from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Protocol, Set, TypeVar

from pydantic import BaseModel, Field

# ============================================================================
# Enums
# ============================================================================


class Operator(str, Enum):
    """Query operators."""

    EQ = "eq"
    NE = "ne"
    GT = "gt"
    GTE = "gte"
    LT = "lt"
    LTE = "lte"
    IN = "in"
    NOT_IN = "not_in"
    LIKE = "like"
    ILIKE = "ilike"
    IS_NULL = "is_null"
    IS_NOT_NULL = "is_not_null"
    CONTAINS = "contains"
    STARTS_WITH = "starts_with"
    ENDS_WITH = "ends_with"


class Direction(str, Enum):
    """Sort direction."""

    ASC = "asc"
    DESC = "desc"


class TransactionIsolation(str, Enum):
    """Transaction isolation levels."""

    READ_UNCOMMITTED = "read_uncommitted"
    READ_COMMITTED = "read_committed"
    REPEATABLE_READ = "repeatable_read"
    SERIALIZABLE = "serializable"


# ============================================================================
# Query Parameters
# ============================================================================


class WhereClause(BaseModel):
    """Database where clause."""

    field: str
    operator: Operator = Operator.EQ
    value: Any
    connector: Literal["AND", "OR"] = "AND"

    class Config:
        use_enum_values = True


class OrderBy(BaseModel):
    """Order by clause."""

    field: str
    direction: Direction = Direction.ASC

    class Config:
        use_enum_values = True


class JoinConfig(BaseModel):
    """Join configuration."""

    model: str
    on: List[WhereClause]
    type: Literal["inner", "left", "right", "full"] = "inner"
    select: Optional[List[str]] = None


# ============================================================================
# Operation Parameters
# ============================================================================


class CreateParams(BaseModel):
    """Parameters for create operation."""

    model: str
    data: Dict[str, Any]
    select: Optional[List[str]] = None
    namespace: Optional[str] = None

    class Config:
        arbitrary_types_allowed = True


class FindOneParams(BaseModel):
    """Parameters for findOne operation."""

    model: str
    where: List[WhereClause]
    select: Optional[List[str]] = None
    join: Optional[JoinConfig] = None
    namespace: Optional[str] = None

    class Config:
        arbitrary_types_allowed = True


class FindManyParams(BaseModel):
    """Parameters for findMany operation."""

    model: str
    where: Optional[List[WhereClause]] = None
    select: Optional[List[str]] = None
    join: Optional[JoinConfig] = None
    order_by: Optional[List[OrderBy]] = Field(None, alias="orderBy")
    limit: Optional[int] = None
    offset: Optional[int] = None
    namespace: Optional[str] = None

    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True


class UpdateParams(BaseModel):
    """Parameters for update operation."""

    model: str
    where: List[WhereClause]
    data: Dict[str, Any]
    select: Optional[List[str]] = None
    namespace: Optional[str] = None

    class Config:
        arbitrary_types_allowed = True


class DeleteParams(BaseModel):
    """Parameters for delete operation."""

    model: str
    where: List[WhereClause]
    namespace: Optional[str] = None

    class Config:
        arbitrary_types_allowed = True


class CreateManyParams(BaseModel):
    """Parameters for createMany operation."""

    model: str
    data: List[Dict[str, Any]]
    select: Optional[List[str]] = None
    namespace: Optional[str] = None

    class Config:
        arbitrary_types_allowed = True


class UpdateManyParams(BaseModel):
    """Parameters for updateMany operation."""

    model: str
    where: List[WhereClause]
    data: Dict[str, Any]
    namespace: Optional[str] = None

    class Config:
        arbitrary_types_allowed = True


class DeleteManyParams(BaseModel):
    """Parameters for deleteMany operation."""

    model: str
    where: List[WhereClause]
    namespace: Optional[str] = None

    class Config:
        arbitrary_types_allowed = True


class UpsertParams(BaseModel):
    """Parameters for upsert operation."""

    model: str
    where: List[WhereClause]
    create: Dict[str, Any]
    update: Dict[str, Any]
    select: Optional[List[str]] = None
    namespace: Optional[str] = None

    class Config:
        arbitrary_types_allowed = True


class CountParams(BaseModel):
    """Parameters for count operation."""

    model: str
    where: Optional[List[WhereClause]] = None
    namespace: Optional[str] = None

    class Config:
        arbitrary_types_allowed = True


# ============================================================================
# Schema Management
# ============================================================================


class FieldType(str, Enum):
    """Database field types."""

    STRING = "string"
    TEXT = "text"
    INTEGER = "integer"
    BIGINT = "bigint"
    FLOAT = "float"
    DECIMAL = "decimal"
    BOOLEAN = "boolean"
    DATE = "date"
    DATETIME = "datetime"
    TIMESTAMP = "timestamp"
    JSON = "json"
    JSONB = "jsonb"
    BINARY = "binary"
    UUID = "uuid"


class FieldSchema(BaseModel):
    """Field schema definition."""

    name: str
    type: FieldType
    nullable: bool = False
    default: Optional[Any] = None
    primary_key: bool = Field(False, alias="primaryKey")
    auto_increment: bool = Field(False, alias="autoIncrement")
    unique: bool = False
    index: bool = False
    references: Optional[str] = None
    on_delete: Optional[Literal["cascade", "set_null", "restrict"]] = Field(None, alias="onDelete")
    on_update: Optional[Literal["cascade", "set_null", "restrict"]] = Field(None, alias="onUpdate")

    class Config:
        populate_by_name = True


class IndexSchema(BaseModel):
    """Index schema definition."""

    name: str
    fields: List[str]
    unique: bool = False


class ConstraintSchema(BaseModel):
    """Constraint schema definition."""

    name: str
    type: Literal["unique", "check", "foreign_key"]
    fields: List[str]
    check: Optional[str] = None
    references: Optional[str] = None


class TableSchema(BaseModel):
    """Table schema definition."""

    name: str
    fields: List[FieldSchema]
    indexes: Optional[List[IndexSchema]] = None
    constraints: Optional[List[ConstraintSchema]] = None
    namespace: Optional[str] = None


class ValidationResult(BaseModel):
    """Schema validation result."""

    valid: bool
    errors: List[str] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)


class CreateSchemaParams(BaseModel):
    """Parameters for schema creation."""

    tables: List[TableSchema]
    drop_existing: bool = Field(False, alias="dropExisting")

    class Config:
        populate_by_name = True


class SchemaCreation(BaseModel):
    """Result of schema creation."""

    success: bool
    sql: Optional[str] = None
    errors: List[str] = Field(default_factory=list)


# ============================================================================
# Health & Capabilities
# ============================================================================


class HealthStatus(BaseModel):
    """Adapter health status."""

    healthy: bool
    connections: Optional[Dict[str, int]] = None
    last_error: Optional[str] = Field(None, alias="lastError")
    uptime: int

    class Config:
        populate_by_name = True


class AdapterCapabilities(BaseModel):
    """Adapter capabilities."""

    transactions: bool = True
    nested_transactions: bool = Field(False, alias="nestedTransactions")
    joins: bool = True
    full_text_search: bool = Field(False, alias="fullTextSearch")
    json_operations: bool = Field(False, alias="jsonOperations")
    schema_management: bool = Field(False, alias="schemaManagement")
    migration_support: bool = Field(False, alias="migrationSupport")
    batch_operations: bool = Field(True, alias="batchOperations")

    class Config:
        populate_by_name = True


# ============================================================================
# Configuration
# ============================================================================


class NamespaceConfig(BaseModel):
    """Namespace configuration."""

    separator: str = "_"
    use_schema: bool = Field(False, alias="useSchema")
    default_namespace: str = Field("default", alias="defaultNamespace")
    known_namespaces: Optional[Set[str]] = Field(None, alias="knownNamespaces")

    class Config:
        populate_by_name = True


class AdapterConfig(BaseModel):
    """Base adapter configuration."""

    namespace: Optional[NamespaceConfig] = None
    debug: bool = False
    pool_size: Optional[int] = Field(None, alias="poolSize")
    max_overflow: Optional[int] = Field(None, alias="maxOverflow")
    pool_timeout: Optional[int] = Field(None, alias="poolTimeout")

    class Config:
        populate_by_name = True
        arbitrary_types_allowed = True


# ============================================================================
# Protocols
# ============================================================================

T = TypeVar("T")


class TransactionAdapter(Protocol):
    """Transaction adapter protocol."""

    async def commit(self) -> None:
        """Commit the transaction."""
        pass

    async def rollback(self) -> None:
        """Rollback the transaction."""
        pass

    async def create(self, params: Optional[CreateParams] = None, **kwargs: Any) -> Dict[str, Any]:
        """Create a record within transaction."""
        pass

    async def find_one(self, params: Optional[FindOneParams] = None, **kwargs: Any) -> Optional[Dict[str, Any]]:
        """Find one record within transaction."""
        pass

    async def find_many(self, params: Optional[FindManyParams] = None, **kwargs: Any) -> List[Dict[str, Any]]:
        """Find many records within transaction."""
        pass

    async def update(self, params: Optional[UpdateParams] = None, **kwargs: Any) -> Dict[str, Any]:
        """Update a record within transaction."""
        pass

    async def delete(self, params: Optional[DeleteParams] = None, **kwargs: Any) -> None:
        """Delete a record within transaction."""
        pass


class Adapter(Protocol):
    """Database adapter protocol."""

    # Metadata
    id: str
    name: str
    version: str
    capabilities: AdapterCapabilities

    # Core CRUD operations
    async def create(self, params: Optional[CreateParams] = None, **kwargs: Any) -> Dict[str, Any]:
        """Create a single record."""
        pass

    async def find_one(self, params: Optional[FindOneParams] = None, **kwargs: Any) -> Optional[Dict[str, Any]]:
        """Find a single record."""
        pass

    async def find_many(self, params: Optional[FindManyParams] = None, **kwargs: Any) -> List[Dict[str, Any]]:
        """Find multiple records."""
        pass

    async def update(self, params: Optional[UpdateParams] = None, **kwargs: Any) -> Dict[str, Any]:
        """Update a single record."""
        pass

    async def delete(self, params: Optional[DeleteParams] = None, **kwargs: Any) -> None:
        """Delete a single record."""
        pass

    # Batch operations
    async def create_many(self, params: Optional[CreateManyParams] = None, **kwargs: Any) -> List[Dict[str, Any]]:
        """Create multiple records."""
        pass

    async def update_many(self, params: Optional[UpdateManyParams] = None, **kwargs: Any) -> int:
        """Update multiple records, returns count."""
        pass

    async def delete_many(self, params: Optional[DeleteManyParams] = None, **kwargs: Any) -> int:
        """Delete multiple records, returns count."""
        pass

    # Advanced operations
    async def upsert(self, params: Optional[UpsertParams] = None, **kwargs: Any) -> Dict[str, Any]:
        """Upsert a record."""
        pass

    async def count(self, params: Optional[CountParams] = None, **kwargs: Any) -> int:
        """Count records."""
        pass

    # Transaction support
    async def transaction(self, callback: Any) -> Any:
        """Execute operations within a transaction."""
        pass

    # Lifecycle management
    async def initialize(self) -> None:
        """Initialize the adapter."""
        pass

    async def is_healthy(self) -> HealthStatus:
        """Check adapter health."""
        pass

    async def close(self) -> None:
        """Close the adapter."""
        pass

    # Schema management
    async def get_schema_version(self, namespace: str) -> int:
        """Get the current schema version."""
        pass

    async def set_schema_version(self, namespace: str, version: int) -> None:
        """Set the schema version."""
        pass

    async def validate_schema(self, schema: TableSchema) -> ValidationResult:
        """Validate a schema."""
        pass

    async def create_schema(self, params: CreateSchemaParams) -> SchemaCreation:
        """Create database schema."""
        pass
