# Unified VFS Strategy for fsx

## Problem Statement

Multiple database projects are each implementing their own 2MB blob storage:
- sqlite.do (PageStore)
- postgres.do (DOVFS)
- graphdb
- sdb
- db4
- clickhouse.do
- duckdb.do
- (future databases)

**Goal**: Create a hardened, production-grade VFS foundation in fsx that all databases can consume.

## Industry Standards Research

### JuiceFS Architecture (Gold Standard)

[JuiceFS](https://github.com/juicedata/juicefs) is the leading POSIX filesystem on object storage:

```
┌─────────────────────────────────────────────────────────┐
│                    POSIX API                            │
├─────────────────────────────────────────────────────────┤
│              JuiceFS Client (FUSE)                      │
├──────────────────────┬──────────────────────────────────┤
│   Metadata Engine    │         Data Storage            │
│   (Redis/SQL/TiKV)   │      (S3/R2/MinIO)              │
│                      │                                  │
│   - Inodes           │   Chunk (64MB logical)          │
│   - Directory tree   │     └─ Block (4MB physical)     │
│   - Chunk→Block map  │         (stored in S3)          │
└──────────────────────┴──────────────────────────────────┘
```

**Key Design Principles**:
1. **Separate metadata from data** - Metadata in fast DB, data in cheap object store
2. **Fixed-size blocks** - 4MB default (like our 2MB extents)
3. **Content-addressable** - Blocks stored by hash for deduplication
4. **Immutable writes** - New blocks created, old ones garbage collected
5. **Slice-based writes** - Allows efficient random writes without rewriting blocks

### Other S3 VFS Solutions

| Solution | Status | Approach |
|----------|--------|----------|
| [s3fs-fuse](https://github.com/s3fs-fuse/s3fs-fuse) | Active | Direct S3 mapping (slow) |
| [goofys](https://github.com/kahing/goofys) | Abandoned (4+ years) | High-perf POSIX-ish |
| [Mountpoint for S3](https://github.com/awslabs/mountpoint-s3) | AWS Official | Read-heavy, immutable files |
| JuiceFS | Active, Production | Full POSIX, separate metadata |

**Conclusion**: JuiceFS architecture is the model to follow.

## Cloudflare Storage Backends

### Current: R2 + DO SQLite

| Backend | Limit | Cost | Use Case |
|---------|-------|------|----------|
| DO SQLite | 10GB/DO | Per-row ops | Hot data, metadata |
| R2 | Unlimited | Per-op + storage | Cold data, large blobs |
| Cache API | Ephemeral | FREE | Read cache |

### New Opportunity: KV via DO

[Cloudflare KV](https://developers.cloudflare.com/kv/platform/limits/) has interesting properties:

| Property | Value |
|----------|-------|
| Max value size | **25MB** |
| Write limit | 1 write/sec per key |
| Read limit | Unlimited |
| Global replication | Automatic |
| Cost | Very cheap |

**Key Insight**: KV's 1 write/sec per key limit is per-key, not global. With sharding:
- 100 extent keys = 100 writes/sec
- 1000 extent keys = 1000 writes/sec
- Extents are immutable (write once, read many) = perfect fit!

### Proposed Multi-Backend Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Database VFS Layer                           │
│         (SQLite, PGlite, DuckDB, ClickHouse, etc.)             │
├─────────────────────────────────────────────────────────────────┤
│                    fsx VFS Core                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ ExtentStore │  │ MetadataDB  │  │ BranchMgr   │             │
│  │ (2MB blobs) │  │ (SQL)       │  │ (COW)       │             │
│  └──────┬──────┘  └──────┬──────┘  └─────────────┘             │
├─────────┴────────────────┴──────────────────────────────────────┤
│                    Storage Backend Abstraction                  │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐            │
│  │   R2    │  │ DO SQL  │  │   KV    │  │  Cache  │            │
│  │ (cold)  │  │ (hot)   │  │ (warm)  │  │ (edge)  │            │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

## Unified ExtentStorage Design

### Extent Format (Current - Keep)

```
┌──────────────────────────────────────────────────────────────┐
│ Header (64 bytes)                                            │
│ - Magic: "EXT1"                                              │
│ - Page size: 4KB (SQLite) or 8KB (Postgres)                  │
│ - Checksum: FNV-1a 64-bit                                    │
├──────────────────────────────────────────────────────────────┤
│ Page Bitmap (sparse extent support)                          │
├──────────────────────────────────────────────────────────────┤
│ Page Data (up to 2MB)                                        │
└──────────────────────────────────────────────────────────────┘
```

### Storage Backend Interface

```typescript
/**
 * Unified storage backend interface for extent storage.
 * Implementations: R2, KV, DO SQLite, Cache, Memory
 */
interface ExtentBackend {
  // Core operations
  get(extentId: string): Promise<Uint8Array | null>;
  put(extentId: string, data: Uint8Array): Promise<void>;
  delete(extentId: string): Promise<boolean>;
  exists(extentId: string): Promise<boolean>;

  // Optional: range reads (R2 supports, KV doesn't)
  getRange?(extentId: string, offset: number, length: number): Promise<Uint8Array | null>;

  // Backend capabilities
  readonly capabilities: {
    maxSize: number;        // 25MB for KV, 5GB for R2
    supportsRange: boolean; // true for R2, false for KV
    writeRateLimit?: number; // 1/sec for KV per key
  };
}
```

### Tiered Storage Strategy

```typescript
interface TieredExtentStorage {
  // Read path: Cache → KV → DO → R2
  read(extentId: string): Promise<Uint8Array | null>;

  // Write path: DO (hot) → KV (replicate) → R2 (archive)
  write(extentId: string, data: Uint8Array): Promise<void>;

  // Tier management
  promote(extentId: string, targetTier: Tier): Promise<void>;
  demote(extentId: string, targetTier: Tier): Promise<void>;
}

type Tier = 'cache' | 'kv' | 'do' | 'r2';
```

## Sync/Mirror Capability

### Local Machine Sync

Enable syncing fsx volumes to local machines (like Dropbox/Google Drive):

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Cloudflare     │     │   Sync Agent    │     │  Local Machine  │
│  (fsx VFS)      │────▶│   (WebSocket)   │────▶│  (FUSE mount)   │
│                 │◀────│                 │◀────│                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

**Implementation Options**:

1. **FUSE Client** (Linux/macOS)
   - Mount fsx as local filesystem
   - Use WebSocket for real-time sync
   - Cache extents locally

2. **WinFsp Client** (Windows)
   - Windows equivalent of FUSE
   - Same protocol as FUSE client

3. **Sync Protocol**
   - Delta sync (only changed extents)
   - Conflict resolution (last-write-wins or merge)
   - Offline support with local cache

### JuiceFS Compatibility

Consider implementing JuiceFS-compatible metadata format:
- Could use existing JuiceFS clients for local mount
- Leverage their battle-tested FUSE implementation
- Store data in R2/KV, metadata in DO SQLite

## Migration Path

### Phase 1: Consolidate fsx ExtentStorage
1. Harden current ExtentStorage implementation
2. Add KV backend support
3. Add tiered storage coordinator
4. Comprehensive test suite (target: 500+ tests)

### Phase 2: Migrate Existing Databases
1. sqlite.do → fsx ExtentStorage
2. postgres.do → fsx ExtentStorage
3. db4 → fsx ExtentStorage
4. sdb → fsx ExtentStorage (if applicable)

### Phase 3: New Database Support
1. clickhouse.do on fsx
2. duckdb.do on fsx
3. graphdb on fsx

### Phase 4: Local Sync
1. Design sync protocol
2. Implement FUSE client
3. Implement Windows client
4. Real-time collaboration features

## Cost Analysis

### Current (Per-Database Implementation)
- Each database maintains own 2MB chunking
- Duplicated code, testing, maintenance
- No cross-database deduplication

### After (Unified fsx VFS)
- Single implementation, battle-tested
- Cross-database extent deduplication (content-addressable)
- KV as cheap warm tier (vs expensive DO)
- Automatic tier optimization

### KV Cost Savings Example

```
100GB database with 50,000 extents (2MB each)

R2 Storage:
- Storage: $0.015/GB/month × 100GB = $1.50/month
- Operations: Varies by access pattern

KV Storage (if extents fit):
- Storage: $0.50/GB/month × 100GB = $50/month (more expensive)
- BUT: Global replication included
- AND: Faster reads at edge

Optimal: Hot extents in KV, cold in R2
```

## Open Questions

1. **KV 25MB limit**: Our extents are 2MB, well under limit. Could we use larger extents (16MB) for KV?

2. **JuiceFS compatibility**: Worth implementing their metadata format for client reuse?

3. **Sync protocol**: Build custom or adopt existing (rsync, Syncthing)?

4. **Deduplication scope**: Per-database or global across all databases?

## References

- [JuiceFS Architecture](https://juicefs.com/docs/community/architecture/)
- [JuiceFS Internals](https://juicefs.com/docs/community/internals/)
- [Cloudflare KV Limits](https://developers.cloudflare.com/kv/platform/limits/)
- [Cloudflare R2 Docs](https://developers.cloudflare.com/r2/)
- [s3fs-fuse](https://github.com/s3fs-fuse/s3fs-fuse)
- [goofys](https://github.com/kahing/goofys)
