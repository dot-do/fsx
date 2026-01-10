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
