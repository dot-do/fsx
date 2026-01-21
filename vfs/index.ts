/**
 * Virtual Filesystem Adapters
 *
 * This module provides VFS adapters for database systems built on top of
 * ExtentStorage. These adapters enable efficient storage of database files
 * on Cloudflare Durable Objects with ~500x cost reduction compared to
 * per-page storage.
 *
 * Supported Databases:
 * - PGlite (PostgreSQL) via ExtentPGliteFS
 * - SQLite via ExtentSQLiteVFS (planned)
 *
 * Branching Support:
 * - GitBranchManager provides Copy-on-Write branching for VFS
 * - O(1) branch creation (metadata only, no data copy)
 * - COW read resolution (walk up branch hierarchy)
 * - Commit/snapshot support for versioning
 *
 * @module vfs
 */

// PGlite filesystem adapter
export {
  ExtentPGliteFS,
  createExtentPGliteFS,
  type ExtentPGliteFSConfig,
  type FsStats,
  FsError,
  ERRNO,
  type ErrnoCode,
  PGLITE_PAGE_SIZE,
  S_IFREG,
  S_IFDIR,
  DEFAULT_FILE_MODE,
  DEFAULT_DIR_MODE,
} from './pglite-fs.js'

// Branch manager (COW branching)
export {
  GitBranchManager,
  createBranchManager,
  type BranchManager,
  type BranchManagerConfig,
  type Branch,
  type BranchId,
  type Commit,
  type CommitId,
  type ExtentSnapshot,
  type FileSnapshot,
  createBranchId,
  createCommitId,
  BranchError,
  type BranchErrorCode,
} from './branch-manager.js'
