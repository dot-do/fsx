# FSx API Reference

This document provides a complete API reference for all public exports from the `fsx.do` package.

## Table of Contents

- [Overview](#overview)
- [FSx Class](#fsx-class)
- [Storage Backends](#storage-backends)
- [Durable Object Integration](#durable-object-integration)
- [Types and Interfaces](#types-and-interfaces)
- [Error Classes](#error-classes)
- [Utilities](#utilities)

---

## Overview

The `fsx.do` package provides a virtual filesystem backed by Cloudflare Durable Objects with tiered storage. It exports both **framework code** (runtime-agnostic) and **application code** (Cloudflare-specific).

### Quick Start

```typescript
import { fs } from 'fsx.do'

// Write a file
await fs.writeFile('/hello.txt', 'Hello, World!')

// Read a file
const content = await fs.readFile('/hello.txt', 'utf-8')
console.log(content) // 'Hello, World!'

// Check if file exists
const exists = await fs.exists('/hello.txt')
```

### Creating Custom Instances

```typescript
import { createFs, MemoryBackend } from 'fsx.do'

// Create with default in-memory backend
const testFs = createFs()

// Create with custom configuration
const customFs = createFs({
  maxFileSize: 50 * 1024 * 1024, // 50MB limit
  defaultMode: 0o600,
})

// Create with custom backend
const backend = new MemoryBackend()
const fs = createFs({ backend })
```

---

## FSx Class

The `FSx` class is the main filesystem API. It provides POSIX-like operations backed by a pluggable storage backend.

### Constructor

```typescript
new FSx(backend: FsBackend, options?: FSxOptions)
```

#### FSxOptions

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `tiers` | `object` | See below | Storage tier thresholds |
| `tiers.hotMaxSize` | `number` | `1048576` (1MB) | Max size for hot tier (DO SQLite) |
| `tiers.warmEnabled` | `boolean` | `true` | Enable warm tier (R2) |
| `tiers.coldEnabled` | `boolean` | `false` | Enable cold tier (archive) |
| `defaultMode` | `number` | `0o644` | Default file permissions |
| `defaultDirMode` | `number` | `0o755` | Default directory permissions |
| `tmpMaxAge` | `number` | `86400000` (24h) | Temp file max age in ms |
| `maxFileSize` | `number` | `104857600` (100MB) | Max file size in bytes |
| `maxPathLength` | `number` | `4096` | Max path length |
| `uid` | `number` | `0` | Default user ID |
| `gid` | `number` | `0` | Default group ID |

### File Operations

#### `readFile(path, encoding?)`

Read a file's contents.

```typescript
readFile(path: string, encoding?: BufferEncoding): Promise<string | Uint8Array>
```

**Parameters:**
- `path` - Path to the file
- `encoding` - Output encoding: `'utf-8'`, `'utf8'`, `'base64'`, or `undefined` for raw bytes

**Returns:** File contents as string (with encoding) or `Uint8Array` (without)

**Throws:** `ENOENT` if file doesn't exist, `EISDIR` if path is a directory

```typescript
// Read as UTF-8 string (default)
const text = await fs.readFile('/hello.txt')

// Read as raw bytes
const bytes = await fs.readFile('/image.png', undefined)

// Read as base64
const base64 = await fs.readFile('/image.png', 'base64')
```

#### `writeFile(path, data, options?)`

Write data to a file.

```typescript
writeFile(
  path: string,
  data: string | Uint8Array,
  options?: { mode?: number; flag?: string }
): Promise<void>
```

**Parameters:**
- `path` - Path to the file
- `data` - Content to write
- `options.mode` - File permissions (default: `0o644`)
- `options.flag` - File system flag: `'w'` (write), `'a'` (append), `'wx'` (exclusive create)

```typescript
// Write a string
await fs.writeFile('/hello.txt', 'Hello, World!')

// Write binary data
await fs.writeFile('/data.bin', new Uint8Array([1, 2, 3]))

// Write with specific permissions
await fs.writeFile('/script.sh', '#!/bin/bash', { mode: 0o755 })
```

#### `appendFile(path, data)`

Append data to a file.

```typescript
appendFile(path: string, data: string | Uint8Array): Promise<void>
```

```typescript
await fs.appendFile('/log.txt', 'New log entry\n')
```

#### `unlink(path)`

Delete a file.

```typescript
unlink(path: string): Promise<void>
```

**Throws:** `ENOENT` if file doesn't exist, `EISDIR` if path is a directory

```typescript
await fs.unlink('/old-file.txt')
```

#### `rename(oldPath, newPath)`

Rename or move a file or directory.

```typescript
rename(oldPath: string, newPath: string): Promise<void>
```

```typescript
// Rename a file
await fs.rename('/old-name.txt', '/new-name.txt')

// Move to another directory
await fs.rename('/file.txt', '/archive/file.txt')
```

#### `copyFile(src, dest, flags?)`

Copy a file.

```typescript
copyFile(src: string, dest: string, flags?: number): Promise<void>
```

```typescript
// Simple copy
await fs.copyFile('/original.txt', '/backup.txt')

// Fail if destination exists
await fs.copyFile('/src.txt', '/dst.txt', constants.COPYFILE_EXCL)
```

#### `truncate(path, length?)`

Truncate a file to a specified length.

```typescript
truncate(path: string, length?: number): Promise<void>
```

```typescript
// Clear a file
await fs.truncate('/myfile.txt')

// Truncate to first 100 bytes
await fs.truncate('/myfile.txt', 100)
```

### Directory Operations

#### `mkdir(path, options?)`

Create a directory.

```typescript
mkdir(path: string, options?: MkdirOptions): Promise<void>
```

**MkdirOptions:**
- `recursive` - Create parent directories if needed (default: `false`)
- `mode` - Directory permissions (default: `0o755`)

```typescript
// Create a single directory
await fs.mkdir('/mydir')

// Create nested directories (like mkdir -p)
await fs.mkdir('/a/b/c', { recursive: true })
```

#### `rmdir(path, options?)`

Remove a directory.

```typescript
rmdir(path: string, options?: RmdirOptions): Promise<void>
```

**RmdirOptions:**
- `recursive` - Remove contents recursively (default: `false`)

```typescript
// Remove empty directory
await fs.rmdir('/empty-dir')

// Remove directory and all contents (like rm -r)
await fs.rmdir('/full-dir', { recursive: true })
```

#### `rm(path, options?)`

Remove a file or directory.

```typescript
rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
```

**Options:**
- `recursive` - Remove directories and contents (default: `false`)
- `force` - Ignore if path doesn't exist (default: `false`)

```typescript
// Remove a file
await fs.rm('/file.txt')

// Remove directory tree (like rm -rf)
await fs.rm('/directory', { recursive: true, force: true })
```

#### `readdir(path, options?)`

Read directory contents.

```typescript
readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]>
```

**ReaddirOptions:**
- `withFileTypes` - Return `Dirent` objects instead of strings (default: `false`)
- `recursive` - Include subdirectory contents (default: `false`)

```typescript
// List filenames
const files = await fs.readdir('/mydir')
// ['file1.txt', 'file2.txt', 'subdir']

// List with file types
const entries = await fs.readdir('/mydir', { withFileTypes: true })
entries.forEach(e => console.log(e.name, e.isDirectory()))
```

### Metadata Operations

#### `stat(path)`

Get file or directory statistics.

```typescript
stat(path: string): Promise<Stats>
```

Returns a `Stats` object with:
- `size` - File size in bytes
- `mode` - File permissions and type
- `atime`, `mtime`, `ctime`, `birthtime` - Timestamps
- `isFile()`, `isDirectory()`, `isSymbolicLink()` - Type checks

```typescript
const stats = await fs.stat('/myfile.txt')
console.log(stats.size)        // File size in bytes
console.log(stats.isFile())    // true
console.log(stats.mtime)       // Last modification time
```

#### `lstat(path)`

Get statistics without following symbolic links.

```typescript
lstat(path: string): Promise<Stats>
```

```typescript
const stats = await fs.lstat('/link')
if (stats.isSymbolicLink()) {
  const target = await fs.readlink('/link')
}
```

#### `exists(path)`

Check if a path exists.

```typescript
exists(path: string): Promise<boolean>
```

```typescript
if (await fs.exists('/config.json')) {
  const config = await fs.readFile('/config.json')
}
```

#### `access(path, mode?)`

Check file access permissions.

```typescript
access(path: string, mode?: number): Promise<void>
```

**Mode constants:**
- `constants.F_OK` - Check existence
- `constants.R_OK` - Check read permission
- `constants.W_OK` - Check write permission
- `constants.X_OK` - Check execute permission

```typescript
// Check if file exists
await fs.access('/myfile.txt')

// Check if file is readable and writable
await fs.access('/myfile.txt', constants.R_OK | constants.W_OK)
```

#### `chmod(path, mode)`

Change file permissions.

```typescript
chmod(path: string, mode: number): Promise<void>
```

```typescript
// Make a script executable
await fs.chmod('/script.sh', 0o755)

// Read-only for owner only
await fs.chmod('/secret.txt', 0o400)
```

#### `chown(path, uid, gid)`

Change file ownership.

```typescript
chown(path: string, uid: number, gid: number): Promise<void>
```

```typescript
await fs.chown('/myfile.txt', 1000, 1000)
```

#### `utimes(path, atime, mtime)`

Update file timestamps.

```typescript
utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void>
```

```typescript
// Set timestamps to current time
const now = new Date()
await fs.utimes('/myfile.txt', now, now)

// Set to specific Unix timestamp
await fs.utimes('/myfile.txt', 1704067200000, 1704067200000)
```

### Symbolic Links

#### `symlink(target, path)`

Create a symbolic link.

```typescript
symlink(target: string, path: string): Promise<void>
```

```typescript
// Create symlink to a file
await fs.symlink('/data/config.json', '/config.json')

// Create symlink with relative target
await fs.symlink('../shared/lib', '/app/lib')
```

#### `link(existingPath, newPath)`

Create a hard link.

```typescript
link(existingPath: string, newPath: string): Promise<void>
```

```typescript
await fs.link('/original.txt', '/hardlink.txt')
```

#### `readlink(path)`

Read the target of a symbolic link.

```typescript
readlink(path: string): Promise<string>
```

```typescript
const target = await fs.readlink('/mylink')
console.log(target) // '/actual/file/path'
```

#### `realpath(path)`

Resolve the absolute path, following symbolic links.

```typescript
realpath(path: string): Promise<string>
```

```typescript
const real = await fs.realpath('/app/../data/./link')
console.log(real) // '/data/actual-file'
```

### Streams

#### `createReadStream(path, options?)`

Create a readable stream for a file.

```typescript
createReadStream(path: string, options?: ReadStreamOptions): Promise<ReadableStream<Uint8Array>>
```

**ReadStreamOptions:**
- `start` - Start byte offset
- `end` - End byte offset
- `highWaterMark` - Buffer size

```typescript
const stream = await fs.createReadStream('/large-file.bin')
for await (const chunk of stream) {
  process.write(chunk)
}
```

#### `createWriteStream(path, options?)`

Create a writable stream for a file.

```typescript
createWriteStream(path: string, options?: WriteStreamOptions): Promise<WritableStream<Uint8Array>>
```

**WriteStreamOptions:**
- `flags` - Open flags
- `mode` - File permissions
- `start` - Start position

```typescript
const stream = await fs.createWriteStream('/output.bin')
const writer = stream.getWriter()
await writer.write(new Uint8Array([1, 2, 3]))
await writer.close()
```

### File Watching

#### `watch(path, options?, listener?)`

Watch a file or directory for changes.

```typescript
watch(
  path: string,
  options?: WatchOptions,
  listener?: (eventType: string, filename: string) => void
): FSWatcher
```

**WatchOptions:**
- `recursive` - Watch subdirectories recursively (default: `false`)
- `persistent` - Keep process alive while watching (default: `true`)
- `encoding` - Encoding for filenames (default: `'utf-8'`)

**Event types:**
- `'change'` - File content modified
- `'rename'` - File created, deleted, or renamed

```typescript
const watcher = fs.watch('/mydir', {}, (event, filename) => {
  console.log(`${event}: ${filename}`)
})

// Watch recursively
const deepWatcher = fs.watch('/root', { recursive: true }, (event, filename) => {
  console.log(`${event}: ${filename}`)
})

// Stop watching
watcher.close()
```

### File Handles

#### `open(path, flags?, mode?)`

Open a file and get a file handle for low-level operations.

```typescript
open(path: string, flags?: string | number, mode?: number): Promise<FileHandle>
```

**Flags:**
- `'r'` - Read-only (file must exist)
- `'r+'` - Read/write (file must exist)
- `'w'` - Write-only (create/truncate)
- `'w+'` - Read/write (create/truncate)
- `'a'` - Append-only (create if needed)
- `'a+'` - Append/read (create if needed)
- `'x'` - Exclusive flag (combine with w/a)

```typescript
const handle = await fs.open('/data.bin', 'r+')
try {
  const buffer = new Uint8Array(1024)
  const { bytesRead } = await handle.read(buffer, 0, 1024, 0)
  await handle.write(new Uint8Array([1, 2, 3]), 0)
  await handle.sync()
} finally {
  await handle.close()
}
```

**FileHandle methods:**
- `read(buffer, offset, length, position)` - Read data
- `write(data, position)` - Write data
- `stat()` - Get file stats
- `truncate(length)` - Truncate file
- `sync()` - Sync to storage
- `close()` - Close handle

---

## Storage Backends

### FsBackend Interface

The pluggable storage backend interface. Implement this to create custom storage backends.

```typescript
interface FsBackend {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array, options?: WriteOptions): Promise<BackendWriteResult>
  unlink(path: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  mkdir(path: string, options?: MkdirOptions): Promise<void>
  rmdir(path: string, options?: RmdirOptions): Promise<void>
  readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]>
  stat(path: string): Promise<Stats>
  lstat(path: string): Promise<Stats>
  exists(path: string): Promise<boolean>
  // ... more methods
}
```

### MemoryBackend

In-memory filesystem backend for testing.

```typescript
import { MemoryBackend, FSx } from 'fsx.do'

const backend = new MemoryBackend()
const fs = new FSx(backend)

await fs.writeFile('/test.txt', 'Hello')
const content = await fs.readFile('/test.txt', 'utf-8')
```

### TieredFS

Multi-tier filesystem with automatic placement based on file size.

```typescript
import { TieredFS } from 'fsx.do'

const tiered = new TieredFS({
  hot: env.FSX_DO,           // Durable Object (fast, small files)
  warm: env.FSX_WARM_BUCKET, // R2 (larger files)
  cold: env.FSX_COLD_BUCKET, // R2 archive (infrequent access)
  thresholds: {
    hotMaxSize: 1024 * 1024,       // 1MB
    warmMaxSize: 100 * 1024 * 1024, // 100MB
  },
  promotionPolicy: 'on-access'
})

// Small files go to hot tier automatically
await tiered.writeFile('/config.json', JSON.stringify(config))

// Large files go to warm/cold tier
await tiered.writeFile('/data/large.bin', largeData)

// Read from any tier transparently
const { data, tier } = await tiered.readFile('/config.json')
console.log(`Read from ${tier} tier`)

// Manual tier management
await tiered.promote('/frequently-used.json', 'hot')
await tiered.demote('/old-data.json', 'cold')
```

**TieredFSConfig:**
- `hot` - Durable Object namespace (required)
- `warm` - R2 bucket for warm tier (optional)
- `cold` - R2 bucket for cold/archive tier (optional)
- `thresholds.hotMaxSize` - Max size for hot tier (default: 1MB)
- `thresholds.warmMaxSize` - Max size for warm tier (default: 100MB)
- `promotionPolicy` - `'none'`, `'on-access'`, `'aggressive'`

**Methods:**
- `writeFile(path, data)` - Write with automatic tier selection
- `readFile(path)` - Read from any tier
- `promote(path, tier)` - Move to higher tier
- `demote(path, tier)` - Move to lower tier
- `move(src, dest)` - Move file
- `copy(src, dest, options?)` - Copy file
- `deleteFile(path)` - Delete from any tier
- `getMetrics()` - Get cache/read/write statistics

### R2Storage

R2-backed blob storage implementing the `BlobStorage` interface.

```typescript
import { R2Storage } from 'fsx.do'

const storage = new R2Storage({
  bucket: env.MY_BUCKET,
  prefix: 'files/',
  hooks: {
    onOperationEnd: (ctx, result) => {
      console.log(`${ctx.operation} took ${result.durationMs}ms`)
    }
  }
})

// Store data
await storage.put('/data.json', new TextEncoder().encode('{}'))

// Retrieve data
const result = await storage.get('/data.json')
if (result) {
  console.log(`Size: ${result.metadata.size}`)
}

// Stream access
const stream = await storage.getStream('/large-file.bin')

// Range reads
const partial = await storage.getRange('/file.bin', 0, 1023)

// List with pagination
const list = await storage.list({ prefix: 'images/', limit: 100 })

// Multipart upload for large files
const upload = await storage.createMultipartUpload('/large.bin')
// ... upload parts ...
```

**R2StorageConfig:**
- `bucket` - R2 bucket binding
- `prefix` - Key prefix for all objects (default: `''`)
- `hooks` - Instrumentation hooks for metrics/logging
- `retry` - Retry configuration for transient errors

### R2Backend

R2-based backend for FSx that implements the `FsBackend` interface.

```typescript
import { R2Backend, FSx } from 'fsx.do'

const backend = new R2Backend({
  bucket: env.MY_BUCKET,
  prefix: 'fs/'
})
const fs = new FSx(backend)
```

### SQLiteMetadata

SQLite-backed metadata store for filesystem operations.

```typescript
import { SQLiteMetadata } from 'fsx.do'

const metadata = new SQLiteMetadata({
  sql: ctx.storage.sql
})
```

---

## Durable Object Integration

### FileSystemDO

Complete Durable Object with HTTP/RPC API for filesystem operations.

```typescript
// wrangler.toml
[[durable_objects.bindings]]
name = "FSX"
class_name = "FileSystemDO"

// Worker code
export { FileSystemDO } from 'fsx.do'

export default {
  async fetch(request, env) {
    const id = env.FSX.idFromName('my-fs')
    const stub = env.FSX.get(id)
    return stub.fetch(request)
  }
}
```

**HTTP Endpoints:**

- `POST /rpc` - JSON-RPC endpoint for all filesystem operations
- `POST /stream/read` - Streaming file read with Range support
- `POST /stream/write` - Streaming file write
- `GET /watch` - WebSocket endpoint for file change notifications

**RPC Example:**

```typescript
const response = await fetch(doStub, {
  method: 'POST',
  body: JSON.stringify({
    method: 'readFile',
    params: { path: '/config.json', encoding: 'utf-8' }
  })
})
const { data } = await response.json()
```

**WebSocket Watch Protocol:**

```typescript
const ws = new WebSocket('wss://fsx.do/watch?path=/home/user&recursive=true')

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  switch (msg.type) {
    case 'welcome':
      console.log(`Connected: ${msg.connectionId}`)
      break
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }))
      break
    case 'create':
    case 'modify':
    case 'delete':
    case 'rename':
      console.log(`${msg.type}: ${msg.path}`)
      break
  }
}
```

### FsModule

Standalone filesystem module with lazy initialization for use inside Durable Objects.

```typescript
import { FsModule } from 'fsx.do'

const fs = new FsModule({
  sql: ctx.storage.sql,
  r2: env.R2,
  archive: env.ARCHIVE
})

await fs.write('/config.json', JSON.stringify(config))
const content = await fs.read('/config.json', { encoding: 'utf-8' })
```

**FsModuleConfig:**
- `sql` - SQLite storage from DO context
- `r2` - R2 bucket for warm tier (optional)
- `archive` - R2 bucket for cold tier (optional)
- `basePath` - Base path for operations (optional)
- `hotMaxSize` - Max size for hot tier (optional)
- `defaultMode` - Default file permissions (optional)
- `defaultDirMode` - Default directory permissions (optional)

### withFs Mixin

Mixin function to add `$.fs` capability to Durable Object classes.

```typescript
import { withFs } from 'fsx.do'
import { DO } from 'dotdo'

class MySite extends withFs(DO) {
  async loadContent() {
    // $.fs is now available with full filesystem API
    const config = await this.$.fs.read('/config.json', { encoding: 'utf-8' })
    const files = await this.$.fs.list('/content')
    await this.$.fs.write('/cache/index.html', renderedContent)
  }
}

// With options
class MyApp extends withFs(DO, { hotMaxSize: 5 * 1024 * 1024 }) {
  async saveData(data: string) {
    await this.$.fs.write('/data.json', data)
  }
}
```

**WithFsOptions:**
- `basePath` - Base path for all operations
- `hotMaxSize` - Max file size for hot tier
- `defaultMode` - Default file permissions
- `defaultDirMode` - Default directory permissions
- `r2BindingName` - R2 bucket binding name (default: `'R2'`)
- `archiveBindingName` - Archive bucket binding name (default: `'ARCHIVE'`)

### Helper Functions

#### `hasFs(obj)`

Check if a context has the fs capability.

```typescript
function hasFs<T>(obj: T): obj is T & { $: WithFsContext }
```

#### `getFs(obj)`

Get the fs capability from a context.

```typescript
function getFs<T>(obj: T): FsModule
```

Throws if fs capability is not available.

---

## Types and Interfaces

### Stats

File/directory statistics object.

```typescript
class Stats {
  dev: number      // Device ID
  ino: number      // Inode number
  mode: number     // File type and permissions
  nlink: number    // Number of hard links
  uid: number      // Owner user ID
  gid: number      // Owner group ID
  rdev: number     // Device ID (for special files)
  size: number     // File size in bytes
  blksize: number  // Block size for I/O
  blocks: number   // Number of blocks allocated
  atime: Date      // Access time
  mtime: Date      // Modification time
  ctime: Date      // Change time
  birthtime: Date  // Creation time

  // Type check methods
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  isBlockDevice(): boolean
  isCharacterDevice(): boolean
  isFIFO(): boolean
  isSocket(): boolean
}
```

### Dirent

Directory entry object.

```typescript
class Dirent {
  name: string        // Entry name
  parentPath: string  // Parent directory path

  // Type check methods
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}
```

### FileHandle

File handle for low-level operations.

```typescript
interface FileHandle {
  fd: number  // File descriptor

  read(buffer: Uint8Array, offset?: number, length?: number, position?: number): Promise<{ bytesRead: number; buffer: Uint8Array }>
  write(data: Uint8Array | string, position?: number): Promise<{ bytesWritten: number }>
  stat(): Promise<Stats>
  truncate(length?: number): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>

  // Async disposable support
  [Symbol.asyncDispose](): Promise<void>
}
```

### StorageTier

```typescript
type StorageTier = 'hot' | 'warm' | 'cold'
```

### BufferEncoding

```typescript
type BufferEncoding = 'utf-8' | 'utf8' | 'base64' | 'hex' | 'ascii' | 'latin1' | 'binary'
```

### Constants

POSIX-compatible file system constants.

```typescript
import { constants } from 'fsx.do'

// Access modes
constants.F_OK  // Check existence
constants.R_OK  // Check read permission
constants.W_OK  // Check write permission
constants.X_OK  // Check execute permission

// Open flags
constants.O_RDONLY   // Read-only
constants.O_WRONLY   // Write-only
constants.O_RDWR     // Read/write
constants.O_CREAT    // Create if doesn't exist
constants.O_EXCL     // Fail if exists
constants.O_TRUNC    // Truncate to zero
constants.O_APPEND   // Append mode
constants.O_SYNC     // Synchronous I/O

// File type bits
constants.S_IFREG    // Regular file
constants.S_IFDIR    // Directory
constants.S_IFLNK    // Symbolic link

// Copy flags
constants.COPYFILE_EXCL       // Fail if dest exists
constants.COPYFILE_FICLONE    // Use copy-on-write if supported
```

---

## Error Classes

All error classes extend `FSError` and follow POSIX conventions.

### FSError (Base Class)

```typescript
class FSError extends Error {
  code: string      // POSIX error code (e.g., 'ENOENT')
  errno: number     // Numeric errno value
  syscall?: string  // System call that triggered error
  path?: string     // Source path
  dest?: string     // Destination path (for rename/copy)
}
```

### Error Types

| Class | Code | Description |
|-------|------|-------------|
| `ENOENT` | `ENOENT` | No such file or directory |
| `EEXIST` | `EEXIST` | File already exists |
| `EISDIR` | `EISDIR` | Illegal operation on a directory |
| `ENOTDIR` | `ENOTDIR` | Not a directory |
| `EACCES` | `EACCES` | Permission denied |
| `EPERM` | `EPERM` | Operation not permitted |
| `ENOTEMPTY` | `ENOTEMPTY` | Directory not empty |
| `EBADF` | `EBADF` | Bad file descriptor |
| `EINVAL` | `EINVAL` | Invalid argument |
| `ELOOP` | `ELOOP` | Too many symbolic links |
| `ENAMETOOLONG` | `ENAMETOOLONG` | File name too long |
| `ENOSPC` | `ENOSPC` | No space left on device |
| `EROFS` | `EROFS` | Read-only file system |
| `EBUSY` | `EBUSY` | Resource busy |
| `EMFILE` | `EMFILE` | Too many open files |
| `ENFILE` | `ENFILE` | File table overflow |
| `EXDEV` | `EXDEV` | Cross-device link |

### Error Handling Example

```typescript
import { fs, ENOENT, EEXIST, isFSError, hasErrorCode } from 'fsx.do'

try {
  await fs.readFile('/missing.txt')
} catch (error) {
  if (error instanceof ENOENT) {
    console.log('File not found:', error.path)
  } else if (isFSError(error)) {
    console.log(`FS Error: ${error.code}`)
  }
}

// Using type guards
if (hasErrorCode(error, 'ENOENT')) {
  // Handle missing file
}
```

### Type Guards

```typescript
isFSError(error): error is FSError
isEnoent(error): error is ENOENT
isEexist(error): error is EEXIST
isEisdir(error): error is EISDIR
isEnotdir(error): error is ENOTDIR
isEacces(error): error is EACCES
// ... etc for all error types
```

### Helper Functions

```typescript
// Check error code
hasErrorCode(error: unknown, code: ErrorCode): boolean

// Get error code
getErrorCode(error: unknown): ErrorCode | undefined

// Create error from code
createError(code: ErrorCode, syscall?: string, path?: string, dest?: string): FSError
```

---

## Utilities

### Path Utilities

```typescript
import { join, normalize, dirname, basename, extname, resolve, isAbsolute } from 'fsx.do'

join('/foo', 'bar', 'baz')     // '/foo/bar/baz'
normalize('/foo/../bar')        // '/bar'
dirname('/foo/bar/baz.txt')    // '/foo/bar'
basename('/foo/bar/baz.txt')   // 'baz.txt'
extname('/foo/bar/baz.txt')    // '.txt'
isAbsolute('/foo')             // true
```

### Glob Pattern Matching

```typescript
import { glob, match, createMatcher } from 'fsx.do'

// Find files matching pattern
const files = await glob(fs, '**/*.ts', { cwd: '/src' })

// Check if path matches pattern
match('/src/index.ts', '**/*.ts')  // true

// Create reusable matcher
const matcher = createMatcher('*.{js,ts}')
matcher('file.ts')  // true
matcher('file.py')  // false
```

**GlobOptions:**
- `cwd` - Base directory (default: `/`)
- `ignore` - Patterns to ignore
- `dot` - Include dotfiles (default: `false`)
- `nodir` - Exclude directories (default: `false`)
- `signal` - AbortSignal for cancellation

### Find

```typescript
import { find } from 'fsx.do'

const results = await find(fs, '/src', {
  name: '*.ts',
  type: 'file',
  maxDepth: 3,
  minSize: 1024,
  maxSize: 1024 * 1024
})
```

**FindOptions:**
- `name` - Filename pattern
- `type` - `'file'`, `'directory'`, or `'symlink'`
- `maxDepth` - Maximum recursion depth
- `minSize` / `maxSize` - File size filters
- `newer` / `older` - Modification time filters

### Grep

```typescript
import { grep } from 'fsx.do'

const results = await grep(fs, /TODO|FIXME/i, '**/*.ts', {
  cwd: '/src',
  context: 2
})

for (const match of results) {
  console.log(`${match.path}:${match.line}: ${match.text}`)
}
```

**GrepOptions:**
- `cwd` - Base directory
- `context` - Lines of context around matches
- `ignoreCase` - Case-insensitive matching
- `maxResults` - Limit number of results

### Content-Addressable Storage (CAS)

```typescript
import { ContentAddressableFS, sha256, bytesToHex } from 'fsx.do'

const cas = new ContentAddressableFS(backend)

// Store content by hash
const hash = await cas.put(new TextEncoder().encode('Hello'))

// Retrieve by hash
const data = await cas.get(hash)

// Hash utilities
const hashBytes = await sha256(data)
const hashHex = bytesToHex(hashBytes)
```

### Path Validation (Security)

```typescript
import { PathValidator, pathValidator } from 'fsx.do'

// Use singleton
const result = pathValidator.validatePath(userInput, '/jail/root')
if (!result.valid) {
  console.error(result.error)
}

// Create custom validator
const validator = new PathValidator({
  maxPathLength: 1024,
  maxNameLength: 255,
  allowedChars: /^[a-zA-Z0-9._-]+$/
})
```

**Security protections:**
- Path traversal prevention (CWE-22)
- Null byte injection detection (CWE-626)
- Path length limits (CWE-789)
- Control character blocking
- Unicode bidirectional override blocking

---

## Configuration

### createConfig

Create a configuration object with defaults.

```typescript
import { createConfig, isReadOnly, defaultConfig } from 'fsx.do'

const config = createConfig({
  maxFileSize: 50 * 1024 * 1024,
  readOnly: true
})

if (isReadOnly(config)) {
  console.log('Filesystem is read-only')
}
```

---

## Default Export

The package exports `FileSystemDO` as the default export for wrangler deployment.

```typescript
// wrangler.toml
[[durable_objects.bindings]]
name = "FSX"
class_name = "FileSystemDO"

// Worker
export { default } from 'fsx.do'
// or
export { FileSystemDO as default } from 'fsx.do'
```
