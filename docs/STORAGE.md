# BlobStorage Interface Contract

This document defines the contract for the `BlobStorage` interface in fsx. Implementers must follow these specifications to ensure compatibility with the fsx storage layer.

## Table of Contents

1. [Overview](#overview)
2. [Interface Definition](#interface-definition)
3. [Required vs Optional Methods](#required-vs-optional-methods)
4. [Return Type Specifications](#return-type-specifications)
5. [Error Handling](#error-handling)
6. [Usage Examples](#usage-examples)
7. [Migration Guide from evodb/db4](#migration-guide-from-evodbdb4)
8. [Adapter Pattern for Simple Backends](#adapter-pattern-for-simple-backends)

---

## Overview

`BlobStorage` is the core interface for key-value blob storage in fsx. It abstracts away the underlying storage backend (R2, S3, filesystem, memory) and provides a consistent API for storing and retrieving binary data.

**Key Design Principles:**
- POSIX-like error semantics via `StorageError`
- Optional instrumentation hooks for observability
- Streaming support for large files
- Pagination for list operations
- Idempotent delete operations

---

## Interface Definition

```typescript
import type {
  BlobStorage,
  BlobWriteResult,
  BlobReadResult,
  BlobListResult,
  BlobObjectInfo,
  BlobWriteOptions,
  BlobListOptions,
  StorageError,
  StorageErrorCode,
} from '@dotdo/fsx/storage'
```

### Core Interface

```typescript
interface BlobStorage {
  // Required methods (MUST implement)
  put(path: string, data: Uint8Array | ReadableStream, options?: BlobWriteOptions): Promise<BlobWriteResult>
  get(path: string): Promise<BlobReadResult | null>
  delete(path: string): Promise<void>
  exists(path: string): Promise<boolean>

  // Optional methods (MAY implement)
  getStream?(path: string): Promise<{ stream: ReadableStream; metadata: BlobReadResult['metadata'] } | null>
  getRange?(path: string, start: number, end?: number): Promise<BlobReadResult | null>
  head?(path: string): Promise<BlobReadResult['metadata'] | null>
  list?(options?: BlobListOptions): Promise<BlobListResult>
  copy?(sourcePath: string, destPath: string): Promise<BlobWriteResult>
  deleteMany?(paths: string[]): Promise<void>
}
```

---

## Required vs Optional Methods

### Required Methods

These methods MUST be implemented by all `BlobStorage` implementations:

| Method | Description | Notes |
|--------|-------------|-------|
| `put` | Store a blob | Must support both `Uint8Array` and `ReadableStream` |
| `get` | Retrieve a blob | Returns `null` if not found (not an error) |
| `delete` | Remove a blob | Idempotent - succeeds even if blob doesn't exist |
| `exists` | Check blob existence | Should use HEAD request internally if possible |

### Optional Methods

These methods MAY be implemented for enhanced functionality:

| Method | Description | When to Implement |
|--------|-------------|-------------------|
| `getStream` | Stream-based retrieval | When memory efficiency matters for large files |
| `getRange` | Partial byte range reads | When seeking/resumable downloads needed |
| `head` | Get metadata only | For efficient size/type checks without download |
| `list` | List blobs by prefix | For directory-like operations |
| `copy` | Server-side copy | When backend supports it natively |
| `deleteMany` | Batch delete | For efficient bulk cleanup |

---

## Return Type Specifications

### BlobWriteResult

Returned by `put()` and `copy()`:

```typescript
interface BlobWriteResult {
  /** ETag of the stored object - use for conditional requests */
  etag: string

  /** Size of the stored data in bytes */
  size: number
}
```

**Contract:**
- `etag` MUST be a quoted string (e.g., `"abc123"`) per HTTP spec
- `size` MUST match the actual bytes written
- If the backend doesn't support ETags, generate a hash-based value

### BlobReadResult

Returned by `get()` and `getRange()`:

```typescript
interface BlobReadResult<T = Uint8Array> {
  /** The blob data */
  data: T

  /** Object metadata */
  metadata: {
    size: number
    etag: string
    contentType?: string
    customMetadata?: Record<string, string>
    lastModified?: Date
  }
}
```

**Contract:**
- Returns `null` if blob not found (not an error)
- `metadata.size` is the TOTAL object size (not the range size for `getRange`)
- `data` contains the actual bytes requested

### BlobListResult

Returned by `list()`:

```typescript
interface BlobListResult<T = BlobObjectInfo> {
  /** Listed objects */
  objects: T[]

  /** Continuation cursor for pagination */
  cursor?: string

  /** Whether more results exist beyond this page */
  truncated: boolean
}

interface BlobObjectInfo {
  key: string
  size: number
  etag: string
  uploaded: Date
}
```

**Contract:**
- `truncated` MUST be `true` if more results exist
- `cursor` MUST be provided when `truncated` is `true`
- `objects` SHOULD be ordered lexicographically by key

### BlobListOptions

Input for `list()`:

```typescript
interface BlobListOptions {
  /** Key prefix filter */
  prefix?: string

  /** Maximum results per page (default: backend-specific) */
  limit?: number

  /** Continuation cursor from previous response */
  cursor?: string
}
```

### BlobWriteOptions

Input for `put()`:

```typescript
interface BlobWriteOptions {
  /** MIME content type */
  contentType?: string

  /** Custom metadata key-value pairs */
  customMetadata?: Record<string, string>
}
```

---

## Error Handling

### StorageError Class

All storage errors MUST be thrown as `StorageError` instances:

```typescript
import { StorageError } from '@dotdo/fsx/storage'

class StorageError extends Error {
  readonly code: StorageErrorCode
  readonly path?: string
  readonly cause?: Error
  readonly operation?: string
}
```

### StorageErrorCode Reference

| Code | Meaning | When to Use |
|------|---------|-------------|
| `ENOENT` | Not found | Resource doesn't exist (for operations that require it) |
| `EEXIST` | Already exists | Conflict on create-if-not-exists operations |
| `EACCES` | Permission denied | Authorization failures |
| `ENOSPC` | Quota exceeded | Storage limit reached |
| `EIO` | I/O error | Network failures, disk errors |
| `EINVAL` | Invalid argument | Bad path format, invalid ranges |
| `ENOTEMPTY` | Directory not empty | For filesystem-like backends |
| `ENOTDIR` | Not a directory | Path is a file, not directory |
| `EISDIR` | Is a directory | Path is a directory, not file |
| `EBUSY` | Resource busy | Concurrent modification conflicts |
| `ETIMEDOUT` | Timeout | Operation exceeded time limit |
| `EUNKNOWN` | Unknown error | Catch-all for unexpected errors |

### Error Handling Patterns

**Pattern 1: Not Found Returns Null**
```typescript
// get(), head(), getStream(), getRange() return null for missing blobs
const result = await storage.get('/nonexistent')
// result === null (NOT an error)
```

**Pattern 2: Idempotent Delete**
```typescript
// delete() succeeds even if blob doesn't exist
await storage.delete('/nonexistent') // No error
```

**Pattern 3: Copy Throws on Missing Source**
```typescript
// copy() throws ENOENT if source doesn't exist
try {
  await storage.copy('/nonexistent', '/dest')
} catch (e) {
  if (e instanceof StorageError && e.code === 'ENOENT') {
    // Source not found
  }
}
```

### Static Factory Methods

Use these for consistent error creation:

```typescript
StorageError.notFound(path, operation?)      // ENOENT
StorageError.exists(path, operation?)        // EEXIST
StorageError.invalidArg(message, path?, operation?)  // EINVAL
StorageError.io(cause, path?, operation?)    // EIO
```

---

## Usage Examples

### Basic Operations

```typescript
import { R2Storage } from '@dotdo/fsx/storage'

// Initialize storage
const storage = new R2Storage({
  bucket: env.MY_BUCKET,
  prefix: 'app/data/',
})

// Write a blob
const data = new TextEncoder().encode('Hello, World!')
const { etag, size } = await storage.put('/greeting.txt', data, {
  contentType: 'text/plain',
  customMetadata: { author: 'system' },
})

// Read a blob
const result = await storage.get('/greeting.txt')
if (result) {
  const text = new TextDecoder().decode(result.data)
  console.log(text) // "Hello, World!"
}

// Check existence
if (await storage.exists('/greeting.txt')) {
  console.log('File exists')
}

// Delete
await storage.delete('/greeting.txt')
```

### Pagination

```typescript
// List all blobs with prefix
let cursor: string | undefined
do {
  const page = await storage.list({ prefix: 'logs/', limit: 100, cursor })
  for (const obj of page.objects) {
    console.log(`${obj.key}: ${obj.size} bytes`)
  }
  cursor = page.cursor
} while (cursor)
```

### With Instrumentation

```typescript
import { R2Storage, type StorageHooks } from '@dotdo/fsx/storage'

const hooks: StorageHooks = {
  onOperationStart: (ctx) => {
    console.log(`Starting ${ctx.operation} on ${ctx.path}`)
  },
  onOperationEnd: (ctx, result) => {
    console.log(`${ctx.operation} completed in ${result.durationMs}ms`)
    if (!result.success) {
      console.error(`Error: ${result.error?.code}`)
    }
  },
}

const storage = new R2Storage({ bucket: env.MY_BUCKET, hooks })
```

---

## Migration Guide from evodb/db4

If you're migrating from evodb's `ObjectStorageAdapter`, this section explains the key differences and how to adapt your code.

### Interface Comparison

| evodb `ObjectStorageAdapter` | fsx `BlobStorage` | Notes |
|------------------------------|-------------------|-------|
| `put(path, data)` returns `Promise<void>` | `put(path, data, options?)` returns `Promise<BlobWriteResult>` | fsx returns etag and size |
| `get(path)` returns `Promise<Uint8Array \| null>` | `get(path)` returns `Promise<BlobReadResult \| null>` | fsx includes metadata |
| `delete(path)` | `delete(path)` | Same semantics |
| `list(prefix)` returns `Promise<string[]>` | `list(options?)` returns `Promise<BlobListResult>` | fsx adds pagination |
| `head(path)` returns `Promise<ObjectMetadata \| null>` | `head?(path)` returns `Promise<BlobReadResult['metadata'] \| null>` | Similar, slightly different types |
| `exists?(path)` | `exists(path)` | Required in fsx |
| `getRange?(path, offset, length)` | `getRange?(path, start, end?)` | Different signature |

### Code Migration

**Before (evodb):**
```typescript
import { ObjectStorageAdapter } from '@dotdo/evodb-core'

async function saveData(storage: ObjectStorageAdapter, data: Uint8Array) {
  await storage.put('data.bin', data)
  const retrieved = await storage.get('data.bin')
  if (retrieved) {
    console.log(`Got ${retrieved.length} bytes`)
  }
}
```

**After (fsx):**
```typescript
import { BlobStorage } from '@dotdo/fsx/storage'

async function saveData(storage: BlobStorage, data: Uint8Array) {
  const { etag, size } = await storage.put('data.bin', data)
  console.log(`Stored ${size} bytes with etag ${etag}`)

  const result = await storage.get('data.bin')
  if (result) {
    console.log(`Got ${result.data.length} bytes, last modified: ${result.metadata.lastModified}`)
  }
}
```

### Adapter for Legacy Code

If you need to use existing evodb-style code with fsx storage:

```typescript
import type { BlobStorage, BlobReadResult } from '@dotdo/fsx/storage'

/** Adapter that makes BlobStorage look like ObjectStorageAdapter */
class ObjectStorageAdapterShim {
  constructor(private blob: BlobStorage) {}

  async put(path: string, data: Uint8Array): Promise<void> {
    await this.blob.put(path, data)
  }

  async get(path: string): Promise<Uint8Array | null> {
    const result = await this.blob.get(path)
    return result?.data ?? null
  }

  async delete(path: string): Promise<void> {
    await this.blob.delete(path)
  }

  async list(prefix: string): Promise<string[]> {
    if (!this.blob.list) {
      throw new Error('list not supported by this storage backend')
    }
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const page = await this.blob.list({ prefix, cursor })
      keys.push(...page.objects.map(o => o.key))
      cursor = page.cursor
    } while (cursor)
    return keys
  }

  async head(path: string): Promise<{ size: number; etag: string; lastModified?: Date } | null> {
    if (this.blob.head) {
      const meta = await this.blob.head(path)
      return meta ? { size: meta.size, etag: meta.etag, lastModified: meta.lastModified } : null
    }
    // Fallback: get full object (inefficient)
    const result = await this.blob.get(path)
    return result ? { size: result.metadata.size, etag: result.metadata.etag } : null
  }

  async exists(path: string): Promise<boolean> {
    return this.blob.exists(path)
  }
}
```

---

## Adapter Pattern for Simple Backends

For backends that don't support all optional features, implement only the required methods and use this adapter pattern:

### Minimal Implementation

```typescript
import type {
  BlobStorage,
  BlobWriteResult,
  BlobReadResult,
  BlobWriteOptions,
} from '@dotdo/fsx/storage'
import { StorageError } from '@dotdo/fsx/storage'

/**
 * Minimal BlobStorage implementation for simple backends.
 * Implements only the required methods.
 */
export class SimpleBlobStorage implements BlobStorage {
  private data = new Map<string, { bytes: Uint8Array; meta: { contentType?: string; custom?: Record<string, string>; modified: Date } }>()

  async put(
    path: string,
    data: Uint8Array | ReadableStream,
    options?: BlobWriteOptions
  ): Promise<BlobWriteResult> {
    // Convert stream to bytes if needed
    const bytes = data instanceof ReadableStream
      ? new Uint8Array(await new Response(data).arrayBuffer())
      : data

    const etag = `"${this.computeHash(bytes)}"`
    this.data.set(path, {
      bytes: bytes.slice(), // Copy to prevent mutation
      meta: {
        contentType: options?.contentType,
        custom: options?.customMetadata,
        modified: new Date(),
      },
    })

    return { etag, size: bytes.length }
  }

  async get(path: string): Promise<BlobReadResult | null> {
    const entry = this.data.get(path)
    if (!entry) return null

    return {
      data: entry.bytes.slice(),
      metadata: {
        size: entry.bytes.length,
        etag: `"${this.computeHash(entry.bytes)}"`,
        contentType: entry.meta.contentType,
        customMetadata: entry.meta.custom,
        lastModified: entry.meta.modified,
      },
    }
  }

  async delete(path: string): Promise<void> {
    this.data.delete(path) // Idempotent
  }

  async exists(path: string): Promise<boolean> {
    return this.data.has(path)
  }

  private computeHash(data: Uint8Array): string {
    let hash = 0
    for (let i = 0; i < data.length; i++) {
      hash = ((hash << 5) - hash + data[i]) | 0
    }
    return hash.toString(16)
  }
}
```

### Adding Optional Features

Extend the minimal implementation with optional methods as needed:

```typescript
class EnhancedBlobStorage extends SimpleBlobStorage {
  // Add head() for efficient metadata checks
  async head(path: string): Promise<BlobReadResult['metadata'] | null> {
    const entry = this.data.get(path)
    if (!entry) return null
    return {
      size: entry.bytes.length,
      etag: `"${this.computeHash(entry.bytes)}"`,
      contentType: entry.meta.contentType,
      customMetadata: entry.meta.custom,
      lastModified: entry.meta.modified,
    }
  }

  // Add list() for enumeration
  async list(options?: BlobListOptions): Promise<BlobListResult> {
    let keys = [...this.data.keys()].sort()

    if (options?.prefix) {
      keys = keys.filter(k => k.startsWith(options.prefix!))
    }

    const start = options?.cursor ? keys.indexOf(options.cursor) + 1 : 0
    const limit = options?.limit ?? 1000
    const page = keys.slice(start, start + limit)
    const truncated = start + limit < keys.length

    return {
      objects: page.map(key => {
        const entry = this.data.get(key)!
        return {
          key,
          size: entry.bytes.length,
          etag: `"${this.computeHash(entry.bytes)}"`,
          uploaded: entry.meta.modified,
        }
      }),
      cursor: truncated ? page[page.length - 1] : undefined,
      truncated,
    }
  }
}
```

---

## Testing Your Implementation

Use the interface contract tests to verify your implementation:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { runBlobStorageContractTests } from '@dotdo/fsx/storage/test-utils'
import { MyBlobStorage } from './my-storage'

describe('MyBlobStorage', () => {
  let storage: MyBlobStorage

  beforeEach(() => {
    storage = new MyBlobStorage()
  })

  // Run the full contract test suite
  runBlobStorageContractTests(() => storage)

  // Add implementation-specific tests
  it('should handle my special feature', async () => {
    // ...
  })
})
```

See `/Users/nathanclevenger/projects/fsx/storage/__tests__/interface-contract.test.ts` for the complete test suite.

---

## Summary

The `BlobStorage` interface provides a clean, consistent API for blob storage with:

- **4 required methods:** `put`, `get`, `delete`, `exists`
- **6 optional methods:** `getStream`, `getRange`, `head`, `list`, `copy`, `deleteMany`
- **POSIX-like errors:** `StorageError` with codes like `ENOENT`, `EIO`, etc.
- **Rich metadata:** ETags, content types, custom metadata, timestamps
- **Pagination:** Cursor-based pagination for list operations

When implementing a new storage backend:
1. Start with the 4 required methods
2. Add optional methods as your backend supports them
3. Use `StorageError` for all error conditions
4. Test with the contract test suite
