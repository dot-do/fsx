/**
 * FSx - Main filesystem class
 *
 * Provides POSIX-like filesystem operations backed by Durable Objects and R2.
 * This is the primary interface for interacting with the virtual filesystem.
 *
 * @example
 * ```typescript
 * const fsx = new FSx(env.FSX_DO)
 *
 * // Write and read files
 * await fsx.writeFile('/hello.txt', 'Hello, World!')
 * const content = await fsx.readFile('/hello.txt')
 *
 * // Directory operations
 * await fsx.mkdir('/mydir', { recursive: true })
 * const files = await fsx.readdir('/mydir')
 *
 * // Check file stats
 * const stats = await fsx.stat('/hello.txt')
 * console.log(stats.size, stats.isFile())
 * ```
 *
 * @module
 */

import type { Dirent, FileHandle, MkdirOptions, RmdirOptions, ReaddirOptions, ReadStreamOptions, WriteStreamOptions, WatchOptions, FSWatcher, BufferEncoding } from './types.js'
import { Stats } from './types.js'
import { constants } from './constants.js'
import { ENOENT, EEXIST, EISDIR, ENOTDIR, EINVAL, ENOTEMPTY } from './errors.js'

/** Error response from the Durable Object RPC */
interface ErrorResponse {
  readonly code: string
  readonly message: string
  readonly path?: string
}

/** File stats response from the Durable Object (pre-hydration) */
interface RawStats {
  readonly mode: number
  readonly size: number
  readonly uid: number
  readonly gid: number
  readonly rdev: number
  readonly nlink: number
  readonly ino: number
  readonly dev: number
  readonly atime: string | number
  readonly mtime: string | number
  readonly ctime: string | number
  readonly birthtime: string | number
  readonly atimeMs: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly birthtimeMs: number
  readonly blksize: number
  readonly blocks: number
}

/**
 * FSx configuration options
 *
 * @example
 * ```typescript
 * const fsx = new FSx(env.FSX_DO, {
 *   defaultMode: 0o644,
 *   defaultDirMode: 0o755,
 *   maxFileSize: 50 * 1024 * 1024, // 50MB
 * })
 * ```
 */
export interface FSxOptions {
  /**
   * Storage tier thresholds for automatic tiering
   *
   * Files are stored in different tiers based on size and access patterns:
   * - Hot tier: Stored directly in Durable Object SQLite (fast access)
   * - Warm tier: Stored in R2 (cheaper, slightly slower)
   * - Cold tier: Archived (cheapest, highest latency)
   */
  tiers?: {
    /** Max size for hot tier (DO SQLite). Default: 1MB */
    hotMaxSize?: number
    /** Enable warm tier (R2). Default: true */
    warmEnabled?: boolean
    /** Enable cold tier (archive). Default: false */
    coldEnabled?: boolean
  }
  /** Default file mode (permissions). Default: 0o644 */
  defaultMode?: number
  /** Default directory mode. Default: 0o755 */
  defaultDirMode?: number
  /** Temp file max age in ms. Default: 24 hours */
  tmpMaxAge?: number
  /** Max file size in bytes. Default: 100MB */
  maxFileSize?: number
  /** Max path length. Default: 4096 */
  maxPathLength?: number
  /** User ID for file ownership. Default: 0 */
  uid?: number
  /** Group ID for file ownership. Default: 0 */
  gid?: number
}

const DEFAULT_OPTIONS: Required<FSxOptions> = {
  tiers: {
    hotMaxSize: 1024 * 1024, // 1MB
    warmEnabled: true,
    coldEnabled: false,
  },
  defaultMode: 0o644,
  defaultDirMode: 0o755,
  tmpMaxAge: 24 * 60 * 60 * 1000, // 24 hours
  maxFileSize: 100 * 1024 * 1024, // 100MB
  maxPathLength: 4096,
  uid: 0,
  gid: 0,
}

/**
 * FSx - Virtual filesystem for Cloudflare Workers
 */
export class FSx {
  private stub: DurableObjectStub
  private options: Required<FSxOptions>

  constructor(binding: DurableObjectNamespace | DurableObjectStub, options: FSxOptions = {}) {
    if ('idFromName' in binding) {
      // It's a namespace, get the global stub
      const id = binding.idFromName('global')
      this.stub = binding.get(id)
    } else {
      this.stub = binding
    }
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  /**
   * Normalize a path
   */
  private normalizePath(path: string): string {
    // Remove trailing slashes (except root)
    if (path !== '/' && path.endsWith('/')) {
      path = path.slice(0, -1)
    }
    // Ensure starts with /
    if (!path.startsWith('/')) {
      path = '/' + path
    }
    // Resolve . and ..
    const parts = path.split('/').filter(Boolean)
    const resolved: string[] = []
    for (const part of parts) {
      if (part === '.') continue
      if (part === '..') {
        resolved.pop()
      } else {
        resolved.push(part)
      }
    }
    return '/' + resolved.join('/')
  }

  /**
   * Send an RPC request to the Durable Object
   *
   * @param method - The RPC method name to invoke
   * @param params - Parameters to pass to the method
   * @returns The parsed JSON response
   * @throws Typed filesystem error if the request fails
   */
  private async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const response = await this.stub.fetch('http://fsx.do/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })

    if (!response.ok) {
      throw await this.parseErrorResponse(response)
    }

    return response.json()
  }

  /**
   * Parse an error response from the Durable Object
   *
   * @param response - The failed HTTP response
   * @returns A typed filesystem error
   */
  private async parseErrorResponse(response: Response): Promise<Error> {
    const fallback: ErrorResponse = { code: 'UNKNOWN', message: response.statusText }
    const error = await response.json().catch(() => fallback) as ErrorResponse
    return this.createError(error)
  }

  /**
   * Decode base64 data to a Uint8Array
   *
   * @param base64 - Base64-encoded string
   * @returns Decoded bytes
   */
  private decodeBase64(base64: string): Uint8Array {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }

  /**
   * Encode a Uint8Array to base64
   *
   * @param bytes - Bytes to encode
   * @returns Base64-encoded string
   */
  private encodeBase64(bytes: Uint8Array): string {
    let binary = ''
    for (const byte of bytes) {
      binary += String.fromCharCode(byte)
    }
    return btoa(binary)
  }

  /**
   * Create a typed filesystem error from an RPC error response
   *
   * Maps standard POSIX error codes to their corresponding error classes.
   *
   * @param error - The error response from the Durable Object
   * @returns A typed error instance (ENOENT, EEXIST, etc.)
   */
  private createError(error: ErrorResponse): Error {
    const { code, message, path } = error
    const errorMap: Record<string, new (syscall?: string, path?: string) => Error> = {
      ENOENT,
      EEXIST,
      EISDIR,
      ENOTDIR,
      EINVAL,
      ENOTEMPTY,
    }

    const ErrorClass = errorMap[code]
    if (ErrorClass) {
      return new ErrorClass(undefined, path)
    }
    return new Error(message)
  }

  // ==================== File Operations ====================

  /**
   * Read a file's contents
   *
   * Reads the entire contents of a file. By default, returns a UTF-8 decoded string.
   * Use the encoding parameter to control the output format.
   *
   * @param path - Path to the file to read
   * @param encoding - Output encoding: 'utf-8'/'utf8' (default), 'base64', or undefined for raw bytes
   * @returns File contents as a string or Uint8Array depending on encoding
   * @throws {ENOENT} If the file does not exist
   * @throws {EISDIR} If the path is a directory
   *
   * @example
   * ```typescript
   * // Read as UTF-8 string (default)
   * const text = await fsx.readFile('/hello.txt')
   *
   * // Read as raw bytes
   * const bytes = await fsx.readFile('/image.png', undefined)
   *
   * // Read as base64
   * const base64 = await fsx.readFile('/image.png', 'base64')
   * ```
   */
  async readFile(path: string, encoding?: BufferEncoding): Promise<string | Uint8Array> {
    path = this.normalizePath(path)
    const result = await this.request<{ data: string; encoding: string }>('readFile', { path, encoding })

    // The backend always returns base64-encoded data
    const bytes = this.decodeBase64(result.data)

    // If utf-8 encoding requested (or default), decode bytes to string
    if (!encoding || encoding === 'utf-8' || encoding === 'utf8') {
      return new TextDecoder().decode(bytes)
    }

    // If base64 encoding requested, return the original base64 string
    if (encoding === 'base64') {
      return result.data
    }

    // For other encodings or no encoding, return bytes
    return bytes
  }

  /**
   * Write data to a file
   *
   * Writes data to a file, replacing the file if it already exists.
   * Creates any necessary parent directories.
   *
   * @param path - Path to the file to write
   * @param data - Content to write (string or bytes)
   * @param options - Write options
   * @param options.mode - File permissions (default: 0o644)
   * @param options.flag - File system flag: 'w' (write/create), 'a' (append), 'wx' (exclusive create)
   * @throws {EISDIR} If the path is a directory
   *
   * @example
   * ```typescript
   * // Write a string
   * await fsx.writeFile('/hello.txt', 'Hello, World!')
   *
   * // Write binary data
   * await fsx.writeFile('/data.bin', new Uint8Array([1, 2, 3]))
   *
   * // Write with specific permissions
   * await fsx.writeFile('/script.sh', '#!/bin/bash', { mode: 0o755 })
   * ```
   */
  async writeFile(path: string, data: string | Uint8Array, options?: { mode?: number; flag?: string }): Promise<void> {
    path = this.normalizePath(path)

    const isString = typeof data === 'string'
    const encodedData = isString ? data : this.encodeBase64(data)
    const encoding = isString ? 'utf-8' : 'base64'

    await this.request('writeFile', {
      path,
      data: encodedData,
      encoding,
      mode: options?.mode ?? this.options.defaultMode,
      flag: options?.flag,
    })
  }

  /**
   * Append data to a file
   *
   * Appends data to the end of a file. Creates the file if it doesn't exist.
   *
   * @param path - Path to the file
   * @param data - Content to append
   * @throws {EISDIR} If the path is a directory
   *
   * @example
   * ```typescript
   * await fsx.appendFile('/log.txt', 'New log entry\n')
   * ```
   */
  async appendFile(path: string, data: string | Uint8Array): Promise<void> {
    return this.writeFile(path, data, { flag: 'a' })
  }

  /**
   * Delete a file
   *
   * Removes a file from the filesystem. Does not work on directories.
   *
   * @param path - Path to the file to delete
   * @throws {ENOENT} If the file does not exist
   * @throws {EISDIR} If the path is a directory (use rmdir or rm instead)
   *
   * @example
   * ```typescript
   * await fsx.unlink('/old-file.txt')
   * ```
   */
  async unlink(path: string): Promise<void> {
    path = this.normalizePath(path)
    await this.request('unlink', { path })
  }

  /**
   * Rename or move a file or directory
   *
   * Atomically renames or moves a file/directory from oldPath to newPath.
   * Can be used to move files between directories.
   *
   * @param oldPath - Current path
   * @param newPath - New path
   * @throws {ENOENT} If oldPath does not exist
   * @throws {EEXIST} If newPath already exists (for some filesystem configurations)
   *
   * @example
   * ```typescript
   * // Rename a file
   * await fsx.rename('/old-name.txt', '/new-name.txt')
   *
   * // Move to another directory
   * await fsx.rename('/file.txt', '/archive/file.txt')
   * ```
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    oldPath = this.normalizePath(oldPath)
    newPath = this.normalizePath(newPath)
    await this.request('rename', { oldPath, newPath })
  }

  /**
   * Copy a file
   *
   * Creates a copy of a file at the destination path.
   *
   * @param src - Source file path
   * @param dest - Destination file path
   * @param flags - Copy flags (e.g., constants.COPYFILE_EXCL to fail if dest exists)
   * @throws {ENOENT} If the source file does not exist
   * @throws {EEXIST} If dest exists and COPYFILE_EXCL flag is set
   *
   * @example
   * ```typescript
   * // Simple copy
   * await fsx.copyFile('/original.txt', '/backup.txt')
   *
   * // Fail if destination exists
   * await fsx.copyFile('/src.txt', '/dst.txt', constants.COPYFILE_EXCL)
   * ```
   */
  async copyFile(src: string, dest: string, flags?: number): Promise<void> {
    src = this.normalizePath(src)
    dest = this.normalizePath(dest)
    await this.request('copyFile', { src, dest, flags })
  }

  // ==================== Directory Operations ====================

  /**
   * Create a directory
   *
   * Creates a new directory. With recursive option, creates parent directories
   * as needed (like `mkdir -p`).
   *
   * @param path - Path for the new directory
   * @param options - Creation options
   * @param options.recursive - Create parent directories if needed (default: false)
   * @param options.mode - Directory permissions (default: 0o755)
   * @throws {EEXIST} If directory already exists (unless recursive is true)
   * @throws {ENOENT} If parent doesn't exist and recursive is false
   *
   * @example
   * ```typescript
   * // Create a single directory
   * await fsx.mkdir('/mydir')
   *
   * // Create nested directories
   * await fsx.mkdir('/a/b/c', { recursive: true })
   * ```
   */
  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    path = this.normalizePath(path)
    await this.request('mkdir', {
      path,
      recursive: options?.recursive ?? false,
      mode: options?.mode ?? this.options.defaultDirMode,
    })
  }

  /**
   * Remove a directory
   *
   * Removes an empty directory. With recursive option, removes directory
   * and all contents (like `rm -r`).
   *
   * @param path - Path to the directory
   * @param options - Removal options
   * @param options.recursive - Remove contents recursively (default: false)
   * @throws {ENOENT} If directory does not exist
   * @throws {ENOTDIR} If path is not a directory
   * @throws {ENOTEMPTY} If directory is not empty and recursive is false
   *
   * @example
   * ```typescript
   * // Remove empty directory
   * await fsx.rmdir('/empty-dir')
   *
   * // Remove directory and all contents
   * await fsx.rmdir('/full-dir', { recursive: true })
   * ```
   */
  async rmdir(path: string, options?: RmdirOptions): Promise<void> {
    path = this.normalizePath(path)
    await this.request('rmdir', {
      path,
      recursive: options?.recursive ?? false,
    })
  }

  /**
   * Remove a file or directory
   *
   * Removes files or directories. With recursive option, removes directories
   * and their contents. With force option, ignores non-existent paths.
   *
   * @param path - Path to remove
   * @param options - Removal options
   * @param options.recursive - Remove directories and contents (default: false)
   * @param options.force - Ignore if path doesn't exist (default: false)
   * @throws {ENOENT} If path doesn't exist and force is false
   * @throws {EISDIR} If path is a directory and recursive is false
   *
   * @example
   * ```typescript
   * // Remove a file
   * await fsx.rm('/file.txt')
   *
   * // Remove directory tree (like rm -rf)
   * await fsx.rm('/directory', { recursive: true, force: true })
   * ```
   */
  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    path = this.normalizePath(path)
    await this.request('rm', {
      path,
      recursive: options?.recursive ?? false,
      force: options?.force ?? false,
    })
  }

  /**
   * Read directory contents
   *
   * Returns the contents of a directory. With withFileTypes option, returns
   * Dirent objects with type information. With recursive option, includes
   * contents of subdirectories.
   *
   * @param path - Path to the directory
   * @param options - Read options
   * @param options.withFileTypes - Return Dirent objects instead of strings (default: false)
   * @param options.recursive - Include subdirectory contents (default: false)
   * @returns Array of filenames or Dirent objects
   * @throws {ENOENT} If directory does not exist
   * @throws {ENOTDIR} If path is not a directory
   *
   * @example
   * ```typescript
   * // List filenames
   * const files = await fsx.readdir('/mydir')
   * // ['file1.txt', 'file2.txt', 'subdir']
   *
   * // List with file types
   * const entries = await fsx.readdir('/mydir', { withFileTypes: true })
   * entries.forEach(e => console.log(e.name, e.isDirectory()))
   * ```
   */
  async readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]> {
    path = this.normalizePath(path)
    return this.request('readdir', {
      path,
      withFileTypes: options?.withFileTypes ?? false,
      recursive: options?.recursive ?? false,
    })
  }

  // ==================== Metadata Operations ====================

  /**
   * Get file or directory stats
   *
   * Returns metadata about a file or directory including size, permissions,
   * timestamps, and type-checking methods. Follows symbolic links.
   *
   * @param path - Path to the file or directory
   * @returns Stats object with file metadata and type-checking methods
   * @throws {ENOENT} If the path does not exist
   *
   * @example
   * ```typescript
   * const stats = await fsx.stat('/myfile.txt')
   * console.log(stats.size)        // File size in bytes
   * console.log(stats.isFile())    // true
   * console.log(stats.mtime)       // Last modification time
   * ```
   */
  async stat(path: string): Promise<Stats> {
    path = this.normalizePath(path)
    const stats = await this.request<RawStats>('stat', { path })
    return this.hydrateStats(stats)
  }

  /**
   * Get file or directory stats without following symbolic links
   *
   * Like {@link stat}, but does not follow symbolic links. If the path is
   * a symlink, returns information about the link itself rather than its target.
   *
   * @param path - Path to the file, directory, or symbolic link
   * @returns Stats object with file metadata and type-checking methods
   * @throws {ENOENT} If the path does not exist
   *
   * @example
   * ```typescript
   * // Check if something is a symlink
   * const stats = await fsx.lstat('/link')
   * if (stats.isSymbolicLink()) {
   *   const target = await fsx.readlink('/link')
   * }
   * ```
   */
  async lstat(path: string): Promise<Stats> {
    path = this.normalizePath(path)
    const stats = await this.request<RawStats>('lstat', { path })
    return this.hydrateStats(stats)
  }

  /**
   * Hydrate a raw stats object into a Stats class instance
   *
   * Converts raw stats response from the Durable Object into a full Stats
   * instance with Date getters and POSIX type-checking methods.
   *
   * @param raw - Raw stats object from the Durable Object
   * @returns Fully hydrated Stats instance
   */
  private hydrateStats(raw: RawStats): Stats {
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
   * Check file access permissions
   *
   * Tests whether the calling process can access the file at path.
   * Throws an error if access is not permitted.
   *
   * @param path - Path to check
   * @param mode - Access mode to check (default: F_OK for existence)
   *              - constants.F_OK: Check existence
   *              - constants.R_OK: Check read permission
   *              - constants.W_OK: Check write permission
   *              - constants.X_OK: Check execute permission
   * @throws {ENOENT} If the path does not exist
   * @throws {EACCES} If access is not permitted
   *
   * @example
   * ```typescript
   * // Check if file exists
   * await fsx.access('/myfile.txt')
   *
   * // Check if file is readable and writable
   * await fsx.access('/myfile.txt', constants.R_OK | constants.W_OK)
   * ```
   */
  async access(path: string, mode?: number): Promise<void> {
    path = this.normalizePath(path)
    await this.request('access', { path, mode: mode ?? constants.F_OK })
  }

  /**
   * Check if a path exists
   *
   * A convenience method that returns a boolean instead of throwing.
   * Prefer {@link access} when you need to check specific permissions.
   *
   * @param path - Path to check
   * @returns true if the path exists, false otherwise
   *
   * @example
   * ```typescript
   * if (await fsx.exists('/config.json')) {
   *   const config = await fsx.readFile('/config.json')
   * }
   * ```
   */
  async exists(path: string): Promise<boolean> {
    try {
      await this.access(path)
      return true
    } catch {
      return false
    }
  }

  /**
   * Change file permissions
   *
   * Changes the permissions of a file or directory.
   *
   * @param path - Path to the file or directory
   * @param mode - New permissions (octal, e.g., 0o755)
   * @throws {ENOENT} If the path does not exist
   *
   * @example
   * ```typescript
   * // Make a script executable
   * await fsx.chmod('/script.sh', 0o755)
   *
   * // Read-only for owner only
   * await fsx.chmod('/secret.txt', 0o400)
   * ```
   */
  async chmod(path: string, mode: number): Promise<void> {
    path = this.normalizePath(path)
    await this.request('chmod', { path, mode })
  }

  /**
   * Change file ownership
   *
   * Changes the owner and group of a file or directory.
   *
   * @param path - Path to the file or directory
   * @param uid - User ID of the new owner
   * @param gid - Group ID of the new group
   * @throws {ENOENT} If the path does not exist
   *
   * @example
   * ```typescript
   * await fsx.chown('/myfile.txt', 1000, 1000)
   * ```
   */
  async chown(path: string, uid: number, gid: number): Promise<void> {
    path = this.normalizePath(path)
    await this.request('chown', { path, uid, gid })
  }

  /**
   * Update file access and modification timestamps
   *
   * Sets the access time (atime) and modification time (mtime) of a file.
   *
   * @param path - Path to the file
   * @param atime - New access time (Date or Unix timestamp in ms)
   * @param mtime - New modification time (Date or Unix timestamp in ms)
   * @throws {ENOENT} If the file does not exist
   *
   * @example
   * ```typescript
   * // Set timestamps to current time
   * const now = new Date()
   * await fsx.utimes('/myfile.txt', now, now)
   *
   * // Set to specific Unix timestamp
   * await fsx.utimes('/myfile.txt', 1704067200000, 1704067200000)
   * ```
   */
  async utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void> {
    path = this.normalizePath(path)
    await this.request('utimes', {
      path,
      atime: atime instanceof Date ? atime.getTime() : atime,
      mtime: mtime instanceof Date ? mtime.getTime() : mtime,
    })
  }

  // ==================== Symbolic Links ====================

  /**
   * Create a symbolic link
   *
   * Creates a symbolic link at path pointing to target.
   * The target can be a relative or absolute path.
   *
   * @param target - The path the symlink should point to
   * @param path - Where to create the symlink
   * @throws {EEXIST} If a file already exists at path
   *
   * @example
   * ```typescript
   * // Create symlink to a file
   * await fsx.symlink('/data/config.json', '/config.json')
   *
   * // Create symlink with relative target
   * await fsx.symlink('../shared/lib', '/app/lib')
   * ```
   */
  async symlink(target: string, path: string): Promise<void> {
    path = this.normalizePath(path)
    await this.request('symlink', { target, path })
  }

  /**
   * Create a hard link
   *
   * Creates a new directory entry (hard link) at newPath that references
   * the same file as existingPath. Both paths will point to the same
   * underlying file content.
   *
   * @param existingPath - Path to the existing file
   * @param newPath - Path for the new hard link
   * @throws {ENOENT} If existingPath does not exist
   * @throws {EEXIST} If newPath already exists
   *
   * @example
   * ```typescript
   * await fsx.link('/original.txt', '/hardlink.txt')
   * // Both paths now reference the same file
   * ```
   */
  async link(existingPath: string, newPath: string): Promise<void> {
    existingPath = this.normalizePath(existingPath)
    newPath = this.normalizePath(newPath)
    await this.request('link', { existingPath, newPath })
  }

  /**
   * Read the target of a symbolic link
   *
   * Returns the path that a symbolic link points to.
   *
   * @param path - Path to the symbolic link
   * @returns The target path (may be relative or absolute)
   * @throws {ENOENT} If the path does not exist
   * @throws {EINVAL} If the path is not a symbolic link
   *
   * @example
   * ```typescript
   * // Get symlink target
   * const target = await fsx.readlink('/mylink')
   * console.log(target) // '/actual/file/path'
   * ```
   */
  async readlink(path: string): Promise<string> {
    path = this.normalizePath(path)
    return this.request('readlink', { path })
  }

  /**
   * Resolve the absolute path, following symbolic links
   *
   * Returns the canonical absolute pathname by resolving `.`, `..`,
   * and symbolic links.
   *
   * @param path - Path to resolve
   * @returns The resolved absolute path
   * @throws {ENOENT} If the path does not exist
   *
   * @example
   * ```typescript
   * // Resolve symlinks and relative components
   * const real = await fsx.realpath('/app/../data/./link')
   * console.log(real) // '/data/actual-file'
   * ```
   */
  async realpath(path: string): Promise<string> {
    path = this.normalizePath(path)
    return this.request('realpath', { path })
  }

  // ==================== Streams ====================

  /**
   * Create a readable stream for a file
   *
   * Returns a ReadableStream that can be used to read file contents
   * in chunks. Useful for large files or when streaming to responses.
   *
   * @param path - Path to the file to read
   * @param options - Stream options (start, end positions, highWaterMark)
   * @returns A ReadableStream of Uint8Array chunks
   * @throws {ENOENT} If the file does not exist
   * @throws {EISDIR} If the path is a directory
   *
   * @example
   * ```typescript
   * const stream = await fsx.createReadStream('/large-file.bin')
   * for await (const chunk of stream) {
   *   process.write(chunk)
   * }
   * ```
   */
  async createReadStream(path: string, options?: ReadStreamOptions): Promise<ReadableStream<Uint8Array>> {
    path = this.normalizePath(path)

    const response = await this.stub.fetch('http://fsx.do/stream/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, ...options }),
    })

    if (!response.ok || !response.body) {
      throw await this.parseErrorResponse(response)
    }

    return response.body
  }

  /**
   * Create a writable stream for a file
   *
   * Returns a WritableStream that can be used to write file contents
   * in chunks. The file is created if it doesn't exist.
   *
   * @param path - Path to the file to write
   * @param options - Stream options (flags, mode, start position)
   * @returns A WritableStream accepting Uint8Array chunks
   *
   * @example
   * ```typescript
   * const stream = await fsx.createWriteStream('/output.bin')
   * const writer = stream.getWriter()
   * await writer.write(new Uint8Array([1, 2, 3]))
   * await writer.close()
   * ```
   */
  async createWriteStream(path: string, options?: WriteStreamOptions): Promise<WritableStream<Uint8Array>> {
    path = this.normalizePath(path)

    // Create a TransformStream to pipe data to the DO
    const { readable, writable } = new TransformStream<Uint8Array>()

    // Start the upload in the background
    this.stub
      .fetch('http://fsx.do/stream/write', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-FSx-Path': path,
          'X-FSx-Options': JSON.stringify(options ?? {}),
        },
        body: readable,
      })
      .then(async (response) => {
        if (!response.ok) {
          throw await this.parseErrorResponse(response)
        }
      })

    return writable
  }

  // ==================== File Watching ====================

  /**
   * Watch a file or directory for changes
   *
   * Returns an FSWatcher that emits events when the file or directory changes.
   *
   * **Note:** This is currently a stub implementation. Full file watching
   * support using WebSocket or Server-Sent Events is planned for a future release.
   *
   * @param path - Path to watch
   * @param options - Watch options (persistent, recursive, encoding)
   * @param listener - Callback for change events (eventType: 'change'|'rename', filename)
   * @returns An FSWatcher object with close(), ref(), and unref() methods
   *
   * @example
   * ```typescript
   * const watcher = fsx.watch('/mydir', {}, (event, filename) => {
   *   console.log(`${event}: ${filename}`)
   * })
   *
   * // Later, stop watching
   * watcher.close()
   * ```
   */
  watch(path: string, options?: WatchOptions, listener?: (eventType: string, filename: string) => void): FSWatcher {
    path = this.normalizePath(path)

    // Stub implementation - full support requires WebSocket/SSE
    const watcher: FSWatcher = {
      close: () => {
        // Close the watcher (no-op in stub)
      },
      ref: () => watcher,
      unref: () => watcher,
    }

    return watcher
  }

  // ==================== Utility ====================

  /**
   * Truncate a file to a specified length
   *
   * If the file is larger than the specified length, the extra data is discarded.
   * If smaller, the file is extended with null bytes.
   *
   * @param path - Path to the file
   * @param length - New file length in bytes (default: 0)
   * @throws {ENOENT} If the file does not exist
   * @throws {EISDIR} If the path is a directory
   *
   * @example
   * ```typescript
   * // Clear a file
   * await fsx.truncate('/myfile.txt')
   *
   * // Truncate to first 100 bytes
   * await fsx.truncate('/myfile.txt', 100)
   * ```
   */
  async truncate(path: string, length?: number): Promise<void> {
    path = this.normalizePath(path)
    await this.request('truncate', { path, length: length ?? 0 })
  }

  /**
   * Open a file and get a file handle for low-level operations
   *
   * Returns a FileHandle that provides fine-grained control over file I/O,
   * including positioned reads/writes and file synchronization.
   *
   * @param path - Path to the file
   * @param flags - Open mode: 'r' (read), 'w' (write), 'a' (append), etc.
   * @param mode - File permissions for newly created files (default: 0o644)
   * @returns A FileHandle for low-level file operations
   * @throws {ENOENT} If file doesn't exist and flags don't include create
   *
   * @example
   * ```typescript
   * const handle = await fsx.open('/data.bin', 'r+')
   * try {
   *   const buffer = new Uint8Array(1024)
   *   const { bytesRead } = await handle.read(buffer, 0, 1024, 0)
   *   await handle.write(new Uint8Array([1, 2, 3]), 0)
   *   await handle.sync()
   * } finally {
   *   await handle.close()
   * }
   * ```
   */
  async open(path: string, flags?: string | number, mode?: number): Promise<FileHandle> {
    path = this.normalizePath(path)
    const fd = await this.request<number>('open', { path, flags, mode })
    return this.createFileHandle(fd)
  }

  /**
   * Create a FileHandle object for low-level file operations
   *
   * @param fd - The file descriptor from the open call
   * @returns A FileHandle with read, write, stat, sync, and close methods
   */
  private createFileHandle(fd: number): FileHandle {
    return {
      fd,

      read: async (buffer: Uint8Array, offset: number | undefined, length: number | undefined, position: number | undefined) => {
        const result = await this.request<{ bytesRead: number; data: string }>('read', {
          fd,
          length: length ?? buffer.length,
          position,
        })
        const decoded = this.decodeBase64(result.data)
        const targetOffset = offset ?? 0
        for (let i = 0; i < result.bytesRead; i++) {
          buffer[targetOffset + i] = decoded[i]
        }
        return { bytesRead: result.bytesRead, buffer }
      },

      write: async (data: Uint8Array | string, position?: number) => {
        const encoded = typeof data === 'string' ? btoa(data) : this.encodeBase64(data)
        return this.request<{ bytesWritten: number }>('write', { fd, data: encoded, position })
      },

      stat: () => this.request<RawStats>('fstat', { fd }).then((stats) => this.hydrateStats(stats)),

      truncate: (length?: number) => this.request('ftruncate', { fd, length }),

      sync: () => this.request('fsync', { fd }),

      close: () => this.request('close', { fd }),

      createReadStream: (_options?: ReadStreamOptions) => {
        throw new Error('FileHandle.createReadStream is not implemented')
      },

      createWriteStream: (_options?: WriteStreamOptions) => {
        throw new Error('FileHandle.createWriteStream is not implemented')
      },
    } as unknown as FileHandle
  }
}
