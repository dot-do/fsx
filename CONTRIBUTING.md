# Contributing to FSx

Thank you for contributing to FSx! This guide covers coding conventions and best practices for the project.

## Table of Contents

- [Error Handling Convention](#error-handling-convention)
- [Code Style](#code-style)
- [Testing](#testing)

## Error Handling Convention

FSx uses a consistent error handling pattern throughout the codebase. Understanding these conventions is essential for maintaining consistency.

### Core Principles

1. **Use typed errors from `core/errors.ts`** for filesystem operations
2. **Use `StorageError` from `storage/interfaces.ts`** for storage backend operations
3. **Choose the right pattern** based on whether "not found" is expected or exceptional

### When to Return `null`

Return `null` when the absence of data is a **normal, expected outcome**:

```typescript
// BlobStorage.get() - returns null if blob doesn't exist
async get(path: string): Promise<BlobReadResult | null>

// MetadataStorage.getByPath() - returns null if entry doesn't exist
async getByPath(path: string): Promise<FileEntry | null>

// ContentAddressableFS.getObject() - returns null if object doesn't exist
async getObject(hash: string): Promise<CASObject | null>

// head() operations - returns null if not found
async head(path: string): Promise<Metadata | null>

// getRange() operations - returns null if not found
async getRange(path: string, start: number, end?: number): Promise<BlobReadResult | null>
```

**Pattern: Optional read operations where callers typically check for existence**

### When to Throw Errors

Throw errors when the absence of data is **exceptional or indicates a problem**:

```typescript
// readFile() - throws ENOENT if file doesn't exist
async readFile(path: string): Promise<Uint8Array>
// Throws: ENOENT if file not found

// stat() - throws ENOENT if path doesn't exist
async stat(path: string): Promise<Stats>
// Throws: ENOENT if path not found

// readdir() - throws ENOENT/ENOTDIR for invalid paths
async readdir(path: string): Promise<Dirent[]>
// Throws: ENOENT if directory not found, ENOTDIR if path is not a directory

// promote()/demote() - throws if file not found
async promote(path: string, targetTier: 'hot' | 'warm'): Promise<TieredStorageResult>
// Throws: Error if file not found

// copy() - throws ENOENT if source not found
async copy(sourcePath: string, destPath: string): Promise<BlobWriteResult>
// Throws: StorageError (ENOENT) if source not found
```

**Pattern: Operations where the caller expects the item to exist**

### Error Classes

#### FSError (core/errors.ts)

Use for POSIX filesystem operations:

```typescript
import { ENOENT, EEXIST, EISDIR, ENOTDIR, EACCES } from '@dotdo/fsx/core/errors'

// File not found
throw new ENOENT('open', '/path/to/file.txt')
// Error: ENOENT: no such file or directory, open '/path/to/file.txt'

// File already exists
throw new EEXIST('mkdir', '/existing/dir')

// Is a directory (when file expected)
throw new EISDIR('read', '/some/directory')

// Not a directory (when directory expected)
throw new ENOTDIR('readdir', '/path/to/file.txt')

// Permission denied
throw new EACCES('open', '/protected/file')
```

**Type guards for error handling:**

```typescript
import { isEnoent, isEexist, isFSError } from '@dotdo/fsx/core/errors'

try {
  await fs.readFile('/missing.txt')
} catch (err) {
  if (isEnoent(err)) {
    console.log('File not found:', err.path)
  }
}
```

#### StorageError (storage/interfaces.ts)

Use for storage backend operations:

```typescript
import { StorageError } from '@dotdo/fsx/storage/interfaces'

// Not found
throw StorageError.notFound('/path/to/blob', 'get')

// Already exists
throw StorageError.exists('/path/to/blob', 'put')

// Invalid argument
throw StorageError.invalidArg('Key exceeds max length', '/path', 'put')

// I/O error (wrapping underlying error)
throw StorageError.io(originalError, '/path', 'get')

// Direct construction for other cases
throw new StorageError('ENOSPC', 'Storage quota exceeded', {
  path: '/path',
  operation: 'put'
})
```

### Validation Errors

Throw errors immediately for invalid arguments:

```typescript
// Hash validation - throw for invalid format
function validateHash(hash: string): void {
  if (hash.length !== 40 && hash.length !== 64) {
    throw new Error(`Invalid hash length: expected 40 or 64, got ${hash.length}`)
  }
  if (!/^[0-9a-fA-F]+$/.test(hash)) {
    throw new Error('Invalid hash: contains non-hex characters')
  }
}

// Path validation - throw for invalid paths
if (path.includes('\0')) {
  throw new EINVAL('open', path)
}
```

### Summary Table

| Operation Type | Not Found Behavior | Example |
|---------------|-------------------|---------|
| `get()` / `getObject()` | Return `null` | `storage.get('/key')` |
| `head()` | Return `null` | `storage.head('/key')` |
| `getStream()` | Return `null` | `storage.getStream('/key')` |
| `getRange()` | Return `null` | `storage.getRange('/key', 0, 100)` |
| `exists()` | Return `boolean` | `storage.exists('/key')` |
| `getTier()` | Return `null` | `storage.getTier('/key')` |
| `readFile()` | Throw `ENOENT` | `fs.readFile('/path')` |
| `stat()` / `lstat()` | Throw `ENOENT` | `fs.stat('/path')` |
| `readdir()` | Throw `ENOENT` | `fs.readdir('/path')` |
| `readlink()` | Throw `ENOENT` | `fs.readlink('/link')` |
| `copy()` (source) | Throw `ENOENT` | `storage.copy('/src', '/dest')` |
| `promote()` / `demote()` | Throw `Error` | `storage.promote('/key', 'hot')` |

### Best Practices

1. **Document error behavior** in JSDoc comments:
   ```typescript
   /**
    * Read file contents.
    * @param path - Path to file
    * @returns File contents as Uint8Array
    * @throws {ENOENT} If file does not exist
    * @throws {EISDIR} If path is a directory
    */
   async readFile(path: string): Promise<Uint8Array>
   ```

2. **Use type guards** for error discrimination:
   ```typescript
   if (isEnoent(err)) { /* handle not found */ }
   if (err instanceof StorageError && err.code === 'ENOENT') { /* handle */ }
   ```

3. **Include context** in error messages:
   ```typescript
   throw new ENOENT('readFile', normalizedPath)
   throw new StorageError('ENOENT', `Not found: ${path}`, { path, operation: 'get' })
   ```

4. **Wrap underlying errors** to preserve stack traces:
   ```typescript
   catch (error) {
     throw StorageError.io(error as Error, path, 'put')
   }
   ```

## Code Style

- Use TypeScript with strict mode enabled
- Follow existing formatting (Prettier handles this)
- Prefer `async/await` over raw Promises
- Use meaningful variable names
- Add JSDoc comments for public APIs

## Testing

- Write tests for new functionality
- Run `npm test` before submitting PRs
- Test both success and error cases
- Use the mock backends for unit tests

### Testing Error Cases

```typescript
import { describe, it, expect } from 'vitest'

describe('readFile', () => {
  it('should throw ENOENT for missing file', async () => {
    await expect(fs.readFile('/nonexistent')).rejects.toThrow(ENOENT)
  })
})

describe('get', () => {
  it('should return null for missing blob', async () => {
    const result = await storage.get('/nonexistent')
    expect(result).toBeNull()
  })
})
```
