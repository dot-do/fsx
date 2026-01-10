/**
 * fsx.do - Managed filesystem service
 *
 * A virtual filesystem backed by Cloudflare Durable Objects with tiered storage.
 * This is the managed service layer built on @dotdo/fsx.
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
// Re-export core @dotdo/fsx
// =============================================================================

export * from './core/index.js'

// =============================================================================
// Durable Object exports
// =============================================================================

export {
  FileSystemDO,
  FsModule,
  type FsModuleConfig,
  withFs,
  hasFs,
  getFs,
  type WithFsContext,
  type WithFsOptions,
  type WithFsDO,
  // Container executor
  CloudflareContainerExecutor,
  createContainerExecutor,
  createIsolatedExecutor,
  type ContainerBinding,
  type ContainerInstance,
  type ContainerExecutorConfig,
  type ContainerExecResult,
  type ExecOptions,
  type StreamingExecEvent,
  type StreamingExecSession,
  type ContainerState,
  type HasContainerExecutor,
  type WithExecContext,
} from './do/index.js'

// =============================================================================
// Storage backends
// =============================================================================

export {
  TieredFS,
  R2Storage,
  SQLiteMetadata,
} from './storage/index.js'

// =============================================================================
// Service Definition (for dotdo integration)
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

// For now, export the DO as default for wrangler
export { FileSystemDO as default } from './do/index.js'

// =============================================================================
// fs singleton and factory for SDK usage
// =============================================================================

import { FSx, type FSxOptions } from './core/fsx.js'
import { MemoryBackend } from './core/backend.js'
import { createMemoryStub } from './internal/memory-stub.js'

/**
 * Configuration options for creating an FSx instance via the factory function.
 *
 * @see {@link createFs} for usage examples
 */
export interface CreateFsOptions extends FSxOptions {
  /**
   * Use a pre-existing DurableObjectStub or DurableObjectNamespace binding.
   * When provided, the factory connects to a real Durable Object for persistent storage.
   * When omitted, an in-memory backend is used (suitable for testing/development).
   */
  binding?: DurableObjectNamespace | DurableObjectStub
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
 * @example Create with Durable Object binding (production)
 * ```typescript
 * import { createFs } from 'fsx.do'
 *
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     const fs = createFs({ binding: env.FILESYSTEM })
 *     const content = await fs.readFile('/data.json', 'utf-8')
 *     return new Response(content)
 *   }
 * }
 * ```
 */
export function createFs(options: CreateFsOptions = {}): FSx {
  const { binding, ...fsxOptions } = options

  if (binding) {
    // Use the provided DO binding for persistent storage
    return new FSx(binding, fsxOptions)
  }

  // Create an in-memory filesystem for development/testing
  const backend = new MemoryBackend()
  const stub = createMemoryStub(backend)
  return new FSx(stub, fsxOptions)
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
export const fs: FSx = createFs()
