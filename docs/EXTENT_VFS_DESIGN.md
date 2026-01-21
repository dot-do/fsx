# Production-Grade Extent-Based VFS for SQLite & PostgreSQL

## Problem Statement

Current db-branching stores each database page individually:
- SQLite: 4KB pages → 25,000 blobs per 100MB database
- PostgreSQL: 8KB pages → 12,500 blobs per 100MB database

**Cost Impact (Durable Objects):**
- DO bills per row operation (~$1/million rows)
- 25,000 writes for 100MB = expensive
- Target: 50 writes for 100MB (2MB extents) = 500x cheaper

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Application Layer                                 │
├─────────────────────────────────────────────────────────────────────┤
│  SQLiteVFS Adapter          │         PGliteFS Adapter              │
│  (xRead, xWrite, xSync)     │   (read, write, mkdir, readdir)       │
├─────────────────────────────────────────────────────────────────────┤
│                      BranchManager (COW)                            │
│            (branch creation, switching, merging)                     │
├─────────────────────────────────────────────────────────────────────┤
│                      ExtentStorage Layer                            │
│     (packs 4KB/8KB pages into 2MB extents, compression)             │
├─────────────────────────────────────────────────────────────────────┤
│                    fsx BlobStorage Interface                        │
│           (R2Storage, MemoryBlobStorage, etc.)                      │
├─────────────────────────────────────────────────────────────────────┤
│                     Physical Storage                                 │
│              (R2, DO SQLite, Memory)                                │
└─────────────────────────────────────────────────────────────────────┘
```

## 1. ExtentStorage Layer

### Core Concept

An **extent** is a contiguous group of pages stored as a single blob:
- Default extent size: 2MB (configurable)
- Contains: 512 × 4KB pages OR 256 × 8KB pages
- Stored with metadata header for page mapping

### Extent Format

```
┌──────────────────────────────────────────────────────────────┐
│ Extent Header (64 bytes)                                      │
├──────────────────────────────────────────────────────────────┤
│ magic: 4 bytes ("EXT1")                                      │
│ version: 2 bytes                                              │
│ flags: 2 bytes (compressed, encrypted, etc.)                  │
│ pageSize: 4 bytes (4096 or 8192)                             │
│ pageCount: 4 bytes (number of pages in this extent)          │
│ extentSize: 4 bytes (total data size after header)           │
│ checksum: 8 bytes (xxhash64 of data)                         │
│ reserved: 36 bytes                                            │
├──────────────────────────────────────────────────────────────┤
│ Page Bitmap (variable, ceil(pageCount/8) bytes)              │
│ - Indicates which pages are present (sparse extent support)   │
├──────────────────────────────────────────────────────────────┤
│ Page Data (pageCount × pageSize bytes)                       │
│ - Contiguous page data, or compressed if flag set            │
└──────────────────────────────────────────────────────────────┘
```

### Interface

```typescript
interface ExtentStorageConfig {
  pageSize: number;              // 4096 (SQLite) or 8192 (Postgres)
  extentSize: number;            // Default: 2MB (2 * 1024 * 1024)
  compression?: CompressionCodec; // 'none' | 'gzip' | 'zstd'
  backend: BlobStorage;          // fsx BlobStorage for actual storage
}

interface ExtentStorage {
  // Read a page by its logical page number
  readPage(fileId: string, pageNum: number): Promise<Uint8Array | null>;

  // Write a page (buffers until extent is full or flush)
  writePage(fileId: string, pageNum: number, data: Uint8Array): Promise<void>;

  // Flush all buffered pages to extents
  flush(): Promise<void>;

  // Get file size in bytes
  getFileSize(fileId: string): Promise<number>;

  // Truncate file to specified size
  truncate(fileId: string, size: number): Promise<void>;

  // Delete a file and all its extents
  deleteFile(fileId: string): Promise<void>;

  // List all files
  listFiles(): Promise<string[]>;
}
```

### Metadata Schema (SQLite)

```sql
-- Track files and their extent mappings
CREATE TABLE extent_files (
  file_id TEXT PRIMARY KEY,
  page_size INTEGER NOT NULL,      -- 4096 or 8192
  file_size INTEGER NOT NULL DEFAULT 0,
  extent_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
);

-- Track individual extents
CREATE TABLE extents (
  extent_id TEXT PRIMARY KEY,      -- UUID or content hash
  file_id TEXT NOT NULL,
  extent_index INTEGER NOT NULL,   -- 0, 1, 2... for sequential extents
  start_page INTEGER NOT NULL,     -- First page number in this extent
  page_count INTEGER NOT NULL,     -- Number of pages stored
  compressed INTEGER NOT NULL DEFAULT 0,
  original_size INTEGER,           -- Size before compression
  stored_size INTEGER NOT NULL,    -- Actual stored size
  checksum TEXT,
  UNIQUE(file_id, extent_index),
  FOREIGN KEY (file_id) REFERENCES extent_files(file_id)
);

-- Index for fast page lookups
CREATE INDEX idx_extents_file_start ON extents(file_id, start_page);

-- Track dirty pages in write buffer
CREATE TABLE dirty_pages (
  file_id TEXT NOT NULL,
  page_num INTEGER NOT NULL,
  data BLOB NOT NULL,
  modified_at INTEGER NOT NULL,
  PRIMARY KEY (file_id, page_num)
);
```

### Write Path

```typescript
async writePage(fileId: string, pageNum: number, data: Uint8Array): Promise<void> {
  // 1. Buffer the page in dirty_pages table
  await this.sql.exec(`
    INSERT OR REPLACE INTO dirty_pages (file_id, page_num, data, modified_at)
    VALUES (?, ?, ?, ?)
  `, [fileId, pageNum, data, Date.now()]);

  // 2. Check if we have enough dirty pages to form an extent
  const dirtyCount = await this.getDirtyPageCount(fileId);
  const pagesPerExtent = this.extentSize / this.pageSize;

  if (dirtyCount >= pagesPerExtent) {
    await this.flushExtent(fileId);
  }
}

async flushExtent(fileId: string): Promise<void> {
  // 1. Get all dirty pages for this file, sorted by page number
  const dirtyPages = await this.getDirtyPages(fileId);

  // 2. Group into extent-sized chunks
  const extentGroups = this.groupPagesIntoExtents(dirtyPages);

  for (const group of extentGroups) {
    // 3. Build extent with header + bitmap + data
    const extent = this.buildExtent(group);

    // 4. Optionally compress
    const stored = this.compression
      ? await compress(extent, this.compression)
      : extent;

    // 5. Write to BlobStorage
    const extentId = await computeHash(stored);
    await this.backend.put(`extent/${extentId}`, stored);

    // 6. Update metadata
    await this.updateExtentMetadata(fileId, group, extentId, stored.length);

    // 7. Clear dirty pages that were flushed
    await this.clearDirtyPages(fileId, group.map(p => p.pageNum));
  }
}
```

### Read Path

```typescript
async readPage(fileId: string, pageNum: number): Promise<Uint8Array | null> {
  // 1. Check dirty pages first (write buffer)
  const dirty = await this.getDirtyPage(fileId, pageNum);
  if (dirty) return dirty;

  // 2. Find which extent contains this page
  const extentInfo = await this.findExtentForPage(fileId, pageNum);
  if (!extentInfo) return null; // Page doesn't exist

  // 3. Fetch extent from BlobStorage (with caching)
  const extentData = await this.getExtent(extentInfo.extentId);

  // 4. Decompress if needed
  const extent = extentInfo.compressed
    ? await decompress(extentData)
    : extentData;

  // 5. Extract the specific page
  const offsetInExtent = (pageNum - extentInfo.startPage) * this.pageSize;
  const headerSize = 64 + Math.ceil(extentInfo.pageCount / 8);
  return extent.slice(
    headerSize + offsetInExtent,
    headerSize + offsetInExtent + this.pageSize
  );
}
```

## 2. SQLite VFS Adapter

### Interface (wa-sqlite compatible)

```typescript
interface SQLiteVFS {
  // VFS methods
  xOpen(filename: string, flags: number): Promise<FileHandle>;
  xDelete(filename: string, syncDir: boolean): Promise<void>;
  xAccess(filename: string, flags: number): Promise<boolean>;

  // File methods
  xClose(handle: FileHandle): Promise<void>;
  xRead(handle: FileHandle, buffer: Uint8Array, offset: number): Promise<number>;
  xWrite(handle: FileHandle, buffer: Uint8Array, offset: number): Promise<void>;
  xTruncate(handle: FileHandle, size: number): Promise<void>;
  xSync(handle: FileHandle, flags: number): Promise<void>;
  xFileSize(handle: FileHandle): Promise<number>;
  xLock(handle: FileHandle, level: number): Promise<void>;
  xUnlock(handle: FileHandle, level: number): Promise<void>;
}
```

### Implementation

```typescript
class ExtentSQLiteVFS implements SQLiteVFS {
  constructor(
    private extentStorage: ExtentStorage,
    private branchManager?: BranchManager // For COW branching
  ) {}

  async xRead(
    handle: FileHandle,
    buffer: Uint8Array,
    offset: number
  ): Promise<number> {
    const pageSize = 4096;
    const startPage = Math.floor(offset / pageSize);
    const endPage = Math.ceil((offset + buffer.length) / pageSize);

    let bytesRead = 0;
    for (let pageNum = startPage; pageNum < endPage; pageNum++) {
      // Read page (with COW resolution if branching enabled)
      const page = this.branchManager
        ? await this.branchManager.readPage(handle.fileId, pageNum)
        : await this.extentStorage.readPage(handle.fileId, pageNum);

      if (!page) {
        // Sparse file - zero fill
        buffer.fill(0, bytesRead, bytesRead + pageSize);
      } else {
        // Copy relevant portion
        const pageOffset = pageNum === startPage ? offset % pageSize : 0;
        const copyLen = Math.min(pageSize - pageOffset, buffer.length - bytesRead);
        buffer.set(page.subarray(pageOffset, pageOffset + copyLen), bytesRead);
      }
      bytesRead += pageSize;
    }

    return Math.min(bytesRead, buffer.length);
  }

  async xWrite(
    handle: FileHandle,
    buffer: Uint8Array,
    offset: number
  ): Promise<void> {
    const pageSize = 4096;
    const startPage = Math.floor(offset / pageSize);

    // Handle partial page writes (read-modify-write)
    const offsetInPage = offset % pageSize;
    if (offsetInPage !== 0 || buffer.length < pageSize) {
      // Partial write - need to read existing page first
      const existingPage = await this.extentStorage.readPage(
        handle.fileId,
        startPage
      ) ?? new Uint8Array(pageSize);

      existingPage.set(buffer, offsetInPage);
      await this.extentStorage.writePage(handle.fileId, startPage, existingPage);
    } else {
      // Full page writes
      for (let i = 0; i < buffer.length; i += pageSize) {
        const pageNum = startPage + Math.floor(i / pageSize);
        const pageData = buffer.subarray(i, i + pageSize);
        await this.extentStorage.writePage(handle.fileId, pageNum, pageData);
      }
    }

    // Update file size if extended
    const newSize = offset + buffer.length;
    const currentSize = await this.extentStorage.getFileSize(handle.fileId);
    if (newSize > currentSize) {
      await this.extentStorage.setFileSize(handle.fileId, newSize);
    }
  }

  async xSync(handle: FileHandle, flags: number): Promise<void> {
    await this.extentStorage.flush();
  }
}
```

## 3. PGlite FS Adapter

### Interface (BaseFilesystem compatible)

```typescript
class ExtentPGliteFS extends BaseFilesystem {
  constructor(
    private extentStorage: ExtentStorage,
    private branchManager?: BranchManager
  ) {
    super();
  }

  // File descriptor tracking
  private fdCounter = 0;
  private openFiles = new Map<number, OpenFile>();

  open(path: string, flags?: string, mode?: number): number {
    const fd = ++this.fdCounter;
    this.openFiles.set(fd, {
      path,
      fileId: this.pathToFileId(path),
      position: 0,
      flags
    });
    return fd;
  }

  read(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ): number {
    const file = this.openFiles.get(fd);
    if (!file) throw new FsError('EBADF');

    const pageSize = 8192; // PostgreSQL uses 8KB pages
    const startPage = Math.floor(position / pageSize);
    const endPage = Math.ceil((position + length) / pageSize);

    let bytesRead = 0;
    for (let pageNum = startPage; pageNum < endPage && bytesRead < length; pageNum++) {
      const page = this.extentStorage.readPageSync(file.fileId, pageNum);

      if (!page) {
        // Sparse - zero fill
        const fillLen = Math.min(pageSize, length - bytesRead);
        buffer.fill(0, offset + bytesRead, offset + bytesRead + fillLen);
        bytesRead += fillLen;
      } else {
        const pageOffset = pageNum === startPage ? position % pageSize : 0;
        const copyLen = Math.min(pageSize - pageOffset, length - bytesRead);
        buffer.set(
          page.subarray(pageOffset, pageOffset + copyLen),
          offset + bytesRead
        );
        bytesRead += copyLen;
      }
    }

    return bytesRead;
  }

  write(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number
  ): number {
    const file = this.openFiles.get(fd);
    if (!file) throw new FsError('EBADF');

    const pageSize = 8192;
    const startPage = Math.floor(position / pageSize);

    let bytesWritten = 0;
    while (bytesWritten < length) {
      const pageNum = startPage + Math.floor((position + bytesWritten) / pageSize);
      const pageOffset = (position + bytesWritten) % pageSize;

      // Read-modify-write for partial pages
      let page = this.extentStorage.readPageSync(file.fileId, pageNum)
        ?? new Uint8Array(pageSize);

      const copyLen = Math.min(pageSize - pageOffset, length - bytesWritten);
      page.set(
        buffer.subarray(offset + bytesWritten, offset + bytesWritten + copyLen),
        pageOffset
      );

      this.extentStorage.writePageSync(file.fileId, pageNum, page);
      bytesWritten += copyLen;
    }

    return bytesWritten;
  }

  // Directory operations use metadata tables
  mkdir(path: string, options?: { recursive?: boolean }): void {
    this.sql.exec(`
      INSERT INTO fs_directories (path, mode, created_at)
      VALUES (?, ?, ?)
    `, [path, options?.mode ?? 0o755, Date.now()]);
  }

  readdir(path: string): string[] {
    const rows = this.sql.exec(`
      SELECT name FROM fs_entries WHERE parent_path = ?
    `, [path]);
    return rows.map(r => r.name);
  }
}
```

## 4. Branch Manager (COW Support)

### Interface

```typescript
interface BranchManager {
  // Branch operations
  createBranch(name: string, fromBranch?: string): Promise<BranchId>;
  switchBranch(name: string): Promise<void>;
  deleteBranch(name: string): Promise<void>;
  listBranches(): Promise<Branch[]>;

  // COW page access
  readPage(fileId: string, pageNum: number): Promise<Uint8Array | null>;
  writePage(fileId: string, pageNum: number, data: Uint8Array): Promise<void>;

  // Commit/snapshot
  commit(message: string): Promise<CommitId>;
  checkout(commitId: CommitId): Promise<void>;
}
```

### COW Read Resolution

```typescript
async readPage(fileId: string, pageNum: number): Promise<Uint8Array | null> {
  // Walk up the branch hierarchy until we find the page
  let branch = this.currentBranch;

  while (branch) {
    // Check this branch's extent storage
    const page = await this.getPageFromBranch(branch, fileId, pageNum);
    if (page) return page;

    // Page not in this branch, check parent
    branch = branch.parentBranch;
  }

  // Page doesn't exist in any ancestor
  return null;
}
```

### COW Write (Copy-on-Write)

```typescript
async writePage(fileId: string, pageNum: number, data: Uint8Array): Promise<void> {
  // Always write to current branch's extent storage
  // Parent branches are never modified (immutable)
  await this.currentBranch.extentStorage.writePage(fileId, pageNum, data);

  // Track that this page is now in current branch
  await this.markPageInBranch(this.currentBranch.id, fileId, pageNum);
}
```

## 5. Implementation Plan

### Phase 1: ExtentStorage Core (Week 1)
- [ ] Create `storage/extent-storage.ts` in fsx
- [ ] Implement extent format (header, bitmap, data)
- [ ] Implement write buffer with dirty page tracking
- [ ] Implement extent packing and flushing
- [ ] Implement page read with extent lookup
- [ ] Add compression support (optional gzip/zstd)
- [ ] Write unit tests (target: 50+ tests)

### Phase 2: SQLite VFS Adapter (Week 2)
- [ ] Create `vfs/sqlite-vfs.ts` in fsx
- [ ] Implement wa-sqlite compatible interface
- [ ] Implement xRead/xWrite with extent storage
- [ ] Implement xSync with flush
- [ ] Implement lock tracking (no-op for single connection)
- [ ] Add WAL stub support
- [ ] Integration test with actual SQLite WASM

### Phase 3: PGlite FS Adapter (Week 2-3)
- [ ] Create `vfs/pglite-fs.ts` in fsx
- [ ] Implement BaseFilesystem interface
- [ ] Implement file operations (open, read, write, close)
- [ ] Implement directory operations (mkdir, readdir, rmdir)
- [ ] Add file descriptor management
- [ ] Integration test with actual PGlite

### Phase 4: Branch Manager (Week 3-4)
- [ ] Create `vfs/branch-manager.ts` in fsx
- [ ] Implement branch creation/switching
- [ ] Implement COW read resolution
- [ ] Implement COW write isolation
- [ ] Add commit/snapshot support
- [ ] Add merge support (optional)
- [ ] Write comprehensive tests

### Phase 5: Integration & Testing (Week 4)
- [ ] End-to-end tests with real SQLite databases
- [ ] End-to-end tests with real PGlite databases
- [ ] Performance benchmarks (compare 4KB vs 2MB storage)
- [ ] Cost analysis (DO row operations)
- [ ] Documentation

## 6. Cost Analysis

### Before (4KB pages)
```
100MB database = 25,600 pages
Write all pages = 25,600 DO row operations
Cost: ~$0.026 per full database write
```

### After (2MB extents)
```
100MB database = 50 extents
Write all extents = 50 DO row operations
Cost: ~$0.00005 per full database write
```

**Savings: ~500x reduction in write costs**

### Read Cost (with caching)
- Extent cache in memory reduces repeated reads
- Range reads fetch only needed extents
- Compression reduces storage costs further

## 7. Files to Create

```
fsx/
├── storage/
│   ├── extent-storage.ts        # Core extent packing layer
│   ├── extent-format.ts         # Extent binary format
│   └── __tests__/
│       └── extent-storage.test.ts
├── vfs/
│   ├── sqlite-vfs.ts            # SQLite VFS adapter
│   ├── pglite-fs.ts             # PGlite FS adapter
│   ├── branch-manager.ts        # COW branching
│   └── __tests__/
│       ├── sqlite-vfs.test.ts
│       ├── pglite-fs.test.ts
│       └── branch-manager.test.ts
└── docs/
    └── EXTENT_VFS_DESIGN.md     # This document
```
