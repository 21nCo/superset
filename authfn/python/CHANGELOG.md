# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Placement-bound auth context issuer (`create_placement_context_issuer`) for trusted in-process and private-service consumers.

### Changed
- Nothing yet

### Fixed
- Nothing yet

## [0.1.0] - 2026-01-12

### Added
- Initial release of authfn Python SDK
- API key generation with cryptographically secure random generation
- Authentication via Bearer token
- Authorization for resource-based access control
- Key revocation support
- Key expiration with automatic checking
- Metadata support for custom key metadata
- Scopes support for optional scope-based permissions
- Database abstraction using Protocol-based adapter pattern
- Schema definition for declarative database table generation
- Type safety with Pydantic models and runtime validation
- Full async/await support throughout
- Custom exception classes for error handling
- Comprehensive test suite with 11 test cases
- Mock database adapter for testing
- Complete documentation:
  - README.md with usage examples
  - INSTALLATION.md with setup instructions
  - COMPARISON.md comparing TypeScript and Python implementations
  - IMPLEMENTATION_SUMMARY.md with implementation details
  - PUBLISHING.md with publishing guide
  - QUICKSTART.md for quick reference
- Example code in `examples/basic_usage.py`
- Development tools:
  - pytest configuration
  - mypy type checking
  - ruff linting
  - black formatting
  - Makefile for common tasks
  - Publishing script

### Core Features
- `AuthFn` class for main functionality
- `AuthFnProvider` class for authentication and authorization
- `create_authfn()` factory function
- `generate_api_key()` for secure key generation
- `generate_id()` for unique ID generation

### Type Definitions
- `ApiKeySession` - Session data after authentication
- `ApiKey` - Complete API key data
- `ApiKeyCreate` - Input data for creating keys
- `ApiKeyResponse` - Response with ID and secret key
- `ApiKeySanitized` - API key without secret
- `AuthFnConfig` - Configuration model
- `WhereClause` - Database query clause
- `OrderByClause` - Database ordering clause

### Protocols
- `DatabaseAdapter` - Protocol for database implementations
- `Request` - Protocol for HTTP request objects
- `AuthProvider` - Protocol for auth providers

### Dependencies
- pydantic>=2.5.0 - Data validation and type safety
- cryptography>=41.0.0 - Cryptographic operations

### Python Support
- Python 3.10+
- Python 3.11
- Python 3.12

[Unreleased]: https://github.com/21nCo/super-functions/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/21nCo/super-functions/releases/tag/v0.1.0
