# JuiceFS Compatibility Assessment for fsx

This document analyzes JuiceFS's metadata format and assesses compatibility options with fsx's ExtentStorage architecture.

## Executive Summary

**Compatibility Assessment**: **Not Directly Compatible** - The metadata schemas are fundamentally different in their design philosophy and data organization. However, an adapter layer is feasible for specific use cases.

**Key Findings**:
1. JuiceFS uses a POSIX-centric inode/chunk/slice/block hierarchy optimized for FUSE mounting
2. fsx uses a page-based extent storage model optimized for database page management
3. Direct format compatibility is not practical, but interoperability is achievable through adapters

---

## JuiceFS Metadata Schema

### Overview

JuiceFS separates metadata and data storage:
- **Metadata**: Stored in Redis, MySQL, PostgreSQL, SQLite, or TiKV
- **Data**: Stored in object storage (S3, R2, MinIO, etc.)

### SQL Schema Tables

JuiceFS uses approximately 18 tables for SQL-based metadata engines:

#### Core Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `jfs_node` | File/directory inodes | `Inode`, `Type`, `Mode`, `Uid`, `Gid`, `Atime`, `Mtime`, `Ctime`, `Nlink`, `Length`, `Parent` |
| `jfs_edge` | Directory entries | `Parent`, `Name`, `Inode`, `Type` |
| `jfs_chunk` | Chunk-to-slice mappings | `Inode`, `Indx`, `Slices` (blob) |
| `jfs_chunk_ref` | Slice reference counting | `Chunkid`, `Size`, `Refs` |
| `jfs_symlink` | Symbolic link targets | `Inode`, `Target` |

#### Supporting Tables

| Table | Purpose |
|-------|---------|
| `jfs_setting` | Filesystem settings (name, value) |
| `jfs_counter` | Global counters (nextInode, nextChunk, etc.) |
| `jfs_xattr` | Extended attributes |
| `jfs_acl` | Access control lists |
| `jfs_delfile` | Deleted files pending cleanup |
| `jfs_delslices` | Deleted slices pending garbage collection |
| `jfs_session2` | Client sessions |
| `jfs_flock` / `jfs_plock` | File and POSIX locks |
| `jfs_dir_stats` | Directory statistics |
| `jfs_dir_quota` | Directory quotas |

### Data Hierarchy: Chunks, Slices, and Blocks

JuiceFS organizes file data in a three-level hierarchy:

```
File (inode)
  |
  +-- Chunk 0 (64 MB max)
  |     |
  |     +-- Slice A (continuous write)
  |     |     +-- Block 0 (4 MB)
  |     |     +-- Block 1 (4 MB)
  |     |     +-- Block 2 (2 MB) [partial]
  |     |
  |     +-- Slice B (overlapping write)
  |           +-- Block 0 (4 MB)
  |
  +-- Chunk 1 (64 MB max)
        |
        +-- Slice C
              +-- Block 0 (4 MB)
```

**Key Concepts**:
- **Chunk**: Logical 64 MB container, fixed offset boundaries (0-64MB, 64-128MB, etc.)
- **Slice**: Result of a continuous write operation, can overlap with other slices
- **Block**: Physical storage unit (4 MB default), stored as individual objects

### Object Storage Key Format

JuiceFS stores blocks using this naming convention:

```
{volume}/chunks/{hash1}/{hash2}/{slice_id}_{block_id}_{block_size}
```

Where:
- `hash1` = `slice_id / 1,000,000`
- `hash2` = `slice_id / 1,000`

Example: Slice ID `12345678`, block `2`, size `4194304`:
```
myfs/chunks/12/12345/12345678_2_4194304
```

### Metadata Key Format (Redis/TiKV)

For key-value metadata engines, JuiceFS uses prefixed keys:

| Prefix | Purpose | Key Format |
|--------|---------|------------|
| `C` | Counters | `C{name}` |
| `A` | Attributes | `i{inode}` (binary) |
| `D` | Deleted inodes | `D{inode}` |
| `K` | Slice refs | `K{chunkid}` |
| `U` | Directory stats | `U{inode}` |
| `QD` | Quotas | `QD{inode}` |

---

## fsx ExtentStorage Schema

### Overview

fsx uses a page-based storage model optimized for database VFS operations:
- **Metadata**: Stored in SQLite (DO SqlStorage or D1)
- **Data**: Stored in R2 or Durable Object storage

### SQL Schema Tables

#### File Metadata (`files` table)

```sql
CREATE TABLE files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  parent_id INTEGER,
  type TEXT NOT NULL CHECK(type IN ('file', 'directory', 'symlink')),
  mode INTEGER NOT NULL DEFAULT 420,
  uid INTEGER NOT NULL DEFAULT 0,
  gid INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0,
  blob_id TEXT,
  link_target TEXT,
  tier TEXT NOT NULL DEFAULT 'hot' CHECK(tier IN ('hot', 'warm', 'cold')),
  atime INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  ctime INTEGER NOT NULL,
  birthtime INTEGER NOT NULL,
  nlink INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (parent_id) REFERENCES files(id) ON DELETE CASCADE
);
```

#### Blob Storage (`blobs` table)

```sql
CREATE TABLE blobs (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'hot' CHECK(tier IN ('hot', 'warm', 'cold')),
  size INTEGER NOT NULL,
  checksum TEXT,
  created_at INTEGER NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 1
);
```

### Extent Storage Layer

For database page management, fsx adds extent-based storage:

#### Extent Files (`extent_files` table)

```sql
CREATE TABLE extent_files (
  file_id TEXT PRIMARY KEY,
  page_size INTEGER NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  extent_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL
);
```

#### Extents (`extents` table)

```sql
CREATE TABLE extents (
  extent_id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  extent_index INTEGER NOT NULL,
  start_page INTEGER NOT NULL,
  page_count INTEGER NOT NULL,
  compressed INTEGER NOT NULL DEFAULT 0,
  original_size INTEGER,
  stored_size INTEGER NOT NULL,
  checksum TEXT,
  UNIQUE(file_id, extent_index)
);
```

#### Dirty Pages (`dirty_pages` table)

```sql
CREATE TABLE dirty_pages (
  file_id TEXT NOT NULL,
  page_num INTEGER NOT NULL,
  data BLOB NOT NULL,
  modified_at INTEGER NOT NULL,
  PRIMARY KEY (file_id, page_num)
);
```

### Extent Binary Format

fsx extents use a custom binary format:

```
+----------------------------------------------------------+
| Extent Header (64 bytes)                                  |
+----------------------------------------------------------+
| magic: 4 bytes ("EXT1" = 0x31545845)                     |
| version: 2 bytes (1)                                      |
| flags: 2 bytes (bit 0 = compressed)                       |
| pageSize: 4 bytes (4096 or 8192)                         |
| pageCount: 4 bytes                                        |
| extentSize: 4 bytes                                       |
| checksum: 8 bytes (FNV-1a)                               |
| reserved: 36 bytes                                        |
+----------------------------------------------------------+
| Page Bitmap (ceil(pageCount/8) bytes)                    |
+----------------------------------------------------------+
| Page Data (present pages x pageSize)                     |
+----------------------------------------------------------+
```

### Object Storage Key Format

fsx uses content-addressable extent storage:

```
extent/{sha256-hash-prefix-32}
```

Example:
```
extent/ext-a1b2c3d4e5f6789012345678901234ab
```

---

## Schema Comparison

### Fundamental Differences

| Aspect | JuiceFS | fsx |
|--------|---------|-----|
| **Primary Use Case** | FUSE filesystem | Database VFS / Edge storage |
| **Data Unit** | Files with chunks/slices/blocks | Pages with extents |
| **Block Size** | 4 MB (adjustable) | 4 KB / 8 KB (database pages) |
| **Container Size** | 64 MB chunks | 2 MB extents |
| **Path Storage** | Inode + edge traversal | Full path column |
| **Write Model** | Append slices, compact later | Page-level dirty tracking |
| **Addressing** | Inode-based | Path-based (with IDs) |
| **Deduplication** | Slice-level (optional) | Content-addressable extents |

### Metadata Mapping

| JuiceFS Concept | fsx Equivalent | Notes |
|-----------------|----------------|-------|
| `jfs_node` (inode) | `files` row | Similar attributes, different key structure |
| `jfs_edge` (dentry) | `files.parent_id` + `files.name` | fsx uses path-based lookups |
| `jfs_chunk` | `extents` | Different granularity (64MB vs 2MB) |
| `jfs_chunk_ref` (slices) | `blobs.ref_count` | fsx tracks at blob level |
| `jfs_symlink` | `files.link_target` | Directly on file row |
| Object blocks | Extent blobs | Different naming and sizing |

### Key Incompatibilities

1. **Granularity Mismatch**
   - JuiceFS: 4 MB blocks, 64 MB chunks
   - fsx: 4 KB pages, 2 MB extents
   - Impact: Cannot directly map storage units

2. **Slice Semantics**
   - JuiceFS: Multiple overlapping slices per chunk, resolved at read time
   - fsx: Single authoritative page version, dirty pages merged on flush
   - Impact: Different consistency models

3. **Inode vs Path Addressing**
   - JuiceFS: Numeric inode numbers, edge-based path resolution
   - fsx: String paths with parent_id references
   - Impact: Different lookup patterns

4. **Object Naming**
   - JuiceFS: `{volume}/chunks/{hash1}/{hash2}/{slice_id}_{block_id}_{size}`
   - fsx: `extent/{content-hash}`
   - Impact: No direct object mapping possible

---

## Compatibility Options

### Option 1: JuiceFS Metadata Adapter (Read-Only)

Create a read-only adapter that exposes fsx data through JuiceFS-compatible metadata.

**Approach**:
1. Generate synthetic inode numbers from fsx file IDs
2. Build edge table from parent_id relationships
3. Map blob storage to JuiceFS chunk format
4. Create virtual slices pointing to fsx blobs

**Pros**:
- Enables JuiceFS FUSE client to read fsx data
- No modification to fsx storage format

**Cons**:
- Read-only (writes would require complex sync)
- Performance overhead from translation
- File size limited by blob storage model

**Effort**: Medium (2-3 weeks)

### Option 2: Bidirectional Sync Layer

Implement a sync service that maintains both metadata formats.

**Approach**:
1. Write changes to fsx primary storage
2. Async worker syncs to JuiceFS metadata format
3. JuiceFS clients see eventually consistent view

**Pros**:
- Full JuiceFS FUSE compatibility
- Maintains fsx as source of truth

**Cons**:
- Complex conflict resolution
- Eventual consistency issues
- Double storage for metadata

**Effort**: High (4-6 weeks)

### Option 3: JuiceFS-Compatible Storage Mode

Add a new storage mode to fsx that uses JuiceFS-compatible formats.

**Approach**:
1. Implement JuiceFS metadata tables alongside fsx tables
2. Store data using JuiceFS object naming convention
3. Support both fsx and JuiceFS access patterns

**Pros**:
- Native JuiceFS FUSE mounting
- Single storage format

**Cons**:
- Significant implementation effort
- May compromise fsx optimizations
- Maintenance of two code paths

**Effort**: Very High (6-10 weeks)

### Option 4: FUSE Bridge Service

Deploy a separate FUSE bridge that translates between fsx and POSIX.

**Approach**:
1. Create FUSE daemon that speaks fsx RPC
2. Translate POSIX operations to fsx API calls
3. Cache metadata locally for performance

**Pros**:
- No changes to fsx storage format
- Clean separation of concerns

**Cons**:
- Requires running additional service
- Network latency for all operations
- Not compatible with JuiceFS specifically

**Effort**: Medium (2-3 weeks)

---

## Recommendation

**Recommended Approach**: **Option 4 (FUSE Bridge Service)** or **Option 1 (Read-Only Adapter)**

### Rationale

1. **Different Design Goals**: JuiceFS is optimized for traditional POSIX filesystem workloads (FUSE mounting, large file streaming). fsx is optimized for edge computing with database VFS support and tiered storage.

2. **Storage Efficiency**: JuiceFS's 4 MB blocks are optimized for large files. fsx's 4 KB pages are optimized for database operations. Forcing compatibility would compromise both.

3. **Complexity vs Value**: Full bidirectional compatibility (Options 2-3) requires significant effort for limited use cases. Most users need either:
   - POSIX mount capability (Options 1 or 4)
   - Edge database storage (fsx native)

### Implementation Priority

If POSIX mounting is required:

1. **Short-term**: Implement FUSE Bridge Service (Option 4)
   - Provides immediate POSIX access
   - No storage format changes
   - Can be deployed independently

2. **Medium-term**: Add JuiceFS Metadata Adapter (Option 1)
   - Enables JuiceFS client compatibility
   - Read-only access is sufficient for many use cases

3. **Long-term**: Evaluate demand for full compatibility
   - If significant demand exists, consider Option 3
   - Otherwise, maintain separate optimized paths

---

## Appendix: JuiceFS SQL Schema Reference

### jfs_node Structure (SQL engines)

```go
type node struct {
    Inode         uint64 `xorm:"pk"`
    Type          uint8
    Flags         uint8
    Mode          uint16
    Uid           uint32
    Gid           uint32
    Atime         int64
    Mtime         int64
    Ctime         int64
    Atimensec     uint32
    Mtimensec     uint32
    Ctimensec     uint32
    Nlink         uint32
    Length        uint64
    Rdev          uint32
    Parent        uint64
    AccessACLId   uint32
    DefaultACLId  uint32
}
```

### jfs_edge Structure

```go
type edge struct {
    Id     int64  `xorm:"pk bigserial"`
    Parent uint64 `xorm:"unique(edge)"`
    Name   []byte `xorm:"unique(edge) varbinary(255)"`
    Inode  uint64 `xorm:"index"`
    Type   uint8
}
```

### jfs_chunk Structure

```go
type chunk struct {
    Id     int64  `xorm:"pk bigserial"`
    Inode  uint64 `xorm:"unique(chunk)"`
    Indx   uint32 `xorm:"unique(chunk)"`
    Slices []byte `xorm:"blob"`
}
```

### jfs_chunk_ref Structure

```go
type chunkRef struct {
    Chunkid uint64 `xorm:"pk"`
    Size    uint32
    Refs    int64  `xorm:"index"`
}
```

---

## References

- [JuiceFS Architecture](https://juicefs.com/docs/community/architecture/)
- [JuiceFS Metadata Engines](https://juicefs.com/docs/community/databases_for_metadata/)
- [JuiceFS Source Code - pkg/meta/sql.go](https://github.com/juicedata/juicefs/blob/main/pkg/meta/sql.go)
- [JuiceFS Data Storage Design Blog](https://juicefs.com/en/blog/engineering/design-metadata-data-storage)
- fsx ExtentStorage: `/Users/nathanclevenger/projects/fsx/storage/extent-storage.ts`
- fsx SQLiteMetadata: `/Users/nathanclevenger/projects/fsx/storage/sqlite.ts`
