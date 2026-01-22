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
// =============================================================================
// Core FSx API
// =============================================================================
export { FSx } from './fsx.js';
// =============================================================================
// Backend Interface
// =============================================================================
export { MemoryBackend, } from './backend.js';
// =============================================================================
// Types & Classes
// =============================================================================
export { 
// Classes
Stats, Dirent, FileHandle, 
// Type Guards
isStats, isDirent, isFileHandle, isFileType, isStorageTier, isStatsLike, } from './types.js';
// =============================================================================
// Constants & Errors
// =============================================================================
export { constants } from './constants.js';
export { FSError, ENOENT, EEXIST, EISDIR, ENOTDIR, EACCES, EPERM, ENOTEMPTY, EBADF, EINVAL, ELOOP, ENAMETOOLONG, ENOSPC, EROFS, EBUSY, EMFILE, ENFILE, EXDEV, } from './errors.js';
// =============================================================================
// Configuration
// =============================================================================
export { createConfig, isReadOnly, defaultConfig, } from './config.js';
// =============================================================================
// Path Utilities
// =============================================================================
export * from './path.js';
// =============================================================================
// Unix-like Utilities
// =============================================================================
// Glob pattern matching
export { match, createMatcher } from './glob/match.js';
export { glob, GlobTimeoutError, GlobAbortedError } from './glob/glob.js';
// Find files
export { find } from './find/find.js';
// Grep search
export { grep } from './grep/grep.js';
// =============================================================================
// Content-Addressable Storage (CAS)
// =============================================================================
export { ContentAddressableFS, } from './cas/content-addressable-fs.js';
export { sha1, sha256, bytesToHex, hexToBytes } from './cas/hash.js';
export { hashToPath, pathToHash } from './cas/path-mapping.js';
// =============================================================================
// Copy-on-Write (COW) Handler for Branching
// =============================================================================
export { COWHandler, createCOWHandler, CASCOWHandler, InMemoryBranchMetadataStorage, } from './cow-handler.js';
// =============================================================================
// Sparse Checkout
// =============================================================================
export { parsePattern } from './sparse/patterns.js';
export { createIncludeChecker } from './sparse/include.js';
export { SparseFS } from './sparse/sparse-fs.js';
// =============================================================================
// MCP (Model Context Protocol) Tools
// =============================================================================
export { invokeFsSearch, fsSearchToolSchema, } from './mcp/fs-search.js';
//# sourceMappingURL=index.js.map