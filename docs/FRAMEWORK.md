# FSx Framework vs Application Code Boundary

This document defines the boundary between **framework code** (core FSx library functionality) and **application code** (higher-level utilities built on the framework).

## Overview

FSx provides a virtual filesystem backed by Cloudflare Durable Objects. The codebase is organized into two distinct layers:

1. **Framework Layer**: Core filesystem primitives, interfaces, and storage backends
2. **Application Layer**: Higher-level utilities, mixins, and integration helpers

---

## Framework Code

Framework code provides the foundational building blocks that are **runtime-agnostic** and can be used across different platforms and contexts.

### Core FSx API (`/core/`)

| Module | Description | Type |
|--------|-------------|------|
| `fsx.ts` | Main FSx class - POSIX-like filesystem operations | **Framework** |
| `backend.ts` | FsBackend interface and MemoryBackend | **Framework** |
| `types.ts` | Core types (Stats, Dirent, FileHandle, etc.) | **Framework** |
| `constants.ts` | POSIX constants (O_RDONLY, S_IFREG, etc.) | **Framework** |
| `errors.ts` | Filesystem error classes (ENOENT, EEXIST, etc.) | **Framework** |
| `config.ts` | FSxConfig configuration types | **Framework** |
| `path.ts` | Path utilities (normalize, join, etc.) | **Framework** |

### Content-Addressable Storage (`/core/cas/`)

| Module | Description | Type |
|--------|-------------|------|
| `content-addressable-fs.ts` | CAS filesystem abstraction | **Framework** |
| `hash.ts` | SHA-1/SHA-256 hashing utilities | **Framework** |
| `path-mapping.ts` | Hash-to-path conversion | **Framework** |
| `compression.ts` | Compression utilities | **Framework** |

### Storage Backends (`/storage/`)

| Module | Description | Type |
|--------|-------------|------|
| `interfaces.ts` | Storage interface definitions | **Framework** |
| `r2.ts` | R2Storage implementation | **Framework** |
| `sqlite.ts` | SQLiteMetadata implementation | **Framework** |
| `tiered.ts` | TieredFS multi-tier filesystem | **Framework** |
| `r2-backend.ts` | R2Backend for FSx | **Framework** |
| `tiered-r2.ts` | TieredR2Storage | **Framework** |
| `page-storage.ts` | Page-based storage for DO cost optimization | **Framework** |
| `chunked-blob-storage.ts` | Chunked blob storage | **Framework** |
| `blob-utils.ts` | Blob management utilities | **Framework** |

### Unix-like Utilities (`/core/glob/`, `/core/find/`, `/core/grep/`)

| Module | Description | Type |
|--------|-------------|------|
| `glob.ts` | Glob pattern matching | **Framework** |
| `match.ts` | Pattern matching utilities | **Framework** |
| `find.ts` | Find files by criteria | **Framework** |
| `grep.ts` | Search file contents | **Framework** |

### Sparse Checkout (`/core/sparse/`)

| Module | Description | Type |
|--------|-------------|------|
| `patterns.ts` | Sparse checkout patterns | **Framework** |
| `include.ts` | Include checker | **Framework** |
| `sparse-fs.ts` | SparseFS implementation | **Framework** |

### Transaction Support (`/core/transaction/`)

| Module | Description | Type |
|--------|-------------|------|
| `transaction.ts` | Atomic transaction support | **Framework** |
| `lock.ts` | File locking utilities | **Framework** |

---

## Application Code

Application code provides **higher-level integrations** and **platform-specific features** built on top of the framework.

### Durable Object Integration (`/do/`)

| Module | Description | Type |
|--------|-------------|------|
| `index.ts` | FileSystemDO Durable Object with HTTP API | **Application** |
| `module.ts` | FsModule - DO-specific filesystem module | **Application** |
| `mixin.ts` | withFs mixin for adding $.fs capability | **Application** |
| `security.ts` | PathValidator for path traversal protection | **Application** |
| `container-executor.ts` | Container execution integration | **Application** |

### Watch/Events (`/core/watch/`)

| Module | Description | Type |
|--------|-------------|------|
| `manager.ts` | Watch subscription management | **Application** |
| `events.ts` | Watch event types and utilities | **Application** |
| `batch.ts` | Event batching for WebSocket efficiency | **Application** |
| `subscription.ts` | Subscription manager | **Application** |
| `client.ts` | Watch client utilities | **Application** |

### MCP Integration (`/core/mcp/`)

| Module | Description | Type |
|--------|-------------|------|
| `tool-registry.ts` | MCP tool registry | **Application** |
| `fs-search.ts` | MCP fs_search tool | **Application** |
| `fs-list.ts` | MCP fs_list tool | **Application** |
| `fs-stat.ts` | MCP fs_stat tool | **Application** |
| `fs-tree.ts` | MCP fs_tree tool | **Application** |
| `fs-mkdir.ts` | MCP fs_mkdir tool | **Application** |
| `fs-exists.ts` | MCP fs_exists tool | **Application** |

### RPC Layer (`/core/rpc/`)

| Module | Description | Type |
|--------|-------------|------|
| `fs-service.ts` | RPC service definition | **Application** |

### CLI (`/cli/`)

| Module | Description | Type |
|--------|-------------|------|
| `index.ts` | CLI entry point | **Application** |
| `help.ts` | CLI help system | **Application** |
| `utils/` | CLI utilities | **Application** |

### Root Entry (`/index.ts`)

The root entry point re-exports both framework and application code, with clear sections separating them.

---

## Boundary Guidelines

### Framework Code Characteristics

- **Zero Cloudflare dependencies**: Framework code should work in any JavaScript runtime
- **Minimal external dependencies**: Only essential utilities
- **Stable API surface**: Changes require careful versioning
- **Pure logic**: No side effects on load
- **Testable in isolation**: Can be tested with MemoryBackend

### Application Code Characteristics

- **Platform-specific**: May depend on Cloudflare Workers types
- **Integration-focused**: Connects framework to specific environments
- **Higher-level abstractions**: Combines framework primitives
- **May have side effects**: WebSocket handlers, HTTP routing, etc.
- **Context-aware**: Knows about DO state, R2 buckets, etc.

---

## Import Guidelines

### For Framework-only Usage

```typescript
// Import from @dotdo/fsx (core package)
import { FSx, MemoryBackend, FsBackend, Stats } from '@dotdo/fsx'
import { ENOENT, EEXIST } from '@dotdo/fsx'
import { glob, find, grep } from '@dotdo/fsx'
```

### For Application/DO Usage

```typescript
// Import from fsx.do (managed service)
import {
  // Framework exports
  FSx, Stats, ENOENT,
  // Application exports
  FileSystemDO, FsModule, withFs,
  PathValidator, pathValidator,
} from 'fsx.do'
```

---

## Export Organization

The main `index.ts` is organized into clear sections:

1. **Re-export core @dotdo/fsx** - Framework types and classes
2. **Errors from core/errors.js** - Framework error classes
3. **Path utilities, glob, find, grep** - Framework utilities
4. **Content-Addressable Storage** - Framework CAS exports
5. **Sparse checkout** - Framework sparse exports
6. **Config** - Framework configuration
7. **Durable Object exports** - Application DO integration
8. **Storage backends** - Framework storage implementations
9. **fs singleton and factory** - Application convenience exports

---

## Security Considerations

### Framework Layer Security

- Path normalization in `FSx.normalizePath()`
- Error boundary enforcement in error classes
- Constants for permission checks

### Application Layer Security

The `PathValidator` class in `/do/security.ts` provides:

- **Path Traversal Protection (CWE-22)**: Prevents `../` escape sequences
- **Null Byte Injection Detection (CWE-626)**: Blocks null byte attacks
- **Path Length Limits (CWE-789)**: Enforces PATH_MAX/NAME_MAX
- **Control Character Blocking**: Prevents terminal injection
- **Unicode Security**: Blocks bidirectional override characters

```typescript
// Application code should always validate user-provided paths
import { pathValidator } from 'fsx.do'

const safePath = pathValidator.validatePath(userInput, '/jail/root')
```

---

## Versioning Strategy

- **Framework changes**: Semantic versioning, breaking changes require major bump
- **Application changes**: Can evolve more freely as long as framework API stable
- **Both packages**: Published together but framework can be used standalone

---

## Future Considerations

1. **Package split**: Consider publishing `@dotdo/fsx` separately for framework-only usage
2. **Plugin system**: Allow application-layer extensions without modifying framework
3. **Test isolation**: Framework tests should not require DO environment
4. **Documentation**: Separate API docs for framework vs application layers
