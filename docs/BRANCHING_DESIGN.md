# FSx BranchableBackend Interface Design

## Executive Summary

This document proposes a `BranchableBackend` interface that extends `FsBackend` to provide git-like branching semantics for the fsx filesystem. This enables copy-on-write snapshots, isolated workspaces, and version control primitives directly within the filesystem layer.

**Key Design Goals:**
- Extend `FsBackend` without breaking existing backends
- Leverage existing Content-Addressable Storage (CAS) for efficient branching
- Support copy-on-write semantics for space-efficient snapshots
- Enable isolation for parallel development workflows
- Maintain POSIX compatibility for all filesystem operations

## Background

### Current FsBackend Interface

The current `FsBackend` interface (defined in `/Users/nathanclevenger/projects/fsx/core/backend.ts`) provides:

```typescript
interface FsBackend {
  // File Operations
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array, options?: WriteOptions): Promise<BackendWriteResult>
  unlink(path: string): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  appendFile(path: string, data: Uint8Array): Promise<void>
  copyFile(src: string, dest: string): Promise<void>

  // Directory Operations
  mkdir(path: string, options?: MkdirOptions): Promise<void>
  rmdir(path: string, options?: RmdirOptions): Promise<void>
  readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]>

  // Metadata Operations
  stat(path: string): Promise<Stats>
  lstat(path: string): Promise<Stats>
  exists(path: string): Promise<boolean>
  access(path: string, mode?: number): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  chown(path: string, uid: number, gid: number): Promise<void>
  utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void>

  // Symbolic Links
  symlink(target: string, path: string): Promise<void>
  link(existingPath: string, newPath: string): Promise<void>
  readlink(path: string): Promise<string>

  // Path Operations
  realpath(path: string): Promise<string>
  mkdtemp(prefix: string): Promise<string>

  // File Handle Operations
  open(path: string, flags?: string, mode?: number): Promise<FileHandle>

  // Optional Tiering Operations
  getTier?(path: string): Promise<StorageTier>
  promote?(path: string, tier: 'hot' | 'warm'): Promise<void>
  demote?(path: string, tier: 'warm' | 'cold'): Promise<void>
}
```

### Existing CAS Layer

The fsx codebase already includes a robust Content-Addressable Storage layer (`/Users/nathanclevenger/projects/fsx/core/cas/`) that provides:

- SHA-1/SHA-256 content hashing
- Deduplication via content addressing
- Reference counting for garbage collection
- LRU caching for read performance
- Existence caching with bloom filters

This CAS layer is the natural foundation for implementing branching, as branches can share underlying blobs through content addressing.

## Proposed BranchableBackend Interface

### Interface Definition

```typescript
/**
 * BranchableBackend - Filesystem backend with git-like branching support
 *
 * Extends FsBackend with branch management capabilities, enabling:
 * - Copy-on-write snapshots
 * - Isolated workspaces
 * - Version history
 * - Merge operations
 *
 * All FsBackend operations are scoped to the current branch.
 */
export interface BranchableBackend extends FsBackend {
  // ===========================================================================
  // Branch State Management
  // ===========================================================================

  /**
   * Set the current working branch.
   *
   * All subsequent FsBackend operations will be scoped to this branch.
   * If the branch doesn't exist, throws ENOENT.
   *
   * @param branchId - Branch identifier (e.g., "main", "feature-x", UUID)
   * @throws {ENOENT} If branch doesn't exist
   *
   * @example
   * ```typescript
   * backend.setCurrentBranch('feature-branch')
   * await backend.writeFile('/config.json', data) // Writes to feature-branch
   * ```
   */
  setCurrentBranch(branchId: string): void

  /**
   * Get the current working branch.
   *
   * @returns Current branch identifier
   *
   * @example
   * ```typescript
   * const branch = backend.getCurrentBranch()
   * console.log(`Working on: ${branch}`) // "main"
   * ```
   */
  getCurrentBranch(): string

  // ===========================================================================
  // Branch CRUD Operations
  // ===========================================================================

  /**
   * List all branches.
   *
   * @returns Array of branch identifiers
   *
   * @example
   * ```typescript
   * const branches = await backend.listBranches()
   * // ['main', 'feature-auth', 'feature-ui']
   * ```
   */
  listBranches(): Promise<string[]>

  /**
   * Create a new branch from an existing branch (or current if not specified).
   *
   * Creates a copy-on-write snapshot of the source branch. The new branch
   * shares all underlying blobs with the source until modifications are made.
   *
   * @param name - Name for the new branch
   * @param from - Source branch to copy from (defaults to current branch)
   * @returns The created branch identifier
   * @throws {EEXIST} If branch with this name already exists
   * @throws {ENOENT} If source branch doesn't exist
   *
   * @example
   * ```typescript
   * // Create branch from current
   * const newBranch = await backend.createBranch('feature-x')
   *
   * // Create branch from specific source
   * const newBranch = await backend.createBranch('hotfix', 'main')
   * ```
   */
  createBranch(name: string, from?: string): Promise<string>

  /**
   * Delete a branch.
   *
   * The branch and its unique data are removed. Shared blobs (via CAS)
   * remain if referenced by other branches.
   *
   * Cannot delete the default branch ("main") or the current branch.
   *
   * @param name - Branch to delete
   * @throws {ENOENT} If branch doesn't exist
   * @throws {EPERM} If trying to delete protected branch or current branch
   *
   * @example
   * ```typescript
   * await backend.deleteBranch('feature-completed')
   * ```
   */
  deleteBranch(name: string): Promise<void>

  // ===========================================================================
  // Advanced Branch Operations (Optional)
  // ===========================================================================

  /**
   * Get metadata about a branch.
   *
   * @param name - Branch to query (defaults to current)
   * @returns Branch metadata including creation time, head commit, etc.
   */
  getBranchInfo?(name?: string): Promise<BranchInfo>

  /**
   * Rename a branch.
   *
   * @param oldName - Current branch name
   * @param newName - New branch name
   * @throws {ENOENT} If source branch doesn't exist
   * @throws {EEXIST} If destination branch already exists
   */
  renameBranch?(oldName: string, newName: string): Promise<void>

  /**
   * Compare two branches and return the differences.
   *
   * @param branch1 - First branch (defaults to current)
   * @param branch2 - Second branch to compare against
   * @returns List of changed files with change type
   */
  diffBranches?(branch1?: string, branch2?: string): Promise<BranchDiff[]>

  /**
   * Merge changes from one branch into another.
   *
   * @param source - Branch to merge from
   * @param target - Branch to merge into (defaults to current)
   * @param options - Merge strategy options
   * @returns Merge result with any conflicts
   */
  mergeBranch?(source: string, target?: string, options?: MergeOptions): Promise<MergeResult>
}

// ===========================================================================
// Supporting Types
// ===========================================================================

/**
 * Metadata about a branch
 */
export interface BranchInfo {
  /** Branch identifier */
  name: string

  /** Creation timestamp */
  createdAt: Date

  /** Last modification timestamp */
  modifiedAt: Date

  /** Branch this was created from (null for root/main) */
  parentBranch: string | null

  /** Number of commits/changes on this branch */
  commitCount: number

  /** Root tree hash (for CAS integration) */
  treeHash?: string

  /** Whether this is the default branch */
  isDefault: boolean

  /** Whether this branch is protected from deletion */
  isProtected: boolean
}

/**
 * Represents a difference between branches
 */
export interface BranchDiff {
  /** Path of the changed file */
  path: string

  /** Type of change */
  type: 'added' | 'modified' | 'deleted' | 'renamed'

  /** Old path (for renames) */
  oldPath?: string

  /** Size difference in bytes */
  sizeDelta?: number
}

/**
 * Options for merge operations
 */
export interface MergeOptions {
  /** Strategy for handling conflicts */
  strategy?: 'ours' | 'theirs' | 'manual'

  /** Commit message for the merge */
  message?: string

  /** Whether to fast-forward if possible */
  fastForward?: boolean

  /** Dry run (don't actually merge, just report what would happen) */
  dryRun?: boolean
}

/**
 * Result of a merge operation
 */
export interface MergeResult {
  /** Whether merge completed successfully */
  success: boolean

  /** Type of merge performed */
  mergeType: 'fast-forward' | 'merge-commit' | 'no-op'

  /** List of conflicting files (if any) */
  conflicts: string[]

  /** Files that were merged */
  merged: string[]

  /** Resulting tree hash */
  treeHash?: string
}
```

## Architecture

### Storage Model

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         BranchableBackend                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Branch State                                                           │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │  currentBranch: "feature-x"                                      │   │
│  │                                                                  │   │
│  │  branches: {                                                     │   │
│  │    "main":      { treeHash: "abc123...", meta: {...} }          │   │
│  │    "feature-x": { treeHash: "def456...", meta: {...} }          │   │
│  │    "hotfix":    { treeHash: "abc123...", meta: {...} }  // COW  │   │
│  │  }                                                               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    FsBackend Operations                          │   │
│  │  (scoped to currentBranch's tree)                                │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                          │
├──────────────────────────────┼──────────────────────────────────────────┤
│                              ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │               Content-Addressable Storage (CAS)                  │   │
│  │                                                                  │   │
│  │  objects/ab/cdef... -> blob (shared across branches)            │   │
│  │  objects/12/3456... -> tree (directory structure)               │   │
│  │                                                                  │   │
│  │  Reference counting ensures blobs are only deleted when          │   │
│  │  no branches reference them.                                     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                          │
├──────────────────────────────┼──────────────────────────────────────────┤
│                              ▼                                          │
│  ┌──────────────────┬────────────────────┬─────────────────────────┐   │
│  │   Hot Tier       │    Warm Tier       │     Cold Tier           │   │
│  │   (DO SQLite)    │    (R2)            │     (Archive)           │   │
│  └──────────────────┴────────────────────┴─────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Copy-on-Write Semantics

When creating a branch:

1. **Snapshot Tree**: Copy the tree hash reference, not the actual tree/blobs
2. **Increment RefCounts**: CAS refcounts for shared objects increase
3. **Lazy Copy**: Actual blob copies only happen on write (copy-on-write)

```
Initial State:
  main    ─────► tree: abc123 ─────► blob: xyz789 (config.json)
                                      refcount: 1

After createBranch('feature'):
  main    ─────► tree: abc123 ─────► blob: xyz789 (config.json)
  feature ─────► tree: abc123 ─────┘  refcount: 2  (shared!)

After writeFile on feature branch:
  main    ─────► tree: abc123 ─────► blob: xyz789 (config.json)
                                      refcount: 1
  feature ─────► tree: def456 ─────► blob: new111 (config.json, modified)
                                      refcount: 1
```

## Files to Modify

### Core Implementation

| File | Change | Priority |
|------|--------|----------|
| `/Users/nathanclevenger/projects/fsx/core/backend.ts` | Add `BranchableBackend` interface definition | P0 |
| `/Users/nathanclevenger/projects/fsx/core/types.ts` | Add `BranchInfo`, `BranchDiff`, `MergeOptions`, `MergeResult` types | P0 |
| `/Users/nathanclevenger/projects/fsx/core/errors.ts` | Add branch-specific error types | P1 |

### New Files to Create

| File | Purpose | Priority |
|------|---------|----------|
| `/Users/nathanclevenger/projects/fsx/core/branchable-backend.ts` | Interface definition and base implementation | P0 |
| `/Users/nathanclevenger/projects/fsx/storage/branchable-r2-backend.ts` | R2-based branchable backend | P1 |
| `/Users/nathanclevenger/projects/fsx/core/branch-tree.ts` | Tree manipulation for branches | P1 |
| `/Users/nathanclevenger/projects/fsx/core/branch-merge.ts` | Merge strategy implementations | P2 |

### Storage Layer

| File | Change | Priority |
|------|--------|----------|
| `/Users/nathanclevenger/projects/fsx/storage/sqlite.ts` | Add branch metadata tables | P1 |
| `/Users/nathanclevenger/projects/fsx/storage/interfaces.ts` | Add `BranchMetadataStorage` interface | P1 |
| `/Users/nathanclevenger/projects/fsx/storage/r2-backend.ts` | Extend to support branch scoping | P1 |

### CAS Integration

| File | Change | Priority |
|------|--------|----------|
| `/Users/nathanclevenger/projects/fsx/core/cas/content-addressable-fs.ts` | Add tree object support for branches | P1 |
| `/Users/nathanclevenger/projects/fsx/core/cas/refcount.ts` | Ensure proper refcount handling for branch operations | P1 |

### Tests

| File | Purpose | Priority |
|------|---------|----------|
| `/Users/nathanclevenger/projects/fsx/core/branchable-backend.test.ts` | Unit tests for interface | P0 |
| `/Users/nathanclevenger/projects/fsx/storage/branchable-r2-backend.test.ts` | Integration tests | P1 |
| `/Users/nathanclevenger/projects/fsx/tests/branch-isolation.test.ts` | Branch isolation tests | P1 |
| `/Users/nathanclevenger/projects/fsx/tests/branch-merge.test.ts` | Merge operation tests | P2 |

## Implementation Plan

### Phase 1: Core Interface (Week 1)

1. **Define Types** (2 days)
   - Add interface to `core/branchable-backend.ts`
   - Add supporting types to `core/types.ts`
   - Add error types to `core/errors.ts`
   - Write TDD tests for interface contract

2. **Memory Implementation** (3 days)
   - Extend `MemoryBackend` to implement `BranchableBackend`
   - Use in-memory Map for branch state
   - Validate interface design through testing

### Phase 2: Storage Integration (Week 2)

3. **SQLite Metadata** (2 days)
   - Add `branches` table to SQLite schema
   - Implement `BranchMetadataStorage` interface
   - Add branch info persistence

4. **R2 Backend Extension** (3 days)
   - Create `BranchableR2Backend` extending `R2Backend`
   - Integrate with CAS for tree objects
   - Implement copy-on-write logic

### Phase 3: Advanced Features (Week 3)

5. **Diff Operations** (2 days)
   - Implement `diffBranches`
   - Tree comparison algorithm
   - Change detection

6. **Merge Operations** (3 days)
   - Implement basic merge strategies
   - Conflict detection
   - Three-way merge foundation

### Phase 4: Testing & Documentation (Week 4)

7. **Integration Testing** (3 days)
   - End-to-end branch workflows
   - Performance benchmarks
   - Edge case coverage

8. **Documentation** (2 days)
   - Update CLAUDE.md
   - API documentation
   - Usage examples

## Usage Examples

### Basic Branching

```typescript
import { BranchableR2Backend, FSx } from 'fsx.do'

// Initialize backend
const backend = new BranchableR2Backend({
  sql: ctx.storage.sql,
  r2: env.MY_BUCKET,
})
const fs = new FSx(backend)

// Start on main branch (default)
console.log(backend.getCurrentBranch()) // 'main'

// Create a feature branch
await backend.createBranch('feature-auth')
backend.setCurrentBranch('feature-auth')

// Make changes (isolated to feature-auth)
await fs.writeFile('/src/auth.ts', authCode)
await fs.mkdir('/src/auth')
await fs.writeFile('/src/auth/login.ts', loginCode)

// Switch back to main (changes not visible)
backend.setCurrentBranch('main')
const exists = await fs.exists('/src/auth.ts') // false

// List all branches
const branches = await backend.listBranches()
// ['main', 'feature-auth']

// Clean up
backend.setCurrentBranch('main')
await backend.deleteBranch('feature-auth')
```

### Advanced Operations

```typescript
// Get branch info
const info = await backend.getBranchInfo('feature-auth')
console.log(info)
// {
//   name: 'feature-auth',
//   createdAt: Date,
//   modifiedAt: Date,
//   parentBranch: 'main',
//   commitCount: 5,
//   isDefault: false,
//   isProtected: false
// }

// Compare branches
const diff = await backend.diffBranches('main', 'feature-auth')
// [
//   { path: '/src/auth.ts', type: 'added' },
//   { path: '/src/auth/login.ts', type: 'added' },
//   { path: '/src/config.ts', type: 'modified' }
// ]

// Merge branches
const result = await backend.mergeBranch('feature-auth', 'main')
if (result.success) {
  console.log(`Merged ${result.merged.length} files`)
} else {
  console.log(`Conflicts in: ${result.conflicts.join(', ')}`)
}
```

## Design Decisions

### Why Extend FsBackend vs New Interface?

**Decision**: Extend `FsBackend`

**Rationale**:
- Maintains compatibility with existing FSx class
- Branch operations are orthogonal to filesystem operations
- Allows gradual adoption (non-branchable backends still work)
- Follows Open-Closed Principle

### Why Synchronous setCurrentBranch?

**Decision**: `setCurrentBranch()` is synchronous

**Rationale**:
- Branch switching is just updating internal state pointer
- No I/O required (tree is resolved lazily on first operation)
- Simpler API for common use cases
- Can be called multiple times in sequence without await chains

### Why Optional Advanced Operations?

**Decision**: `getBranchInfo?`, `diffBranches?`, `mergeBranch?` are optional

**Rationale**:
- Core branch CRUD is sufficient for many use cases
- Diff/merge add significant complexity
- Allows simpler implementations to satisfy interface
- Advanced features can be added incrementally

### Default Branch Handling

**Decision**: "main" is the default, protected branch

**Rationale**:
- Matches git convention
- Always exists (created on initialization)
- Cannot be deleted
- Provides stable baseline for branching

## Open Questions

1. **Branch Naming Convention**
   - Should we validate branch names (no spaces, special chars)?
   - Should we support hierarchical branches (e.g., `feature/auth/login`)?

2. **Garbage Collection**
   - When should orphaned branch data be cleaned up?
   - Should we provide explicit GC methods on the interface?

3. **Events/Hooks**
   - Should branch operations emit events (onBranchCreated, onBranchDeleted)?
   - Useful for caching, logging, and external integrations

4. **Concurrent Access**
   - How to handle multiple users on same branch?
   - Should we add locking mechanisms?

## Related Work

- Git branching model
- Dolt database branching (SQL with branches)
- Nix store (content-addressed with generations)
- ZFS snapshots (copy-on-write filesystem)

## References

- `/Users/nathanclevenger/projects/fsx/core/backend.ts` - Current FsBackend interface
- `/Users/nathanclevenger/projects/fsx/core/types.ts` - Core type definitions
- `/Users/nathanclevenger/projects/fsx/core/cas/content-addressable-fs.ts` - CAS implementation
- `/Users/nathanclevenger/projects/fsx/storage/r2-backend.ts` - R2 backend implementation
- `/Users/nathanclevenger/projects/fsx/docs/GITX_INTEGRATION.md` - Git integration architecture
