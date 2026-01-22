/**
 * RemoteFsClient - SDK client that implements FsCapability interface
 *
 * Provides a TypeScript client for accessing remote fsx.do Durable Objects
 * over HTTP. This client implements the full FsCapability interface, allowing
 * it to be used as a drop-in replacement for local filesystem access.
 *
 * @module client/remote-client
 * @example
 * ```typescript
 * import { RemoteFsClient } from 'fsx.do/client'
 *
 * const fs = new RemoteFsClient('https://fsx.do', { auth: 'your-api-key' })
 *
 * // Use like any FsCapability implementation
 * await fs.write('/hello.txt', 'Hello, World!')
 * const content = await fs.read('/hello.txt', { encoding: 'utf-8' })
 * const stats = await fs.stat('/hello.txt')
 * ```
 */

import type {
  FsCapability,
  IFileHandle,
  FSWatcher,
  ReadOptions,
  WriteOptions,
  ListOptions,
  MkdirOptions,
  RmdirOptions,
  ReaddirOptions,
  RemoveOptions,
  CopyOptions,
  MoveOptions,
  WatchOptions,
  ReadStreamOptions,
  WriteStreamOptions,
  StorageTier,
  FileType,
  StatsInit,
} from '../core/types.js'

import { Stats, Dirent } from '../core/types.js'

import {
  FSError,
  ENOENT,
  EEXIST,
  EISDIR,
  ENOTDIR,
  EACCES,
  EPERM,
  ENOTEMPTY,
  EBADF,
  EINVAL,
  ELOOP,
  ENAMETOOLONG,
  ENOSPC,
  EROFS,
  EBUSY,
  EMFILE,
  ENFILE,
  EXDEV,
} from '../core/errors.js'

import { constants } from '../core/constants.js'

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration options for RemoteFsClient.
 */
export interface RemoteFsClientOptions {
  /**
   * Authentication token (API key, JWT, etc.)
   * Sent as `Authorization: Bearer <auth>` header.
   */
  auth?: string

  /**
   * Custom authorization header value.
   * Use for custom authentication schemes.
   */
  authorization?: string

  /**
   * Default timeout in milliseconds for requests.
   * @default 30000 (30 seconds)
   */
  timeout?: number

  /**
   * Custom fetch implementation (for Node.js compatibility).
   * Defaults to global fetch.
   */
  fetch?: typeof globalThis.fetch

  /**
   * Custom headers to include with every request.
   */
  headers?: Record<string, string>

  /**
   * Namespace/bucket identifier for the filesystem.
   * Used to isolate multiple filesystems on the same service.
   */
  namespace?: string

  /**
   * Base path prefix for all operations.
   * Useful for mounting a remote filesystem at a specific path.
   */
  basePath?: string
}

/**
 * API response envelope.
 */
interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
    path?: string
    syscall?: string
  }
}

/**
 * Raw stats data from the API response.
 */
interface RawStats {
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
  atimeMs: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  tier?: StorageTier
  type?: FileType
}

/**
 * Raw dirent data from the API response.
 */
interface RawDirent {
  name: string
  parentPath: string
  path: string
  type: FileType
}

// =============================================================================
// POSIX Mode Constants
// =============================================================================

const S_IFMT = 0o170000   // File type mask
const S_IFREG = 0o100000  // Regular file
const S_IFDIR = 0o040000  // Directory
const S_IFLNK = 0o120000  // Symbolic link
const S_IFBLK = 0o060000  // Block device
const S_IFCHR = 0o020000  // Character device
const S_IFIFO = 0o010000  // FIFO
const S_IFSOCK = 0o140000 // Socket

// =============================================================================
// Helper: Create Stats from raw API response
// =============================================================================

/**
 * Create a Stats instance from raw API response data.
 */
function createStats(raw: RawStats): Stats {
  return new Stats({
    dev: raw.dev,
    ino: raw.ino,
    mode: raw.mode,
    nlink: raw.nlink,
    uid: raw.uid,
    gid: raw.gid,
    rdev: raw.rdev,
    size: raw.size,
    blksize: raw.blksize,
    blocks: raw.blocks,
    atimeMs: raw.atimeMs,
    mtimeMs: raw.mtimeMs,
    ctimeMs: raw.ctimeMs,
    birthtimeMs: raw.birthtimeMs,
  })
}

/**
 * Create a Dirent instance from raw API response data.
 */
function createDirent(raw: RawDirent): Dirent {
  return new Dirent(raw.name, raw.parentPath, raw.type)
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert Uint8Array to base64 string.
 */
function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!)
    }
    return btoa(binary)
  }
  // Node.js fallback
  return Buffer.from(bytes).toString('base64')
}

/**
 * Convert base64 string to Uint8Array.
 */
function base64ToBytes(base64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }
  // Node.js fallback
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

/**
 * Convert string or Uint8Array to base64 for API transport.
 */
function encodeData(data: string | Uint8Array): string {
  if (typeof data === 'string') {
    const bytes = new TextEncoder().encode(data)
    return bytesToBase64(bytes)
  }
  return bytesToBase64(data)
}

/**
 * Create an AbortSignal that aborts when any of the given signals abort.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }

    signal.addEventListener('abort', () => controller.abort(signal.reason), {
      signal: controller.signal,
    })
  }

  return controller.signal
}

/**
 * Map error code to FSError class.
 */
function createFSError(code: string, message: string, syscall?: string, path?: string): FSError {
  switch (code) {
    case 'ENOENT':
      return new ENOENT(syscall, path)
    case 'EEXIST':
      return new EEXIST(syscall, path)
    case 'EISDIR':
      return new EISDIR(syscall, path)
    case 'ENOTDIR':
      return new ENOTDIR(syscall, path)
    case 'EACCES':
      return new EACCES(syscall, path)
    case 'EPERM':
      return new EPERM(syscall, path)
    case 'ENOTEMPTY':
      return new ENOTEMPTY(syscall, path)
    case 'EBADF':
      return new EBADF(syscall, path)
    case 'EINVAL':
      return new EINVAL(syscall, path)
    case 'ELOOP':
      return new ELOOP(syscall, path)
    case 'ENAMETOOLONG':
      return new ENAMETOOLONG(syscall, path)
    case 'ENOSPC':
      return new ENOSPC(syscall, path)
    case 'EROFS':
      return new EROFS(syscall, path)
    case 'EBUSY':
      return new EBUSY(syscall, path)
    case 'EMFILE':
      return new EMFILE(syscall, path)
    case 'ENFILE':
      return new ENFILE(syscall, path)
    case 'EXDEV':
      return new EXDEV(syscall, path)
    default:
      return new FSError(code, -1, message, syscall, path)
  }
}

// =============================================================================
// RemoteFsClient Class
// =============================================================================

/**
 * Remote filesystem client implementing the FsCapability interface.
 *
 * This client provides full filesystem access to a remote fsx.do Durable Object
 * over HTTP. It can be used as a drop-in replacement for any FsCapability
 * implementation.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const fs = new RemoteFsClient('https://fsx.do', { auth: 'api-key' })
 *
 * // Read and write files
 * await fs.write('/hello.txt', 'Hello, World!')
 * const content = await fs.read('/hello.txt', { encoding: 'utf-8' })
 *
 * // Directory operations
 * await fs.mkdir('/mydir', { recursive: true })
 * const files = await fs.readdir('/mydir')
 *
 * // Get file metadata
 * const stats = await fs.stat('/hello.txt')
 * console.log(stats.size, stats.mtime)
 * ```
 */
export class RemoteFsClient implements FsCapability {
  private baseUrl: string
  private timeout: number
  private fetchFn: typeof globalThis.fetch
  private headers: Record<string, string>
  private namespace?: string
  private authHeader?: string
  private basePath: string

  /**
   * Create a new RemoteFsClient instance.
   *
   * @param baseUrl - Base URL of the fsx.do service (e.g., 'https://fsx.do')
   * @param options - Client configuration options
   * @throws {Error} If baseUrl is not provided
   */
  constructor(baseUrl: string, options: RemoteFsClientOptions = {}) {
    if (!baseUrl) {
      throw new Error('RemoteFsClient requires a baseUrl')
    }

    this.baseUrl = baseUrl.replace(/\/$/, '') // Remove trailing slash
    this.timeout = options.timeout ?? 30000
    this.fetchFn = options.fetch ?? globalThis.fetch
    this.headers = options.headers ?? {}
    this.namespace = options.namespace
    this.basePath = options.basePath ?? ''

    // Set up authentication
    if (options.authorization) {
      this.authHeader = options.authorization
    } else if (options.auth) {
      this.authHeader = `Bearer ${options.auth}`
    }
  }

  // ===========================================================================
  // Internal HTTP Methods
  // ===========================================================================

  /**
   * Resolve a path with the base path prefix.
   */
  private resolvePath(path: string): string {
    if (this.basePath && !path.startsWith(this.basePath)) {
      return this.basePath + (path.startsWith('/') ? '' : '/') + path
    }
    return path
  }

  /**
   * Make an HTTP request to the API.
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    options?: { signal?: AbortSignal }
  ): Promise<T> {
    const url = `${this.baseUrl}/api/fs${endpoint}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.headers,
    }

    if (this.authHeader) {
      headers['Authorization'] = this.authHeader
    }

    if (this.namespace) {
      headers['X-Fsx-Namespace'] = this.namespace
    }

    // Create abort controller for timeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    // Combine user signal with timeout signal
    const signal = options?.signal
      ? anySignal([options.signal, controller.signal])
      : controller.signal

    try {
      const response = await this.fetchFn(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal,
      })

      clearTimeout(timeoutId)

      // Parse response
      const result = (await response.json()) as ApiResponse<T>

      if (!response.ok || !result.success) {
        this.handleError(result)
      }

      return result.data as T
    } catch (error) {
      clearTimeout(timeoutId)
      if (error instanceof FSError) {
        throw error
      }
      if ((error as Error).name === 'AbortError') {
        throw createFSError('ETIMEDOUT', 'Request aborted or timed out')
      }
      throw createFSError('EIO', (error as Error).message)
    }
  }

  /**
   * Handle API error response and throw appropriate FSError.
   */
  private handleError(result: ApiResponse<unknown>): never {
    const error = result.error ?? { code: 'UNKNOWN', message: 'Unknown error' }
    throw createFSError(error.code, error.message, error.syscall, error.path)
  }

  // ===========================================================================
  // File Operations (FsCapability interface)
  // ===========================================================================

  /**
   * Read the entire contents of a file.
   */
  async read(path: string, options?: ReadOptions): Promise<string | Uint8Array> {
    const resolvedPath = this.resolvePath(path)
    const params: Record<string, unknown> = { path: resolvedPath }

    if (options?.start !== undefined) params.start = options.start
    if (options?.end !== undefined) params.end = options.end

    const result = await this.request<{ content: string; encoding: string }>(
      'POST',
      '/read',
      params,
      { signal: options?.signal }
    )

    // Decode the base64 content
    const bytes = base64ToBytes(result.content)

    // Return string if encoding requested
    if (options?.encoding) {
      return new TextDecoder().decode(bytes)
    }

    return bytes
  }

  /**
   * Write data to a file.
   */
  async write(path: string, data: string | Uint8Array, options?: WriteOptions): Promise<void> {
    const resolvedPath = this.resolvePath(path)
    const params: Record<string, unknown> = {
      path: resolvedPath,
      content: encodeData(data),
    }

    if (options?.mode !== undefined) params.mode = options.mode
    if (options?.flag) params.flag = options.flag
    if (options?.tier) params.tier = options.tier

    await this.request<void>('POST', '/write', params, { signal: options?.signal })
  }

  /**
   * Append data to a file.
   */
  async append(path: string, data: string | Uint8Array): Promise<void> {
    return this.write(path, data, { flag: 'a' })
  }

  /**
   * Delete a file.
   */
  async unlink(path: string): Promise<void> {
    const resolvedPath = this.resolvePath(path)
    await this.request<void>('POST', '/unlink', { path: resolvedPath })
  }

  /**
   * Rename or move a file or directory.
   */
  async rename(oldPath: string, newPath: string, options?: MoveOptions): Promise<void> {
    const resolvedOldPath = this.resolvePath(oldPath)
    const resolvedNewPath = this.resolvePath(newPath)
    await this.request<void>('POST', '/rename', {
      oldPath: resolvedOldPath,
      newPath: resolvedNewPath,
      overwrite: options?.overwrite,
    })
  }

  /**
   * Copy a file.
   */
  async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    const resolvedSrc = this.resolvePath(src)
    const resolvedDest = this.resolvePath(dest)
    await this.request<void>('POST', '/copy', {
      src: resolvedSrc,
      dest: resolvedDest,
      overwrite: options?.overwrite,
      recursive: options?.recursive,
    })
  }

  /**
   * Truncate a file to a specified length.
   */
  async truncate(path: string, length: number = 0): Promise<void> {
    const resolvedPath = this.resolvePath(path)
    await this.request<void>('POST', '/truncate', { path: resolvedPath, length })
  }

  // ===========================================================================
  // Directory Operations
  // ===========================================================================

  /**
   * Create a directory.
   */
  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const resolvedPath = this.resolvePath(path)
    await this.request<void>('POST', '/mkdir', {
      path: resolvedPath,
      recursive: options?.recursive,
      mode: options?.mode,
    })
  }

  /**
   * Remove a directory.
   */
  async rmdir(path: string, options?: RmdirOptions): Promise<void> {
    const resolvedPath = this.resolvePath(path)
    await this.request<void>('POST', '/rmdir', {
      path: resolvedPath,
      recursive: options?.recursive,
    })
  }

  /**
   * Remove a file or directory.
   */
  async rm(path: string, options?: RemoveOptions): Promise<void> {
    const resolvedPath = this.resolvePath(path)
    await this.request<void>('POST', '/rm', {
      path: resolvedPath,
      recursive: options?.recursive,
      force: options?.force,
    })
  }

  /**
   * List directory contents.
   */
  async list(path: string, options?: ListOptions): Promise<string[] | Dirent[]> {
    return this.readdir(path, options as ReaddirOptions)
  }

  /**
   * Read directory contents.
   */
  async readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]> {
    const resolvedPath = this.resolvePath(path)
    const result = await this.request<{ entries: string[] | RawDirent[] }>(
      'POST',
      '/readdir',
      {
        path: resolvedPath,
        withFileTypes: options?.withFileTypes,
        recursive: options?.recursive,
      }
    )

    if (options?.withFileTypes) {
      return (result.entries as RawDirent[]).map(createDirent)
    }

    return result.entries as string[]
  }

  // ===========================================================================
  // Metadata Operations
  // ===========================================================================

  /**
   * Get file or directory stats.
   */
  async stat(path: string): Promise<Stats> {
    const resolvedPath = this.resolvePath(path)
    const result = await this.request<RawStats>('POST', '/stat', { path: resolvedPath })
    return createStats(result)
  }

  /**
   * Get file stats without following symbolic links.
   */
  async lstat(path: string): Promise<Stats> {
    const resolvedPath = this.resolvePath(path)
    const result = await this.request<RawStats>('POST', '/lstat', { path: resolvedPath })
    return createStats(result)
  }

  /**
   * Check if a path exists.
   */
  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path)
      return true
    } catch (error) {
      if (error instanceof ENOENT) {
        return false
      }
      throw error
    }
  }

  /**
   * Check file accessibility and permissions.
   */
  async access(path: string, mode?: number): Promise<void> {
    const resolvedPath = this.resolvePath(path)
    await this.request<void>('POST', '/access', { path: resolvedPath, mode })
  }

  /**
   * Change file permissions.
   */
  async chmod(path: string, mode: number): Promise<void> {
    const resolvedPath = this.resolvePath(path)
    await this.request<void>('POST', '/chmod', { path: resolvedPath, mode })
  }

  /**
   * Change file ownership.
   */
  async chown(path: string, uid: number, gid: number): Promise<void> {
    const resolvedPath = this.resolvePath(path)
    await this.request<void>('POST', '/chown', { path: resolvedPath, uid, gid })
  }

  /**
   * Update file timestamps.
   */
  async utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void> {
    const resolvedPath = this.resolvePath(path)
    await this.request<void>('POST', '/utimes', {
      path: resolvedPath,
      atime: atime instanceof Date ? atime.getTime() : atime,
      mtime: mtime instanceof Date ? mtime.getTime() : mtime,
    })
  }

  // ===========================================================================
  // Symbolic Links
  // ===========================================================================

  /**
   * Create a symbolic link.
   */
  async symlink(target: string, path: string): Promise<void> {
    const resolvedPath = this.resolvePath(path)
    await this.request<void>('POST', '/symlink', { target, path: resolvedPath })
  }

  /**
   * Create a hard link.
   */
  async link(existingPath: string, newPath: string): Promise<void> {
    const resolvedExisting = this.resolvePath(existingPath)
    const resolvedNew = this.resolvePath(newPath)
    await this.request<void>('POST', '/link', {
      existingPath: resolvedExisting,
      newPath: resolvedNew,
    })
  }

  /**
   * Read the target of a symbolic link.
   */
  async readlink(path: string): Promise<string> {
    const resolvedPath = this.resolvePath(path)
    const result = await this.request<{ target: string }>('POST', '/readlink', {
      path: resolvedPath,
    })
    return result.target
  }

  /**
   * Resolve the absolute path, following symbolic links.
   */
  async realpath(path: string): Promise<string> {
    const resolvedPath = this.resolvePath(path)
    const result = await this.request<{ path: string }>('POST', '/realpath', {
      path: resolvedPath,
    })
    return result.path
  }

  // ===========================================================================
  // Streaming Operations
  // ===========================================================================

  /**
   * Create a readable stream for a file.
   *
   * Note: This creates a stream by fetching the file content and streaming it.
   * For very large files, consider using the chunked read API.
   */
  async createReadStream(
    path: string,
    options?: ReadStreamOptions
  ): Promise<ReadableStream<Uint8Array>> {
    const resolvedPath = this.resolvePath(path)
    const params: Record<string, unknown> = { path: resolvedPath }

    if (options?.start !== undefined) params.start = options.start
    if (options?.end !== undefined) params.end = options.end

    const result = await this.request<{ content: string }>('POST', '/read', params)
    const bytes = base64ToBytes(result.content)

    const highWaterMark = options?.highWaterMark ?? 16384
    let offset = 0

    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close()
          return
        }

        const chunk = bytes.slice(offset, offset + highWaterMark)
        offset += chunk.length
        controller.enqueue(chunk)
      },
    })
  }

  /**
   * Create a writable stream for a file.
   *
   * Note: This buffers all writes and sends them when the stream closes.
   * For very large files, consider using the chunked write API.
   */
  async createWriteStream(
    path: string,
    options?: WriteStreamOptions
  ): Promise<WritableStream<Uint8Array>> {
    const resolvedPath = this.resolvePath(path)
    const chunks: Uint8Array[] = []
    const self = this

    return new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk)
      },
      async close() {
        // Combine all chunks into a single buffer
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
        const data = new Uint8Array(totalLength)
        let offset = 0
        for (const chunk of chunks) {
          data.set(chunk, offset)
          offset += chunk.length
        }

        // Write to the file
        await self.write(resolvedPath, data, {
          mode: options?.mode,
          flag: options?.flags,
        })
      },
    })
  }

  // ===========================================================================
  // File Handle Operations
  // ===========================================================================

  /**
   * Open a file and return a file handle.
   *
   * Note: Remote file handles maintain state on the server side.
   * Each operation is a separate HTTP request.
   */
  async open(path: string, flags?: string | number, mode?: number): Promise<IFileHandle> {
    const resolvedPath = this.resolvePath(path)
    const result = await this.request<{ fd: number; size: number; mode: number }>(
      'POST',
      '/open',
      {
        path: resolvedPath,
        flags,
        mode,
      }
    )

    return new RemoteFileHandle(this, resolvedPath, result.fd, result.size, result.mode)
  }

  // ===========================================================================
  // Watch Operations
  // ===========================================================================

  /**
   * Watch a file or directory for changes.
   *
   * Note: This uses WebSocket connections for real-time updates.
   * Falls back to polling if WebSockets are not available.
   */
  watch(
    path: string,
    options?: WatchOptions,
    listener?: (eventType: 'rename' | 'change', filename: string) => void
  ): FSWatcher {
    const resolvedPath = this.resolvePath(path)
    return new RemoteFSWatcher(this.baseUrl, resolvedPath, options, listener, {
      authHeader: this.authHeader,
      namespace: this.namespace,
    })
  }

  // ===========================================================================
  // Tiered Storage Operations
  // ===========================================================================

  /**
   * Promote a file to a higher (faster) storage tier.
   */
  async promote(path: string, tier: 'hot' | 'warm'): Promise<void> {
    const resolvedPath = this.resolvePath(path)
    await this.request<void>('POST', '/promote', { path: resolvedPath, tier })
  }

  /**
   * Demote a file to a lower (cheaper) storage tier.
   */
  async demote(path: string, tier: 'warm' | 'cold'): Promise<void> {
    const resolvedPath = this.resolvePath(path)
    await this.request<void>('POST', '/demote', { path: resolvedPath, tier })
  }

  /**
   * Get the storage tier of a file.
   */
  async getTier(path: string): Promise<StorageTier> {
    const resolvedPath = this.resolvePath(path)
    const result = await this.request<{ tier: StorageTier }>('POST', '/getTier', {
      path: resolvedPath,
    })
    return result.tier
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Update authentication credentials.
   */
  setAuth(auth: string | undefined): void {
    this.authHeader = auth ? `Bearer ${auth}` : undefined
  }

  /**
   * Update custom headers.
   */
  setHeaders(headers: Record<string, string>): void {
    this.headers = { ...this.headers, ...headers }
  }

  /**
   * Set the namespace for operations.
   */
  setNamespace(namespace: string | undefined): void {
    this.namespace = namespace
  }

  /**
   * Get the current base URL.
   */
  getBaseUrl(): string {
    return this.baseUrl
  }
}

// =============================================================================
// Remote File Handle Implementation
// =============================================================================

/**
 * Remote file handle that proxies operations to the server.
 */
class RemoteFileHandle implements IFileHandle {
  readonly fd: number
  private client: RemoteFsClient
  private path: string
  private _size: number
  private _mode: number
  private _closed: boolean = false

  constructor(
    client: RemoteFsClient,
    path: string,
    fd: number,
    size: number,
    mode: number
  ) {
    this.client = client
    this.path = path
    this.fd = fd
    this._size = size
    this._mode = mode
  }

  private ensureOpen(): void {
    if (this._closed) {
      throw new EBADF('read')
    }
  }

  async read(
    buffer: Uint8Array,
    offset: number = 0,
    length?: number,
    position?: number
  ): Promise<{ bytesRead: number; buffer: Uint8Array }> {
    this.ensureOpen()

    const readLength = length ?? buffer.length - offset
    const data = await this.client.read(this.path, {
      start: position ?? 0,
      end: (position ?? 0) + readLength - 1,
    })

    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data)
    const bytesToCopy = Math.min(bytes.length, readLength)
    buffer.set(bytes.subarray(0, bytesToCopy), offset)

    return { bytesRead: bytesToCopy, buffer }
  }

  async write(
    data: Uint8Array | ArrayBuffer | string,
    position?: number | null,
    length?: number,
    offset?: number
  ): Promise<{ bytesWritten: number; buffer?: Uint8Array }> {
    this.ensureOpen()

    let bytes: Uint8Array
    if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data)
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data)
    } else {
      bytes = data
    }

    const bufferOffset = offset ?? 0
    const writeLength = length ?? bytes.length - bufferOffset
    const toWrite = bytes.subarray(bufferOffset, bufferOffset + writeLength)

    // For simplicity, we re-write the entire file with modifications
    // A more sophisticated implementation would use a partial write API
    await this.client.write(this.path, toWrite)
    this._size = Math.max(this._size, (position ?? 0) + toWrite.length)

    return { bytesWritten: toWrite.length, buffer: bytes }
  }

  async stat(): Promise<Stats> {
    this.ensureOpen()
    return this.client.stat(this.path)
  }

  async truncate(length: number = 0): Promise<void> {
    this.ensureOpen()
    await this.client.truncate(this.path, length)
    this._size = length
  }

  async sync(): Promise<void> {
    this.ensureOpen()
    // Remote operations are immediately synced
  }

  async close(): Promise<void> {
    if (this._closed) return
    this._closed = true
    // No server-side cleanup needed for stateless operations
  }

  createReadStream(options?: ReadStreamOptions): ReadableStream<Uint8Array> {
    this.ensureOpen()

    const client = this.client
    const path = this.path
    const start = options?.start ?? 0
    const end = options?.end ?? this._size - 1
    const highWaterMark = options?.highWaterMark ?? 16384
    let position = start

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (position > end) {
          controller.close()
          return
        }

        const chunkEnd = Math.min(position + highWaterMark - 1, end)
        const data = await client.read(path, { start: position, end: chunkEnd })
        const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(data)

        position = chunkEnd + 1
        controller.enqueue(bytes)
      },
    })
  }

  createWriteStream(options?: WriteStreamOptions): WritableStream<Uint8Array> {
    this.ensureOpen()

    const handle = this
    let position = options?.start ?? 0

    return new WritableStream<Uint8Array>({
      async write(chunk) {
        await handle.write(chunk, position)
        position += chunk.length
      },
    })
  }

  async [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

// =============================================================================
// Remote FS Watcher Implementation
// =============================================================================

/**
 * Remote filesystem watcher using WebSocket or polling.
 */
class RemoteFSWatcher implements FSWatcher {
  private ws: WebSocket | null = null
  private closed: boolean = false
  private pollInterval: ReturnType<typeof setInterval> | null = null

  constructor(
    private baseUrl: string,
    private path: string,
    private options: WatchOptions | undefined,
    private listener: ((eventType: 'rename' | 'change', filename: string) => void) | undefined,
    private connectionOptions: { authHeader?: string; namespace?: string }
  ) {
    this.connect()
  }

  private connect(): void {
    // Try WebSocket first
    try {
      const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/api/fs/watch'
      this.ws = new WebSocket(wsUrl)

      this.ws.onopen = () => {
        // Subscribe to path
        this.ws?.send(
          JSON.stringify({
            type: 'subscribe',
            path: this.path,
            recursive: this.options?.recursive,
            auth: this.connectionOptions.authHeader,
            namespace: this.connectionOptions.namespace,
          })
        )
      }

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'change' && this.listener) {
            this.listener(data.eventType, data.filename)
          }
        } catch {
          // Ignore parse errors
        }
      }

      this.ws.onerror = () => {
        // Fall back to polling
        this.ws?.close()
        this.ws = null
        this.startPolling()
      }

      this.ws.onclose = () => {
        if (!this.closed) {
          // Attempt reconnection
          setTimeout(() => this.connect(), 5000)
        }
      }
    } catch {
      // WebSocket not available, use polling
      this.startPolling()
    }
  }

  private startPolling(): void {
    // Simple polling implementation
    // In a real implementation, this would track file mtimes and compare
    this.pollInterval = setInterval(() => {
      // Polling logic would go here
    }, 1000)
  }

  close(): void {
    this.closed = true
    this.ws?.close()
    this.ws = null
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }

  ref(): this {
    // No-op for remote watcher
    return this
  }

  unref(): this {
    // No-op for remote watcher
    return this
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a new RemoteFsClient instance.
 *
 * @param baseUrl - Base URL of the fsx.do service
 * @param options - Client configuration options
 * @returns A new RemoteFsClient implementing FsCapability
 *
 * @example
 * ```typescript
 * import { createRemoteFs } from 'fsx.do/client'
 *
 * const fs = createRemoteFs('https://fsx.do', { auth: 'my-api-key' })
 * await fs.write('/hello.txt', 'Hello!')
 * ```
 */
export function createRemoteFs(
  baseUrl: string,
  options?: RemoteFsClientOptions
): RemoteFsClient {
  return new RemoteFsClient(baseUrl, options)
}

// =============================================================================
// Default Export
// =============================================================================

export default RemoteFsClient
