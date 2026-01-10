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
// fs singleton for SDK usage
// =============================================================================

import { FSx } from './core/fsx.js'
import { MemoryBackend } from './core/backend.js'

/**
 * Create a mock stub that wraps a MemoryBackend for the fs singleton.
 * This enables SDK-style usage without requiring a Durable Object binding.
 */
function createMockStub(backend: MemoryBackend): DurableObjectStub {
  const stub = {
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      if (init?.method !== 'POST' || !init.body) {
        return new Response('Not found', { status: 404 })
      }

      const body = JSON.parse(init.body as string)
      const { method, params } = body

      try {
        const result = await handleMethod(backend, method, params)
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      } catch (error: unknown) {
        const err = error as Error & { code?: string; path?: string }
        return new Response(
          JSON.stringify({
            code: err.code ?? 'UNKNOWN',
            message: err.message,
            path: err.path,
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      }
    },
  }

  return stub as unknown as DurableObjectStub
}

async function handleMethod(
  backend: MemoryBackend,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (method) {
    case 'readFile': {
      const path = params.path as string
      const data = await backend.readFile(path)
      let binary = ''
      for (const byte of data) {
        binary += String.fromCharCode(byte)
      }
      return { data: btoa(binary), encoding: 'base64' }
    }

    case 'writeFile': {
      const path = params.path as string
      const data = params.data as string
      const encoding = params.encoding as string
      const mode = params.mode as number | undefined

      let bytes: Uint8Array
      if (encoding === 'base64') {
        const binary = atob(data)
        bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i)
        }
      } else {
        bytes = new TextEncoder().encode(data)
      }

      await backend.writeFile(path, bytes, { mode })
      return {}
    }

    case 'unlink': {
      const path = params.path as string
      await backend.unlink(path)
      return {}
    }

    case 'rename': {
      const oldPath = params.oldPath as string
      const newPath = params.newPath as string
      await backend.rename(oldPath, newPath)
      return {}
    }

    case 'copyFile': {
      const src = params.src as string
      const dest = params.dest as string
      await backend.copyFile(src, dest)
      return {}
    }

    case 'mkdir': {
      const path = params.path as string
      const recursive = params.recursive as boolean
      const mode = params.mode as number | undefined
      await backend.mkdir(path, { recursive, mode })
      return {}
    }

    case 'rmdir': {
      const path = params.path as string
      const recursive = params.recursive as boolean
      await backend.rmdir(path, { recursive })
      return {}
    }

    case 'rm': {
      const path = params.path as string
      const recursive = params.recursive as boolean
      const force = params.force as boolean

      if (force) {
        try {
          const exists = await backend.exists(path)
          if (!exists) return {}
        } catch {
          return {}
        }
      }

      const stat = await backend.stat(path)
      if (stat.isDirectory()) {
        await backend.rmdir(path, { recursive })
      } else {
        await backend.unlink(path)
      }
      return {}
    }

    case 'readdir': {
      const path = params.path as string
      const withFileTypes = params.withFileTypes as boolean
      const entries = await backend.readdir(path, { withFileTypes })
      return entries
    }

    case 'stat':
    case 'lstat': {
      const path = params.path as string
      const stats = await backend.stat(path)
      return {
        dev: stats.dev,
        ino: stats.ino,
        mode: stats.mode,
        nlink: stats.nlink,
        uid: stats.uid,
        gid: stats.gid,
        rdev: stats.rdev,
        size: stats.size,
        blksize: stats.blksize,
        blocks: stats.blocks,
        atime: stats.atimeMs,
        mtime: stats.mtimeMs,
        ctime: stats.ctimeMs,
        birthtime: stats.birthtimeMs,
      }
    }

    case 'access': {
      const path = params.path as string
      const exists = await backend.exists(path)
      if (!exists) {
        throw { code: 'ENOENT', message: 'no such file or directory', path }
      }
      return {}
    }

    case 'chmod': {
      const path = params.path as string
      const mode = params.mode as number
      await backend.chmod(path, mode)
      return {}
    }

    case 'chown': {
      const path = params.path as string
      const uid = params.uid as number
      const gid = params.gid as number
      await backend.chown(path, uid, gid)
      return {}
    }

    case 'utimes': {
      const path = params.path as string
      const atime = params.atime as number
      const mtime = params.mtime as number
      await backend.utimes(path, atime, mtime)
      return {}
    }

    case 'symlink': {
      const target = params.target as string
      const path = params.path as string
      await backend.symlink(target, path)
      return {}
    }

    case 'link': {
      const existingPath = params.existingPath as string
      const newPath = params.newPath as string
      await backend.link(existingPath, newPath)
      return {}
    }

    case 'readlink': {
      const path = params.path as string
      const target = await backend.readlink(path)
      return target
    }

    case 'realpath': {
      const path = params.path as string
      // Simple implementation - just normalize and check existence
      const exists = await backend.exists(path)
      if (!exists) {
        throw { code: 'ENOENT', message: 'no such file or directory', path }
      }
      return path
    }

    case 'truncate': {
      // Not directly supported by MemoryBackend, but we can implement it
      const path = params.path as string
      const length = (params.length as number) ?? 0
      const data = await backend.readFile(path)
      const truncated = data.slice(0, length)
      await backend.writeFile(path, truncated)
      return {}
    }

    case 'open': {
      // Return a simple fd
      return 1
    }

    default:
      throw new Error(`Unknown method: ${method}`)
  }
}

// Create the singleton instance with a memory backend
const memoryBackend = new MemoryBackend()
const mockStub = createMockStub(memoryBackend)

/**
 * Default filesystem singleton for SDK usage.
 *
 * This provides a ready-to-use filesystem instance backed by an in-memory
 * storage. For production use with persistent storage, create an FSx instance
 * with a Durable Object binding instead.
 *
 * @example
 * ```typescript
 * import { fs } from 'fsx.do'
 *
 * await fs.writeFile('/hello.txt', 'Hello, World!')
 * const content = await fs.readFile('/hello.txt', 'utf-8')
 * ```
 */
export const fs = new FSx(mockStub)
