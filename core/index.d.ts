/**
 * @dotdo/fsx - Pure filesystem logic
 *
 * A POSIX-like filesystem API with zero Cloudflare dependencies.
 * Use this package for the core filesystem types and utilities.
 *
 * For the managed service with DO storage, use `fsx.do` instead.
 *
 * @example
 * ```typescript
 * import { FSx, FsBackend, MemoryBackend } from '@dotdo/fsx'
 *
 * // Use with in-memory backend for testing
 * const backend = new MemoryBackend()
 * const fs = new FSx(backend)
 *
 * await fs.write('/hello.txt', 'Hello, World!')
 * const content = await fs.read('/hello.txt', { encoding: 'utf-8' })
 * ```
 *
 * @packageDocumentation
 */
export { FSx, type FSxOptions } from './fsx.js';
export { type FsBackend, type BackendWriteResult, type BackendReadResult, type BackendOptions, MemoryBackend, } from './backend.js';
export { Stats, Dirent, FileHandle, isStats, isDirent, isFileHandle, isFileType, isStorageTier, isStatsLike, } from './types.js';
export type { FsCapability, StorageTier, FileStat, StatsInit, StatsLike, DirentType, FileType, FileEntry, FileMode, ReadOptions, WriteOptions, ListOptions, CopyOptions, MoveOptions, RemoveOptions, ReadStreamOptions, WriteStreamOptions, MkdirOptions, RmdirOptions, ReaddirOptions, WatchOptions, WriteResult, ReadResult, FSWatcher, BufferEncoding, BlobRef, } from './types.js';
export { constants, type Constants } from './constants.js';
export { FSError, ENOENT, EEXIST, EISDIR, ENOTDIR, EACCES, EPERM, ENOTEMPTY, EBADF, EINVAL, ELOOP, ENAMETOOLONG, ENOSPC, EROFS, EBUSY, EMFILE, ENFILE, EXDEV, } from './errors.js';
export { createConfig, isReadOnly, defaultConfig, type FSxConfig, type FSxConfigOptions, } from './config.js';
export * from './path.js';
export { match, createMatcher, type MatchOptions } from './glob/match.js';
export { glob, GlobTimeoutError, GlobAbortedError, type GlobOptions } from './glob/glob.js';
export { find, type FindOptions, type FindResult } from './find/find.js';
export { grep, type GrepOptions, type GrepMatch, type GrepResult } from './grep/grep.js';
export { ContentAddressableFS, type CASObject, type CASStorage, type ObjectType, } from './cas/content-addressable-fs.js';
export { sha1, sha256, bytesToHex, hexToBytes } from './cas/hash.js';
export { hashToPath, pathToHash } from './cas/path-mapping.js';
export { COWHandler, createCOWHandler, CASCOWHandler, InMemoryBranchMetadataStorage, type BlockInfo, type BranchState, type WriteInterceptResult, type COWHandlerOptions, type CommitResult, type DirtyPathInfo, type BranchMetadataStorage, type CASCOWHandlerOptions, } from './cow-handler.js';
export { parsePattern, type ParsedPattern } from './sparse/patterns.js';
export { createIncludeChecker, type IncludeChecker, type IncludeCheckerOptions } from './sparse/include.js';
export { SparseFS, type SparseFSOptions, type WalkEntry, type WalkOptions } from './sparse/sparse-fs.js';
export { invokeFsSearch, fsSearchToolSchema, type McpToolResult, type FsSearchOptions, type SearchResultItem, type StorageBackend, } from './mcp/fs-search.js';
//# sourceMappingURL=index.d.ts.map