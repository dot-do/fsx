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
// =============================================================================
// FRAMEWORK LAYER - Core FSx Library
// =============================================================================
// These exports are runtime-agnostic and can be used in any JavaScript environment.
// They form the stable API surface of the filesystem library.
// =============================================================================
/**
 * @category Framework
 * @description Core types and classes from core/
 */
export { MemoryBackend, 
// Classes
Stats, Dirent, FileHandle, 
// FSx main API
FSx, 
// Constants
constants, } from './core/index.js';
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
export { match, createMatcher } from './core/glob/match.js';
export { glob, GlobTimeoutError, GlobAbortedError } from './core/glob/glob.js';
export { find } from './core/find/find.js';
export { grep } from './core/grep/grep.js';
/**
 * Framework Content-Addressable Storage (CAS) implementation.
 * @category Framework
 */
export { ContentAddressableFS, } from './core/cas/content-addressable-fs.js';
export { sha1, sha256, bytesToHex, hexToBytes } from './core/cas/hash.js';
export { hashToPath, pathToHash } from './core/cas/path-mapping.js';
/**
 * Framework sparse checkout pattern parsing.
 * @category Framework
 */
export { parsePattern } from './core/sparse/patterns.js';
/**
 * Framework configuration utilities.
 * @category Framework
 */
export { createConfig, isReadOnly, defaultConfig, } from './core/config.js';
// =============================================================================
// APPLICATION LAYER - Cloudflare Durable Object Integration
// =============================================================================
// These exports are Cloudflare-specific and provide higher-level integrations.
// They depend on Cloudflare Workers types and runtime features.
// =============================================================================
/**
 * Application Durable Object integration - FileSystemDO and mixins.
 * These components integrate FSx with Cloudflare Durable Objects.
 * @category Application
 */
export { FileSystemDO, FsModule, withFs, hasFs, getFs, 
// Container executor
CloudflareContainerExecutor, createContainerExecutor, createIsolatedExecutor, } from './do/index.js';
// =============================================================================
// FRAMEWORK LAYER - Storage Backends
// =============================================================================
// These storage implementations are part of the framework layer but may have
// Cloudflare-specific implementations (R2Backend) alongside generic ones.
// =============================================================================
/**
 * Framework storage backend implementations.
 * TieredFS and R2Storage provide tiered storage capabilities.
 * @category Framework
 */
export { TieredFS, R2Storage, SQLiteMetadata, R2Backend, } from './storage/index.js';
// =============================================================================
// APPLICATION LAYER - Service Definition (for dotdo integration)
// =============================================================================
// import { createService } from 'dotdo'
// import { FileSystemDO } from './do/index.js'
// import App from './App.js'
// import Site from './Site.js'
//
// export default createService({
//   name: 'fsx',
//   DO: FileSystemDO,
//   App,
//   Site,
//   docs: import.meta.glob('./docs/*.mdx'),
// })
/**
 * Default export for wrangler deployment.
 * @category Application
 */
export { FileSystemDO as default } from './do/index.js';
// =============================================================================
// APPLICATION LAYER - Convenience Exports
// =============================================================================
// These are application-level convenience functions for SDK usage.
import { FSx } from './core/fsx.js';
import { MemoryBackend } from './core/backend.js';
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
export function createFs(options = {}) {
    const { backend, ...fsxOptions } = options;
    // Use provided backend or create an in-memory one for development/testing
    const fsBackend = backend ?? new MemoryBackend();
    return new FSx(fsBackend, fsxOptions);
}
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
export const fs = createFs();
//# sourceMappingURL=index.js.map