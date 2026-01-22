/**
 * FsxClient - SDK client for remote fsx.do service access
 *
 * Provides a TypeScript client that mirrors the FSx API for accessing
 * remote fsx.do services over HTTP. Works in both browsers and Node.js.
 *
 * @module client
 * @example
 * ```typescript
 * import { FsxClient } from 'fsx.do/client'
 *
 * const client = new FsxClient({
 *   baseUrl: 'https://fsx.do',
 *   apiKey: 'your-api-key',
 * })
 *
 * // Write a file
 * await client.writeFile('/hello.txt', 'Hello, World!')
 *
 * // Read a file
 * const content = await client.readFile('/hello.txt', 'utf-8')
 *
 * // Get file stats
 * const stats = await client.stat('/hello.txt')
 * ```
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Authentication options for the FsxClient.
 */
export interface FsxAuthOptions {
  /**
   * API key for authentication.
   * Sent as `Authorization: Bearer <apiKey>` header.
   */
  apiKey?: string

  /**
   * JWT token for authentication.
   * Sent as `Authorization: Bearer <jwt>` header.
   */
  jwt?: string

  /**
   * Custom authorization header value.
   * Use for custom authentication schemes.
   */
  authorization?: string
}

/**
 * Configuration options for FsxClient.
 */
export interface FsxClientOptions extends FsxAuthOptions {
  /**
   * Base URL of the fsx.do service.
   * @example 'https://fsx.do' or 'https://my-fsx.workers.dev'
   */
  baseUrl: string

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
}

/**
 * Storage tier for tiered filesystem operations.
 */
export type StorageTier = 'hot' | 'warm' | 'cold'

/**
 * File type enumeration.
 */
export type FileType = 'file' | 'directory' | 'symlink' | 'block' | 'character' | 'fifo' | 'socket'

/**
 * Buffer encoding types.
 */
export type BufferEncoding = 'utf-8' | 'utf8' | 'ascii' | 'base64' | 'hex' | 'binary' | 'latin1'

/**
 * File statistics returned by stat operations.
 */
export interface Stats {
  /** Device ID */
  dev: number
  /** Inode number */
  ino: number
  /** File mode (permissions + type) */
  mode: number
  /** Number of hard links */
  nlink: number
  /** User ID */
  uid: number
  /** Group ID */
  gid: number
  /** Device ID (if special file) */
  rdev: number
  /** File size in bytes */
  size: number
  /** Block size */
  blksize: number
  /** Number of blocks */
  blocks: number
  /** Access time in ms */
  atimeMs: number
  /** Modification time in ms */
  mtimeMs: number
  /** Change time (metadata) in ms */
  ctimeMs: number
  /** Birth time (creation) in ms */
  birthtimeMs: number
  /** Storage tier (for files) */
  tier?: StorageTier
  /** Check if this is a regular file */
  isFile(): boolean
  /** Check if this is a directory */
  isDirectory(): boolean
  /** Check if this is a symbolic link */
  isSymbolicLink(): boolean
  /** Check if this is a block device */
  isBlockDevice(): boolean
  /** Check if this is a character device */
  isCharacterDevice(): boolean
  /** Check if this is a FIFO */
  isFIFO(): boolean
  /** Check if this is a socket */
  isSocket(): boolean
}

/**
 * Directory entry returned by readdir with withFileTypes: true.
 */
export interface Dirent {
  /** Entry name (filename without path) */
  name: string
  /** Parent directory path */
  parentPath: string
  /** Full path */
  path: string
  /** Check if this is a regular file */
  isFile(): boolean
  /** Check if this is a directory */
  isDirectory(): boolean
  /** Check if this is a symbolic link */
  isSymbolicLink(): boolean
  /** Check if this is a block device */
  isBlockDevice(): boolean
  /** Check if this is a character device */
  isCharacterDevice(): boolean
  /** Check if this is a FIFO */
  isFIFO(): boolean
  /** Check if this is a socket */
  isSocket(): boolean
}

/**
 * Options for file read operations.
 */
export interface ReadOptions {
  /** Character encoding for string output */
  encoding?: BufferEncoding | null
  /** Start byte position for range reads (inclusive) */
  start?: number
  /** End byte position for range reads (inclusive) */
  end?: number
  /** Abort signal for cancellation support */
  signal?: AbortSignal
}

/**
 * Options for file write operations.
 */
export interface WriteOptions {
  /** Character encoding for string data */
  encoding?: BufferEncoding
  /** File mode (permissions) for newly created files */
  mode?: number
  /** File system flag (w, a, wx, ax) */
  flag?: string
  /** Target storage tier */
  tier?: StorageTier
  /** Abort signal for cancellation support */
  signal?: AbortSignal
}

/**
 * Options for directory listing operations.
 */
export interface ListOptions {
  /** Return Dirent objects instead of just file names */
  withFileTypes?: boolean
  /** Recursively list all files and directories */
  recursive?: boolean
  /** Maximum depth for recursive listing */
  maxDepth?: number
  /** Filter pattern (glob) to match file names */
  filter?: string
  /** Abort signal for cancellation support */
  signal?: AbortSignal
}

/**
 * Options for mkdir operations.
 */
export interface MkdirOptions {
  /** Create parent directories if needed */
  recursive?: boolean
  /** Directory mode (permissions) */
  mode?: number
}

/**
 * Options for rmdir operations.
 */
export interface RmdirOptions {
  /** Remove recursively */
  recursive?: boolean
}

/**
 * Options for rm operations.
 */
export interface RemoveOptions {
  /** Remove directories and their contents recursively */
  recursive?: boolean
  /** Ignore errors if path does not exist */
  force?: boolean
}

/**
 * Options for copy operations.
 */
export interface CopyOptions {
  /** Overwrite destination if it exists */
  overwrite?: boolean
  /** Recursive copy for directories */
  recursive?: boolean
}

/**
 * Options for move/rename operations.
 */
export interface MoveOptions {
  /** Overwrite destination if it exists */
  overwrite?: boolean
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
  }
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
// Error Classes
// =============================================================================

/**
 * Base filesystem error class.
 */
export class FsxError extends Error {
  /** POSIX error code (ENOENT, EEXIST, etc.) */
  code: string
  /** Path that caused the error */
  path?: string
  /** HTTP status code from the API */
  status?: number

  constructor(code: string, message: string, path?: string, status?: number) {
    super(`${code}: ${message}${path ? ` - ${path}` : ''}`)
    this.name = 'FsxError'
    this.code = code
    this.path = path
    this.status = status
  }
}

/**
 * File or directory not found error.
 */
export class FsxNotFoundError extends FsxError {
  constructor(message?: string, path?: string) {
    super('ENOENT', message ?? 'no such file or directory', path, 404)
    this.name = 'FsxNotFoundError'
  }
}

/**
 * File or directory already exists error.
 */
export class FsxExistsError extends FsxError {
  constructor(message?: string, path?: string) {
    super('EEXIST', message ?? 'file already exists', path, 409)
    this.name = 'FsxExistsError'
  }
}

/**
 * Permission denied error.
 */
export class FsxPermissionError extends FsxError {
  constructor(message?: string, path?: string) {
    super('EACCES', message ?? 'permission denied', path, 403)
    this.name = 'FsxPermissionError'
  }
}

/**
 * Authentication error.
 */
export class FsxAuthError extends FsxError {
  constructor(message?: string) {
    super('EAUTH', message ?? 'authentication failed', undefined, 401)
    this.name = 'FsxAuthError'
  }
}

/**
 * Network/connection error.
 */
export class FsxNetworkError extends FsxError {
  constructor(message?: string) {
    super('ENETWORK', message ?? 'network error', undefined)
    this.name = 'FsxNetworkError'
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert raw stats data from API to Stats object with methods.
 */
function createStats(raw: RawStats): Stats {
  return {
    ...raw,
    isFile: () => (raw.mode & S_IFMT) === S_IFREG || raw.type === 'file',
    isDirectory: () => (raw.mode & S_IFMT) === S_IFDIR || raw.type === 'directory',
    isSymbolicLink: () => (raw.mode & S_IFMT) === S_IFLNK || raw.type === 'symlink',
    isBlockDevice: () => (raw.mode & S_IFMT) === S_IFBLK || raw.type === 'block',
    isCharacterDevice: () => (raw.mode & S_IFMT) === S_IFCHR || raw.type === 'character',
    isFIFO: () => (raw.mode & S_IFMT) === S_IFIFO || raw.type === 'fifo',
    isSocket: () => (raw.mode & S_IFMT) === S_IFSOCK || raw.type === 'socket',
  }
}

/**
 * Convert raw dirent data from API to Dirent object with methods.
 */
function createDirent(raw: RawDirent): Dirent {
  return {
    ...raw,
    isFile: () => raw.type === 'file',
    isDirectory: () => raw.type === 'directory',
    isSymbolicLink: () => raw.type === 'symlink',
    isBlockDevice: () => raw.type === 'block',
    isCharacterDevice: () => raw.type === 'character',
    isFIFO: () => raw.type === 'fifo',
    isSocket: () => raw.type === 'socket',
  }
}

/**
 * Convert string or Uint8Array to base64 for API transport.
 */
function encodeData(data: string | Uint8Array): string {
  if (typeof data === 'string') {
    // Encode string as UTF-8 bytes then base64
    const bytes = new TextEncoder().encode(data)
    return bytesToBase64(bytes)
  }
  return bytesToBase64(data)
}

/**
 * Convert Uint8Array to base64 string.
 */
function bytesToBase64(bytes: Uint8Array): string {
  // Use built-in btoa in browser, or Buffer in Node.js
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
  // Use built-in atob in browser, or Buffer in Node.js
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

// =============================================================================
// FsxClient Class
// =============================================================================

/**
 * SDK client for remote fsx.do service access.
 *
 * Provides a full-featured filesystem API that communicates with
 * a remote fsx.do service via HTTP. Works in browsers and Node.js.
 *
 * @example
 * ```typescript
 * // Create client with API key
 * const client = new FsxClient({
 *   baseUrl: 'https://fsx.do',
 *   apiKey: 'sk_live_...',
 * })
 *
 * // Create client with JWT
 * const client = new FsxClient({
 *   baseUrl: 'https://fsx.do',
 *   jwt: 'eyJ...',
 * })
 *
 * // Create client with custom auth header
 * const client = new FsxClient({
 *   baseUrl: 'https://fsx.do',
 *   authorization: 'Custom my-token',
 * })
 * ```
 */
export class FsxClient {
  private baseUrl: string
  private timeout: number
  private fetchFn: typeof globalThis.fetch
  private headers: Record<string, string>
  private namespace?: string
  private authHeader?: string

  /**
   * Create a new FsxClient instance.
   *
   * @param options - Client configuration options
   * @throws {Error} If baseUrl is not provided
   */
  constructor(options: FsxClientOptions) {
    if (!options.baseUrl) {
      throw new Error('FsxClient requires a baseUrl')
    }

    this.baseUrl = options.baseUrl.replace(/\/$/, '') // Remove trailing slash
    this.timeout = options.timeout ?? 30000
    this.fetchFn = options.fetch ?? globalThis.fetch
    this.headers = options.headers ?? {}
    this.namespace = options.namespace

    // Set up authentication
    if (options.authorization) {
      this.authHeader = options.authorization
    } else if (options.jwt) {
      this.authHeader = `Bearer ${options.jwt}`
    } else if (options.apiKey) {
      this.authHeader = `Bearer ${options.apiKey}`
    }
  }

  // ===========================================================================
  // Internal HTTP Methods
  // ===========================================================================

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
        this.handleError(result, response.status)
      }

      return result.data as T
    } catch (error) {
      clearTimeout(timeoutId)
      if (error instanceof FsxError) {
        throw error
      }
      if ((error as Error).name === 'AbortError') {
        throw new FsxNetworkError('Request aborted or timed out')
      }
      throw new FsxNetworkError((error as Error).message)
    }
  }

  /**
   * Handle API error response and throw appropriate error.
   */
  private handleError(result: ApiResponse<unknown>, status: number): never {
    const error = result.error ?? { code: 'UNKNOWN', message: 'Unknown error' }

    switch (error.code) {
      case 'ENOENT':
        throw new FsxNotFoundError(error.message, error.path)
      case 'EEXIST':
        throw new FsxExistsError(error.message, error.path)
      case 'EACCES':
      case 'EPERM':
        throw new FsxPermissionError(error.message, error.path)
      case 'EAUTH':
        throw new FsxAuthError(error.message)
      default:
        throw new FsxError(error.code, error.message, error.path, status)
    }
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Read a file's contents.
   *
   * @param path - Path to the file to read
   * @param encoding - Output encoding (utf-8 returns string, undefined returns Uint8Array)
   * @returns File contents as string or Uint8Array
   * @throws {FsxNotFoundError} If the file does not exist
   * @throws {FsxError} If the path is a directory
   *
   * @example
   * ```typescript
   * // Read as string
   * const text = await client.readFile('/hello.txt', 'utf-8')
   *
   * // Read as binary
   * const bytes = await client.readFile('/image.png')
   * ```
   */
  async readFile(path: string, encoding?: BufferEncoding): Promise<string | Uint8Array>
  async readFile(path: string, options?: ReadOptions): Promise<string | Uint8Array>
  async readFile(
    path: string,
    encodingOrOptions?: BufferEncoding | ReadOptions
  ): Promise<string | Uint8Array> {
    const options: ReadOptions =
      typeof encodingOrOptions === 'string' ? { encoding: encodingOrOptions } : encodingOrOptions ?? {}

    const params: Record<string, unknown> = { path }
    if (options.start !== undefined) params.start = options.start
    if (options.end !== undefined) params.end = options.end

    const result = await this.request<{ content: string; encoding: string }>(
      'POST',
      '/read',
      params,
      { signal: options.signal }
    )

    // Decode the base64 content
    const bytes = base64ToBytes(result.content)

    // Return string if encoding requested
    if (options.encoding) {
      return new TextDecoder().decode(bytes)
    }

    return bytes
  }

  /**
   * Write data to a file.
   *
   * @param path - Path to the file to write
   * @param data - Content to write (string or bytes)
   * @param options - Write options
   * @throws {FsxNotFoundError} If the parent directory does not exist
   * @throws {FsxExistsError} If flag is 'wx' and file exists
   *
   * @example
   * ```typescript
   * // Write a string
   * await client.writeFile('/hello.txt', 'Hello, World!')
   *
   * // Write with options
   * await client.writeFile('/data.json', JSON.stringify(data), {
   *   mode: 0o600,
   *   tier: 'hot',
   * })
   * ```
   */
  async writeFile(
    path: string,
    data: string | Uint8Array,
    options?: WriteOptions
  ): Promise<void> {
    const params: Record<string, unknown> = {
      path,
      content: encodeData(data),
    }

    if (options?.mode !== undefined) params.mode = options.mode
    if (options?.flag) params.flag = options.flag
    if (options?.tier) params.tier = options.tier

    await this.request<void>('POST', '/write', params, { signal: options?.signal })
  }

  /**
   * Append data to a file.
   *
   * @param path - Path to the file
   * @param data - Content to append
   *
   * @example
   * ```typescript
   * await client.appendFile('/log.txt', 'New log entry\n')
   * ```
   */
  async appendFile(path: string, data: string | Uint8Array): Promise<void> {
    return this.writeFile(path, data, { flag: 'a' })
  }

  /**
   * Delete a file.
   *
   * @param path - Path to the file to delete
   * @throws {FsxNotFoundError} If the file does not exist
   * @throws {FsxError} If the path is a directory
   *
   * @example
   * ```typescript
   * await client.unlink('/old-file.txt')
   * ```
   */
  async unlink(path: string): Promise<void> {
    await this.request<void>('POST', '/unlink', { path })
  }

  /**
   * Rename or move a file or directory.
   *
   * @param oldPath - Current path
   * @param newPath - New path
   * @param options - Move options
   * @throws {FsxNotFoundError} If oldPath does not exist
   * @throws {FsxExistsError} If newPath exists and overwrite is false
   *
   * @example
   * ```typescript
   * await client.rename('/old-name.txt', '/new-name.txt')
   * await client.rename('/src/file.txt', '/dest/file.txt')
   * ```
   */
  async rename(oldPath: string, newPath: string, options?: MoveOptions): Promise<void> {
    await this.request<void>('POST', '/rename', {
      oldPath,
      newPath,
      overwrite: options?.overwrite,
    })
  }

  /**
   * Copy a file.
   *
   * @param src - Source file path
   * @param dest - Destination file path
   * @param options - Copy options
   * @throws {FsxNotFoundError} If the source does not exist
   * @throws {FsxExistsError} If dest exists and overwrite is false
   *
   * @example
   * ```typescript
   * await client.copyFile('/original.txt', '/backup.txt')
   * ```
   */
  async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.request<void>('POST', '/copy', {
      src,
      dest,
      overwrite: options?.overwrite,
      recursive: options?.recursive,
    })
  }

  /**
   * Truncate a file to a specified length.
   *
   * @param path - Path to the file
   * @param length - New length in bytes (default: 0)
   * @throws {FsxNotFoundError} If file does not exist
   *
   * @example
   * ```typescript
   * await client.truncate('/large-file.txt', 1024)
   * ```
   */
  async truncate(path: string, length: number = 0): Promise<void> {
    await this.request<void>('POST', '/truncate', { path, length })
  }

  // ===========================================================================
  // Directory Operations
  // ===========================================================================

  /**
   * Create a directory.
   *
   * @param path - Path for the new directory
   * @param options - Creation options
   * @throws {FsxExistsError} If directory already exists
   * @throws {FsxNotFoundError} If parent doesn't exist and recursive is false
   *
   * @example
   * ```typescript
   * await client.mkdir('/mydir')
   * await client.mkdir('/a/b/c', { recursive: true })
   * ```
   */
  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.request<void>('POST', '/mkdir', {
      path,
      recursive: options?.recursive,
      mode: options?.mode,
    })
  }

  /**
   * Remove a directory.
   *
   * @param path - Path to the directory
   * @param options - Removal options
   * @throws {FsxNotFoundError} If directory does not exist
   * @throws {FsxError} If directory is not empty and recursive is false
   *
   * @example
   * ```typescript
   * await client.rmdir('/empty-dir')
   * await client.rmdir('/full-dir', { recursive: true })
   * ```
   */
  async rmdir(path: string, options?: RmdirOptions): Promise<void> {
    await this.request<void>('POST', '/rmdir', {
      path,
      recursive: options?.recursive,
    })
  }

  /**
   * Remove a file or directory.
   *
   * @param path - Path to remove
   * @param options - Removal options
   * @throws {FsxNotFoundError} If path doesn't exist and force is false
   *
   * @example
   * ```typescript
   * await client.rm('/file.txt')
   * await client.rm('/directory', { recursive: true, force: true })
   * ```
   */
  async rm(path: string, options?: RemoveOptions): Promise<void> {
    await this.request<void>('POST', '/rm', {
      path,
      recursive: options?.recursive,
      force: options?.force,
    })
  }

  /**
   * Read directory contents.
   *
   * @param path - Path to the directory
   * @param options - Read options
   * @returns Array of filenames or Dirent objects
   * @throws {FsxNotFoundError} If directory does not exist
   *
   * @example
   * ```typescript
   * // List filenames
   * const files = await client.readdir('/mydir')
   *
   * // List with file types
   * const entries = await client.readdir('/mydir', { withFileTypes: true })
   * entries.forEach(e => console.log(e.name, e.isDirectory()))
   * ```
   */
  async readdir(path: string, options?: ListOptions & { withFileTypes: true }): Promise<Dirent[]>
  async readdir(path: string, options?: ListOptions & { withFileTypes?: false }): Promise<string[]>
  async readdir(path: string, options?: ListOptions): Promise<string[] | Dirent[]>
  async readdir(path: string, options?: ListOptions): Promise<string[] | Dirent[]> {
    const result = await this.request<{ entries: string[] | RawDirent[] }>(
      'POST',
      '/readdir',
      {
        path,
        withFileTypes: options?.withFileTypes,
        recursive: options?.recursive,
        maxDepth: options?.maxDepth,
        filter: options?.filter,
      },
      { signal: options?.signal }
    )

    if (options?.withFileTypes) {
      return (result.entries as RawDirent[]).map(createDirent)
    }

    return result.entries as string[]
  }

  /**
   * List directory contents (alias for readdir).
   */
  async list(path: string, options?: ListOptions): Promise<string[] | Dirent[]> {
    return this.readdir(path, options)
  }

  // ===========================================================================
  // Metadata Operations
  // ===========================================================================

  /**
   * Get file or directory stats.
   *
   * @param path - Path to the file or directory
   * @returns Stats object with file metadata
   * @throws {FsxNotFoundError} If the path does not exist
   *
   * @example
   * ```typescript
   * const stats = await client.stat('/myfile.txt')
   * console.log(stats.size)
   * console.log(stats.isFile())
   * ```
   */
  async stat(path: string): Promise<Stats> {
    const result = await this.request<RawStats>('POST', '/stat', { path })
    return createStats(result)
  }

  /**
   * Get file stats without following symbolic links.
   *
   * @param path - Path to the file, directory, or symbolic link
   * @returns Stats object with file metadata
   * @throws {FsxNotFoundError} If the path does not exist
   */
  async lstat(path: string): Promise<Stats> {
    const result = await this.request<RawStats>('POST', '/lstat', { path })
    return createStats(result)
  }

  /**
   * Check if a path exists.
   *
   * @param path - Path to check
   * @returns true if the path exists
   *
   * @example
   * ```typescript
   * if (await client.exists('/config.json')) {
   *   const config = await client.readFile('/config.json', 'utf-8')
   * }
   * ```
   */
  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path)
      return true
    } catch (error) {
      if (error instanceof FsxNotFoundError) {
        return false
      }
      throw error
    }
  }

  /**
   * Check file accessibility and permissions.
   *
   * @param path - Path to check
   * @param mode - Accessibility mode (F_OK, R_OK, W_OK, X_OK)
   * @throws {FsxNotFoundError} If path does not exist
   * @throws {FsxPermissionError} If access is denied
   */
  async access(path: string, mode?: number): Promise<void> {
    await this.request<void>('POST', '/access', { path, mode })
  }

  /**
   * Change file permissions.
   *
   * @param path - Path to the file or directory
   * @param mode - New permissions (octal, e.g., 0o755)
   * @throws {FsxNotFoundError} If the path does not exist
   *
   * @example
   * ```typescript
   * await client.chmod('/script.sh', 0o755)
   * ```
   */
  async chmod(path: string, mode: number): Promise<void> {
    await this.request<void>('POST', '/chmod', { path, mode })
  }

  /**
   * Change file ownership.
   *
   * @param path - Path to the file or directory
   * @param uid - User ID
   * @param gid - Group ID
   * @throws {FsxNotFoundError} If the path does not exist
   */
  async chown(path: string, uid: number, gid: number): Promise<void> {
    await this.request<void>('POST', '/chown', { path, uid, gid })
  }

  /**
   * Update file timestamps.
   *
   * @param path - Path to the file
   * @param atime - Access time
   * @param mtime - Modification time
   * @throws {FsxNotFoundError} If the file does not exist
   */
  async utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void> {
    await this.request<void>('POST', '/utimes', {
      path,
      atime: atime instanceof Date ? atime.getTime() : atime,
      mtime: mtime instanceof Date ? mtime.getTime() : mtime,
    })
  }

  // ===========================================================================
  // Symbolic Links
  // ===========================================================================

  /**
   * Create a symbolic link.
   *
   * @param target - The path the symlink should point to
   * @param path - Where to create the symlink
   * @throws {FsxExistsError} If a file already exists at path
   *
   * @example
   * ```typescript
   * await client.symlink('/actual/file.txt', '/link-to-file.txt')
   * ```
   */
  async symlink(target: string, path: string): Promise<void> {
    await this.request<void>('POST', '/symlink', { target, path })
  }

  /**
   * Create a hard link.
   *
   * @param existingPath - Path to the existing file
   * @param newPath - Path for the new hard link
   * @throws {FsxNotFoundError} If existingPath does not exist
   * @throws {FsxExistsError} If newPath already exists
   */
  async link(existingPath: string, newPath: string): Promise<void> {
    await this.request<void>('POST', '/link', { existingPath, newPath })
  }

  /**
   * Read the target of a symbolic link.
   *
   * @param path - Path to the symbolic link
   * @returns The target path
   * @throws {FsxNotFoundError} If the path does not exist
   * @throws {FsxError} If the path is not a symbolic link
   *
   * @example
   * ```typescript
   * const target = await client.readlink('/mylink')
   * ```
   */
  async readlink(path: string): Promise<string> {
    const result = await this.request<{ target: string }>('POST', '/readlink', { path })
    return result.target
  }

  /**
   * Resolve the absolute path, following symbolic links.
   *
   * @param path - Path to resolve
   * @returns The resolved absolute path
   * @throws {FsxNotFoundError} If the path does not exist
   *
   * @example
   * ```typescript
   * const real = await client.realpath('/app/../data/./link')
   * ```
   */
  async realpath(path: string): Promise<string> {
    const result = await this.request<{ path: string }>('POST', '/realpath', { path })
    return result.path
  }

  // ===========================================================================
  // Tiered Storage Operations
  // ===========================================================================

  /**
   * Promote a file to a higher (faster) storage tier.
   *
   * @param path - Path to the file
   * @param tier - Target tier ('hot' or 'warm')
   * @throws {FsxNotFoundError} If file does not exist
   *
   * @example
   * ```typescript
   * await client.promote('/data/important.json', 'hot')
   * ```
   */
  async promote(path: string, tier: 'hot' | 'warm'): Promise<void> {
    await this.request<void>('POST', '/promote', { path, tier })
  }

  /**
   * Demote a file to a lower (cheaper) storage tier.
   *
   * @param path - Path to the file
   * @param tier - Target tier ('warm' or 'cold')
   * @throws {FsxNotFoundError} If file does not exist
   *
   * @example
   * ```typescript
   * await client.demote('/data/archive.json', 'cold')
   * ```
   */
  async demote(path: string, tier: 'warm' | 'cold'): Promise<void> {
    await this.request<void>('POST', '/demote', { path, tier })
  }

  /**
   * Get the storage tier of a file.
   *
   * @param path - Path to the file
   * @returns Current storage tier
   * @throws {FsxNotFoundError} If file does not exist
   *
   * @example
   * ```typescript
   * const tier = await client.getTier('/data/file.json')
   * console.log(`File is in ${tier} tier`)
   * ```
   */
  async getTier(path: string): Promise<StorageTier> {
    const result = await this.request<{ tier: StorageTier }>('POST', '/getTier', { path })
    return result.tier
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Update authentication credentials.
   *
   * @param auth - New authentication options
   */
  setAuth(auth: FsxAuthOptions): void {
    if (auth.authorization) {
      this.authHeader = auth.authorization
    } else if (auth.jwt) {
      this.authHeader = `Bearer ${auth.jwt}`
    } else if (auth.apiKey) {
      this.authHeader = `Bearer ${auth.apiKey}`
    } else {
      this.authHeader = undefined
    }
  }

  /**
   * Update custom headers.
   *
   * @param headers - Headers to merge with existing headers
   */
  setHeaders(headers: Record<string, string>): void {
    this.headers = { ...this.headers, ...headers }
  }

  /**
   * Set the namespace for operations.
   *
   * @param namespace - Namespace identifier
   */
  setNamespace(namespace: string): void {
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
// Utility: Combine multiple AbortSignals
// =============================================================================

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

// =============================================================================
// Remote FS Client (FsCapability Interface)
// =============================================================================

export {
  RemoteFsClient,
  createRemoteFs,
  type RemoteFsClientOptions,
} from './remote-client.js'

// =============================================================================
// Default Export
// =============================================================================

export default FsxClient
