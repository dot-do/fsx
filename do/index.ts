/**
 * fsx/do - Durable Object filesystem integration
 *
 * This module provides filesystem capabilities for Cloudflare Durable Objects:
 *
 * - FsModule: Standalone filesystem module with lazy initialization
 * - withFs: Mixin function to add $.fs capability to DO classes
 * - FileSystemDO: Complete Durable Object with HTTP API
 *
 * ## Architecture
 *
 * FileSystemDO is a thin HTTP/RPC wrapper around FsModule. All filesystem
 * logic is implemented in FsModule to avoid code duplication. This separation
 * provides:
 *
 * - FsModule: Core filesystem operations, transactions, tiered storage
 * - FileSystemDO: HTTP API layer using Hono, streaming endpoints
 *
 * @example
 * ```typescript
 * // Using FsModule directly
 * import { FsModule } from 'fsx/do'
 *
 * const fs = new FsModule({ sql: ctx.storage.sql })
 * await fs.initialize()
 * await fs.write('/config.json', JSON.stringify(config))
 * ```
 *
 * @example
 * ```typescript
 * // Using withFs mixin with dotdo
 * import { withFs } from 'fsx/do'
 * import { DO } from 'dotdo'
 *
 * class MySite extends withFs(DO) {
 *   async loadContent() {
 *     return this.$.fs.read('/content/index.mdx', { encoding: 'utf-8' })
 *   }
 * }
 * ```
 *
 * @module fsx/do
 */

import { DurableObject } from 'cloudflare:workers'
import { Hono } from 'hono'
import { FsModule } from './module.js'
import type { Stats, Dirent } from '../core/types.js'

// Re-export FsModule and related types for fsx/do entry point
export { FsModule, type FsModuleConfig } from './module.js'
export { withFs, hasFs, getFs, type WithFsContext, type WithFsOptions, type WithFsDO } from './mixin.js'

// Re-export security module for path validation
export {
  PathValidator,
  pathValidator,
  SecurityConstants,
  type ValidationResult,
  type ValidationSuccess,
  type ValidationFailure,
} from './security.js'

// Re-export CloudflareContainerExecutor and related types for fsx/do entry point
export {
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
} from './container-executor.js'

interface Env {
  FSX: DurableObjectNamespace
  R2?: R2Bucket
  ARCHIVE?: R2Bucket
}

/**
 * Stats-like object for HTTP API responses (plain object, not class instances)
 */
interface StatsResponse {
  dev: number
  ino: number
  mode: number
  nlink: number
  uid: number
  gid: number
  rdev: number
  size: number
  blksize: number
  blocks: number
  atime: number
  mtime: number
  ctime: number
  birthtime: number
}

/**
 * Dirent-like response for HTTP API (serializable)
 */
interface DirentResponse {
  name: string
  parentPath: string
  path: string
  type: 'file' | 'directory' | 'symlink'
}

/**
 * FileSystemDO - Durable Object for filesystem operations
 *
 * This class provides an HTTP/RPC API layer on top of FsModule.
 * All filesystem logic is delegated to FsModule to avoid code duplication.
 *
 * ## Endpoints
 *
 * - POST /rpc - JSON-RPC endpoint for filesystem operations
 * - POST /stream/read - Streaming file read with range support
 * - POST /stream/write - Streaming file write
 *
 * @example
 * ```typescript
 * // RPC call example
 * const response = await fetch(doStub, {
 *   method: 'POST',
 *   body: JSON.stringify({
 *     method: 'readFile',
 *     params: { path: '/config.json', encoding: 'utf-8' }
 *   })
 * })
 * const { data } = await response.json()
 * ```
 */
export class FileSystemDO extends DurableObject<Env> {
  private app: Hono
  private fsModule: FsModule

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)

    // Create FsModule with storage configuration
    this.fsModule = new FsModule({
      sql: ctx.storage.sql,
      r2: env.R2,
      archive: env.ARCHIVE,
    })

    this.app = this.createApp()
  }

  private createApp(): Hono {
    const app = new Hono()

    // RPC endpoint - delegates to FsModule
    app.post('/rpc', async (c) => {
      const { method, params } = await c.req.json<{ method: string; params: Record<string, unknown> }>()

      try {
        const result = await this.handleMethod(method, params)
        return c.json(result)
      } catch (error: unknown) {
        const fsError = error as { code?: string; message?: string; path?: string }
        return c.json(
          { code: fsError.code || 'UNKNOWN', message: fsError.message, path: fsError.path },
          fsError.code === 'ENOENT' ? 404 : 400
        )
      }
    })

    // Streaming read - optimized for large files
    app.post('/stream/read', async (c) => {
      const { path, start, end } = await c.req.json<{ path: string; start?: number; end?: number }>()

      try {
        const data = await this.fsModule.read(path, { start, end })

        if (typeof data === 'string') {
          return new Response(new TextEncoder().encode(data))
        }

        return new Response(data)
      } catch (error: unknown) {
        const fsError = error as { code?: string; message?: string; path?: string }
        return c.json(
          { code: fsError.code || 'UNKNOWN', message: fsError.message, path: fsError.path },
          fsError.code === 'ENOENT' ? 404 : 400
        )
      }
    })

    // Streaming write - optimized for large files
    app.post('/stream/write', async (c) => {
      const path = c.req.header('X-FSx-Path')
      const optionsHeader = c.req.header('X-FSx-Options')

      if (!path) {
        return c.json({ code: 'EINVAL', message: 'path required' }, 400)
      }

      try {
        const options = optionsHeader ? JSON.parse(optionsHeader) : {}
        const data = await c.req.arrayBuffer()
        await this.fsModule.write(path, new Uint8Array(data), options)
        return c.json({ success: true })
      } catch (error: unknown) {
        const fsError = error as { code?: string; message?: string; path?: string }
        return c.json(
          { code: fsError.code || 'UNKNOWN', message: fsError.message, path: fsError.path },
          fsError.code === 'ENOENT' ? 404 : 400
        )
      }
    })

    return app
  }

  /**
   * Handle RPC method calls by delegating to FsModule
   */
  private async handleMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'readFile':
        return this.handleReadFile(params.path as string, params.encoding as string | undefined)

      case 'writeFile':
        await this.fsModule.write(params.path as string, params.data as string | Uint8Array, params)
        return { success: true }

      case 'unlink':
        await this.fsModule.unlink(params.path as string)
        return { success: true }

      case 'rename':
        await this.fsModule.rename(params.oldPath as string, params.newPath as string, params)
        return { success: true }

      case 'copyFile':
        await this.fsModule.copyFile(params.src as string, params.dest as string, params)
        return { success: true }

      case 'mkdir':
        await this.fsModule.mkdir(params.path as string, params as { recursive?: boolean; mode?: number })
        return { success: true }

      case 'rmdir':
        await this.fsModule.rmdir(params.path as string, params as { recursive?: boolean })
        return { success: true }

      case 'rm':
        await this.fsModule.rm(params.path as string, params as { recursive?: boolean; force?: boolean })
        return { success: true }

      case 'readdir':
        return this.handleReaddir(params.path as string, params as { withFileTypes?: boolean; recursive?: boolean })

      case 'stat':
        return this.handleStat(params.path as string, false)

      case 'lstat':
        return this.handleStat(params.path as string, true)

      case 'access':
        await this.fsModule.access(params.path as string, params.mode as number)
        return { success: true }

      case 'chmod':
        await this.fsModule.chmod(params.path as string, params.mode as number)
        return { success: true }

      case 'chown':
        await this.fsModule.chown(params.path as string, params.uid as number, params.gid as number)
        return { success: true }

      case 'symlink':
        await this.fsModule.symlink(params.target as string, params.path as string)
        return { success: true }

      case 'link':
        await this.fsModule.link(params.existingPath as string, params.newPath as string)
        return { success: true }

      case 'readlink':
        return { target: await this.fsModule.readlink(params.path as string) }

      case 'realpath':
        return { path: await this.fsModule.realpath(params.path as string) }

      case 'truncate':
        await this.fsModule.truncate(params.path as string, params.length as number)
        return { success: true }

      case 'utimes':
        await this.fsModule.utimes(params.path as string, params.atime as number | Date, params.mtime as number | Date)
        return { success: true }

      case 'exists':
        return { exists: await this.fsModule.exists(params.path as string) }

      case 'getTier':
        return { tier: await this.fsModule.getTier(params.path as string) }

      case 'promote':
        await this.fsModule.promote(params.path as string, params.tier as 'hot' | 'warm')
        return { success: true }

      case 'demote':
        await this.fsModule.demote(params.path as string, params.tier as 'warm' | 'cold')
        return { success: true }

      default:
        throw new Error(`Unknown method: ${method}`)
    }
  }

  /**
   * Handle readFile with encoding support
   */
  private async handleReadFile(path: string, encoding?: string): Promise<{ data: string; encoding: string }> {
    const result = await this.fsModule.read(path, { encoding })

    if (typeof result === 'string') {
      return { data: result, encoding: encoding || 'utf-8' }
    }

    // Convert Uint8Array to base64 for JSON transport
    const bytes = result
    let binary = ''
    for (const byte of bytes) {
      binary += String.fromCharCode(byte)
    }
    return { data: btoa(binary), encoding: 'base64' }
  }

  /**
   * Handle readdir with serializable response
   */
  private async handleReaddir(
    path: string,
    options: { withFileTypes?: boolean; recursive?: boolean }
  ): Promise<string[] | DirentResponse[]> {
    const result = await this.fsModule.readdir(path, options)

    if (options.withFileTypes) {
      // Convert Dirent objects to plain objects for JSON serialization
      return (result as Dirent[]).map((entry) => ({
        name: entry.name,
        parentPath: entry.parentPath,
        path: entry.parentPath + '/' + entry.name,
        type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'symlink',
      }))
    }

    return result as string[]
  }

  /**
   * Handle stat/lstat with serializable response
   */
  private async handleStat(path: string, noFollow: boolean): Promise<StatsResponse> {
    const stats = noFollow ? await this.fsModule.lstat(path) : await this.fsModule.stat(path)

    // Convert Stats object to plain object for JSON serialization
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
      atime: stats.atimeMs ?? (stats.atime instanceof Date ? stats.atime.getTime() : stats.atime),
      mtime: stats.mtimeMs ?? (stats.mtime instanceof Date ? stats.mtime.getTime() : stats.mtime),
      ctime: stats.ctimeMs ?? (stats.ctime instanceof Date ? stats.ctime.getTime() : stats.ctime),
      birthtime: stats.birthtimeMs ?? (stats.birthtime instanceof Date ? stats.birthtime.getTime() : stats.birthtime),
    }
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request)
  }
}
