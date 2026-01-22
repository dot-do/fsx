/**
 * fsx.do - Managed filesystem service
 *
 * A virtual filesystem backed by Cloudflare Durable Objects with tiered storage.
 * This is the managed service layer built on @dotdo/fsx.
 *
 * ## Framework vs Application Code
 *
 * This package exports both **framework code** (core FSx primitives) and
 * **application code** (Durable Object integration, security utilities).
 *
 * See `docs/FRAMEWORK.md` for detailed boundary documentation.
 *
 * ### Framework Exports (Runtime-agnostic)
 * - `FSx`, `FsBackend`, `MemoryBackend` - Core filesystem API
 * - `Stats`, `Dirent`, `FileHandle` - Core data types
 * - `ENOENT`, `EEXIST`, etc. - Error classes
 * - `glob`, `find`, `grep` - Unix-like utilities
 * - `ContentAddressableFS` - CAS storage
 * - `TieredFS`, `R2Storage` - Storage backends
 *
 * ### Application Exports (Cloudflare-specific)
 * - `FileSystemDO`, `FsModule` - Durable Object integration
 * - `withFs`, `hasFs`, `getFs` - DO mixins
 * - `PathValidator`, `pathValidator` - Security utilities
 * - `CloudflareContainerExecutor` - Container execution
 *
 * @example
 * ```typescript
 * import { fs } from 'fsx.do'
 *
 * await fs.writeFile('/hello.txt', 'Hello, World!')
 * const content = await fs.readFile('/hello.txt', 'utf-8')
 * ```
 *
 * @example CLI
 * ```bash
 * npx fsx.do ls /
 * npx fsx.do cat /hello.txt
 * ```
 *
 * @packageDocumentation
 */
/**
 * @category Framework
 * @description Core types and classes from core/
 */
export { type FsBackend, type BackendWriteResult, type BackendReadResult, type BackendOptions, MemoryBackend, Stats, Dirent, FileHandle, FSx, type FSxOptions, constants, type Constants, } from './core/index.js';
export type { FsCapability, StorageTier, FileStat, StatsInit, StatsLike, DirentType, FileType, FileEntry, FileMode, ReadOptions, WriteOptions, ListOptions, CopyOptions, MoveOptions, RemoveOptions, ReadStreamOptions, WriteStreamOptions, MkdirOptions, RmdirOptions, ReaddirOptions, WatchOptions, WriteResult, ReadResult, FSWatcher, BufferEncoding, BlobRef, } from './core/index.js';
/**
 * Framework error classes - POSIX-compatible filesystem errors.
 * @category Framework
 */
export { FSError, ENOENT, EEXIST, EISDIR, ENOTDIR, EACCES, EPERM, ENOTEMPTY, EBADF, EINVAL, ELOOP, ENAMETOOLONG, ENOSPC, EROFS, EBUSY, EMFILE, ENFILE, EXDEV, } from './core/errors.js';
/**
 * Framework path utilities and Unix-like file operations.
 * @category Framework
 */
export * from './core/path.js';
export { match, createMatcher, type MatchOptions } from './core/glob/match.js';
export { glob, GlobTimeoutError, GlobAbortedError, type GlobOptions } from './core/glob/glob.js';
export { find, type FindOptions, type FindResult } from './core/find/find.js';
export { grep, type GrepOptions, type GrepMatch, type GrepResult } from './core/grep/grep.js';
/**
 * Framework Content-Addressable Storage (CAS) implementation.
 * @category Framework
 */
export { ContentAddressableFS, type CASObject, type CASStorage, type ObjectType, } from './core/cas/content-addressable-fs.js';
export { sha1, sha256, bytesToHex, hexToBytes } from './core/cas/hash.js';
export { hashToPath, pathToHash } from './core/cas/path-mapping.js';
/**
 * Framework sparse checkout pattern parsing.
 * @category Framework
 */
export { parsePattern, type ParsedPattern } from './core/sparse/patterns.js';
/**
 * Framework configuration utilities.
 * @category Framework
 */
export { createConfig, isReadOnly, defaultConfig, type FSxConfig, type FSxConfigOptions, } from './core/config.js';
/**
 * Application Durable Object integration - FileSystemDO and mixins.
 * These components integrate FSx with Cloudflare Durable Objects.
 * @category Application
 */
export { FileSystemDO, FsModule, type FsModuleConfig, withFs, hasFs, getFs, type WithFsContext, type WithFsOptions, type WithFsDO, CloudflareContainerExecutor, createContainerExecutor, createIsolatedExecutor, type ContainerBinding, type ContainerInstance, type ContainerExecutorConfig, type ContainerExecResult, type ExecOptions, type StreamingExecEvent, type StreamingExecSession, type ContainerState, type HasContainerExecutor, type WithExecContext, } from './do/index.js';
/**
 * Framework storage backend implementations.
 * TieredFS and R2Storage provide tiered storage capabilities.
 * @category Framework
 */
export { TieredFS, R2Storage, SQLiteMetadata, R2Backend, type R2BackendConfig, } from './storage/index.js';
/**
 * Default export for wrangler deployment.
 * @category Application
 */
export { FileSystemDO as default } from './do/index.js';
import { FSx, type FSxOptions } from './core/fsx.js';
import { type FsBackend } from './core/backend.js';
/**
 * Configuration options for creating an FSx instance via the factory function.
 *
 * @category Application
 * @see {@link createFs} for usage examples
 */
export interface CreateFsOptions extends FSxOptions {
    /**
     * Use a pre-existing FsBackend implementation.
     * When provided, the factory uses this backend for storage operations.
     * When omitted, an in-memory backend is used (suitable for testing/development).
     */
    backend?: FsBackend;
}
/**
 * Create a new FSx filesystem instance with custom configuration.
 *
 * This factory function allows you to create filesystem instances with
 * different configurations or storage backends. Use this when you need:
 * - Multiple isolated filesystem instances
 * - Custom tier thresholds or file size limits
 * - Connection to a specific Durable Object binding
 *
 * @category Application
 * @param options - Configuration options for the filesystem instance
 * @returns A configured FSx instance
 *
 * @example Create an in-memory filesystem (for testing)
 * ```typescript
 * import { createFs } from 'fsx.do'
 *
 * const testFs = createFs()
 * await testFs.writeFile('/test.txt', 'test content')
 * ```
 *
 * @example Create with custom configuration
 * ```typescript
 * import { createFs } from 'fsx.do'
 *
 * const fs = createFs({
 *   maxFileSize: 50 * 1024 * 1024, // 50MB limit
 *   defaultMode: 0o600,            // Restrictive permissions
 * })
 * ```
 *
 * @example Create with custom backend (production)
 * ```typescript
 * import { createFs, MemoryBackend } from 'fsx.do'
 *
 * // Use a custom backend implementation
 * const customBackend = new MemoryBackend()
 * const fs = createFs({ backend: customBackend })
 * const content = await fs.readFile('/data.json', 'utf-8')
 * ```
 */
export declare function createFs(options?: CreateFsOptions): FSx;
/**
 * Default filesystem singleton for SDK usage.
 *
 * This provides a ready-to-use filesystem instance backed by in-memory storage.
 * The singleton is ideal for quick prototyping, testing, and simple scripts.
 *
 * **Important:** Data stored in this singleton is ephemeral and will be lost
 * when the process ends. For persistent storage in production, use {@link createFs}
 * with a Durable Object binding.
 *
 * @category Application
 * @example Basic file operations
 * ```typescript
 * import { fs } from 'fsx.do'
 *
 * // Write a file
 * await fs.writeFile('/hello.txt', 'Hello, World!')
 *
 * // Read a file
 * const content = await fs.readFile('/hello.txt', 'utf-8')
 * console.log(content) // 'Hello, World!'
 *
 * // Check if file exists
 * const exists = await fs.exists('/hello.txt')
 * console.log(exists) // true
 * ```
 *
 * @example Directory operations
 * ```typescript
 * import { fs } from 'fsx.do'
 *
 * // Create nested directories
 * await fs.mkdir('/app/data/logs', { recursive: true })
 *
 * // List directory contents
 * const files = await fs.readdir('/app/data')
 * console.log(files) // ['logs']
 *
 * // Get file stats
 * const stats = await fs.stat('/app/data')
 * console.log(stats.isDirectory()) // true
 * ```
 *
 * @example Import alongside types
 * ```typescript
 * import { fs, Stats, ENOENT } from 'fsx.do'
 *
 * try {
 *   const stats: Stats = await fs.stat('/missing.txt')
 * } catch (error) {
 *   if (error instanceof ENOENT) {
 *     console.log('File not found')
 *   }
 * }
 * ```
 */
export declare const fs: FSx;
//# sourceMappingURL=index.d.ts.map