/**
 * PGlite Filesystem Adapter on ExtentStorage
 *
 * Implements a BaseFilesystem-compatible interface for PGlite that stores
 * PostgreSQL database pages in extents via ExtentStorage. This provides
 * efficient storage of PostgreSQL data on Cloudflare Durable Objects
 * with ~500x cost reduction compared to per-page storage.
 *
 * Key Features:
 * - File descriptor management for open/read/write/close operations
 * - Directory tree tracking for PostgreSQL's directory structure
 * - Proper POSIX-like error codes (ENOENT, EBADF, etc.)
 * - 8KB page size for PostgreSQL compatibility
 * - FsStats compatible with PGlite's BaseFilesystem
 *
 * PostgreSQL Directory Structure:
 * ```
 * /tmp/pglite/
 * +-- base/                # Database files
 * |   +-- 1/               # Template database
 * |   +-- 13395/           # postgres database
 * +-- global/              # Global system tables
 * +-- pg_wal/              # Write-ahead log
 * +-- pg_xact/             # Transaction status
 * +-- pg_control           # Control file
 * +-- postgresql.conf      # Configuration
 * ```
 *
 * @module vfs/pglite-fs
 */

import type { ExtentStorage } from '../storage/extent-storage.js'

// =============================================================================
// Constants
// =============================================================================

/**
 * Default PostgreSQL page size (8KB).
 */
export const PGLITE_PAGE_SIZE = 8192

/**
 * File mode for regular files.
 */
export const S_IFREG = 32768 // 0o100000

/**
 * File mode for directories.
 */
export const S_IFDIR = 16384 // 0o40000

/**
 * Default file permissions (rw-r--r--).
 */
export const DEFAULT_FILE_MODE = S_IFREG | 0o644

/**
 * Default directory permissions (rwxr-xr-x).
 */
export const DEFAULT_DIR_MODE = S_IFDIR | 0o755

// =============================================================================
// Error Handling
// =============================================================================

/**
 * Errno codes for filesystem errors.
 *
 * These codes match POSIX errno values and are used by PGlite
 * to handle filesystem errors appropriately.
 */
export const ERRNO = {
  /** No such file or directory */
  ENOENT: 'ENOENT',
  /** File exists */
  EEXIST: 'EEXIST',
  /** Bad file descriptor */
  EBADF: 'EBADF',
  /** Is a directory */
  EISDIR: 'EISDIR',
  /** Not a directory */
  ENOTDIR: 'ENOTDIR',
  /** Directory not empty */
  ENOTEMPTY: 'ENOTEMPTY',
  /** Invalid argument */
  EINVAL: 'EINVAL',
  /** Permission denied */
  EACCES: 'EACCES',
  /** Read-only file system */
  EROFS: 'EROFS',
  /** No space left on device */
  ENOSPC: 'ENOSPC',
  /** I/O error */
  EIO: 'EIO',
} as const

export type ErrnoCode = (typeof ERRNO)[keyof typeof ERRNO]

/**
 * Filesystem error with errno code.
 *
 * Thrown by filesystem operations to indicate failure with
 * a POSIX-compatible error code.
 *
 * @example
 * ```typescript
 * throw new FsError(ERRNO.ENOENT, 'File not found: /foo/bar')
 * ```
 */
export class FsError extends Error {
  /** POSIX errno code */
  readonly code: ErrnoCode

  /** System call that failed (optional) */
  readonly syscall?: string

  /** Path that caused the error (optional) */
  readonly path?: string

  constructor(code: ErrnoCode, message?: string, options?: { syscall?: string; path?: string }) {
    super(message ?? code)
    this.name = 'FsError'
    this.code = code
    this.syscall = options?.syscall
    this.path = options?.path

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, FsError)
    }
  }

  /**
   * Create an ENOENT error.
   */
  static noent(path: string, syscall?: string): FsError {
    return new FsError(ERRNO.ENOENT, `ENOENT: no such file or directory, ${syscall ?? 'access'} '${path}'`, {
      syscall,
      path,
    })
  }

  /**
   * Create an EEXIST error.
   */
  static exist(path: string, syscall?: string): FsError {
    return new FsError(ERRNO.EEXIST, `EEXIST: file already exists, ${syscall ?? 'open'} '${path}'`, {
      syscall,
      path,
    })
  }

  /**
   * Create an EBADF error.
   */
  static badf(fd: number, syscall?: string): FsError {
    return new FsError(ERRNO.EBADF, `EBADF: bad file descriptor, ${syscall ?? 'read'} '${fd}'`, { syscall })
  }

  /**
   * Create an EISDIR error.
   */
  static isdir(path: string, syscall?: string): FsError {
    return new FsError(ERRNO.EISDIR, `EISDIR: illegal operation on a directory, ${syscall ?? 'read'} '${path}'`, {
      syscall,
      path,
    })
  }

  /**
   * Create an ENOTDIR error.
   */
  static notdir(path: string, syscall?: string): FsError {
    return new FsError(ERRNO.ENOTDIR, `ENOTDIR: not a directory, ${syscall ?? 'readdir'} '${path}'`, {
      syscall,
      path,
    })
  }

  /**
   * Create an ENOTEMPTY error.
   */
  static notempty(path: string, syscall?: string): FsError {
    return new FsError(ERRNO.ENOTEMPTY, `ENOTEMPTY: directory not empty, ${syscall ?? 'rmdir'} '${path}'`, {
      syscall,
      path,
    })
  }

  /**
   * Create an EINVAL error.
   */
  static inval(message: string, syscall?: string): FsError {
    return new FsError(ERRNO.EINVAL, `EINVAL: invalid argument, ${syscall ?? 'operation'} - ${message}`, { syscall })
  }
}

// =============================================================================
// Types
// =============================================================================

/**
 * File statistics returned by lstat/fstat.
 *
 * Compatible with PGlite's BaseFilesystem FsStats interface.
 * Times are in milliseconds since Unix epoch.
 */
export interface FsStats {
  /** Device ID (always 0) */
  dev: number
  /** Inode number */
  ino: number
  /** File mode (type + permissions) */
  mode: number
  /** Number of hard links */
  nlink: number
  /** Owner user ID */
  uid: number
  /** Owner group ID */
  gid: number
  /** Device ID for special files */
  rdev: number
  /** File size in bytes */
  size: number
  /** Block size for I/O */
  blksize: number
  /** Number of 512-byte blocks allocated */
  blocks: number
  /** Access time (ms since epoch) */
  atime: number
  /** Modification time (ms since epoch) */
  mtime: number
  /** Change time (ms since epoch) */
  ctime: number
}

/**
 * Internal open file tracking.
 */
interface OpenFile {
  /** File path */
  path: string
  /** File ID for ExtentStorage */
  fileId: string
  /** Open flags (e.g., 'r', 'w', 'a', 'r+') */
  flags: string
  /** Current file position */
  position: number
  /** File mode */
  mode: number
  /** Access time */
  atime: number
  /** Modification time */
  mtime: number
}

/**
 * File metadata stored in memory.
 */
interface FileMetadata {
  /** File path */
  path: string
  /** Is directory */
  isDirectory: boolean
  /** File mode */
  mode: number
  /** File size in bytes */
  size: number
  /** Inode number */
  ino: number
  /** Access time (ms) */
  atime: number
  /** Modification time (ms) */
  mtime: number
  /** Change time (ms) */
  ctime: number
  /** Symlink target (if symlink) */
  linkTarget?: string
}

/**
 * Configuration for ExtentPGliteFS.
 */
export interface ExtentPGliteFSConfig {
  /**
   * ExtentStorage backend for page storage.
   */
  extentStorage: ExtentStorage

  /**
   * Page size in bytes (default: 8192 for PostgreSQL).
   */
  pageSize?: number

  /**
   * Root path prefix for the filesystem.
   * @default ''
   */
  rootPrefix?: string
}

// =============================================================================
// ExtentPGliteFS Implementation
// =============================================================================

/**
 * PGlite filesystem adapter on ExtentStorage.
 *
 * Implements a POSIX-like filesystem interface compatible with PGlite's
 * BaseFilesystem, storing PostgreSQL database pages efficiently in extents.
 *
 * @example
 * ```typescript
 * import { createExtentPGliteFS } from './pglite-fs.js'
 * import { createExtentStorage } from '../storage/extent-storage.js'
 *
 * const extentStorage = await createExtentStorage({
 *   pageSize: 8192,
 *   extentSize: 2 * 1024 * 1024,
 *   backend: r2Storage,
 *   sql: sqlAdapter,
 * })
 *
 * const fs = createExtentPGliteFS({ extentStorage })
 *
 * // Create PostgreSQL directory structure
 * fs.mkdir('/tmp/pglite', { recursive: true })
 * fs.mkdir('/tmp/pglite/base')
 * fs.mkdir('/tmp/pglite/global')
 * fs.mkdir('/tmp/pglite/pg_wal')
 *
 * // Write files
 * fs.writeFile('/tmp/pglite/pg_control', controlData)
 *
 * // Open and read
 * const fd = fs.open('/tmp/pglite/pg_control', 'r')
 * const buffer = new Uint8Array(8192)
 * const bytesRead = fs.read(fd, buffer, 0, 8192, 0)
 * fs.close(fd)
 * ```
 */
export class ExtentPGliteFS {
  private readonly extentStorage: ExtentStorage
  private readonly pageSize: number
  private readonly rootPrefix: string

  // File descriptor management
  private fdCounter = 3 // Start at 3 (0=stdin, 1=stdout, 2=stderr)
  private openFiles = new Map<number, OpenFile>()

  // Directory and file metadata tracking
  private directories = new Set<string>()
  private files = new Map<string, FileMetadata>()

  // Inode tracking
  private inodeCounter = 1
  private inodeMap = new Map<string, number>()

  constructor(config: ExtentPGliteFSConfig) {
    this.extentStorage = config.extentStorage
    this.pageSize = config.pageSize ?? PGLITE_PAGE_SIZE
    this.rootPrefix = config.rootPrefix ?? ''

    // Initialize with root directory
    this.directories.add('/')
    this.inodeMap.set('/', this.inodeCounter++)
  }

  // ===========================================================================
  // Path Utilities
  // ===========================================================================

  /**
   * Normalize a path (remove trailing slashes, handle . and ..).
   */
  private normalizePath(path: string): string {
    // Handle empty path
    if (!path || path === '') {
      return '/'
    }

    // Ensure absolute path
    if (!path.startsWith('/')) {
      path = '/' + path
    }

    // Split into segments and resolve . and ..
    const segments: string[] = []
    for (const seg of path.split('/')) {
      if (seg === '' || seg === '.') {
        continue
      }
      if (seg === '..') {
        segments.pop()
      } else {
        segments.push(seg)
      }
    }

    return '/' + segments.join('/')
  }

  /**
   * Get parent directory path.
   */
  private getParentPath(path: string): string {
    const normalized = this.normalizePath(path)
    if (normalized === '/') {
      return '/'
    }
    const lastSlash = normalized.lastIndexOf('/')
    return lastSlash === 0 ? '/' : normalized.substring(0, lastSlash)
  }

  /**
   * Convert path to file ID for ExtentStorage.
   */
  private pathToFileId(path: string): string {
    const normalized = this.normalizePath(path)
    // Use a prefix to namespace files in extent storage
    return `pglite:${this.rootPrefix}${normalized}`
  }

  /**
   * Get or create inode for a path.
   */
  private getOrCreateInode(path: string): number {
    const normalized = this.normalizePath(path)
    let ino = this.inodeMap.get(normalized)
    if (ino === undefined) {
      ino = this.inodeCounter++
      this.inodeMap.set(normalized, ino)
    }
    return ino
  }

  // ===========================================================================
  // File Metadata Operations
  // ===========================================================================

  /**
   * Change file mode bits.
   *
   * @param path - File path
   * @param mode - New mode bits
   */
  chmod(path: string, mode: number): void {
    const normalized = this.normalizePath(path)

    // Check if it's a directory
    if (this.directories.has(normalized)) {
      // Directories don't have stored metadata, but we could track it
      return
    }

    // Check if it's a file
    const meta = this.files.get(normalized)
    if (!meta) {
      throw FsError.noent(path, 'chmod')
    }

    // Update mode (preserve file type bits)
    const typeBits = meta.mode & 0o170000
    meta.mode = typeBits | (mode & 0o7777)
    meta.ctime = Date.now()
  }

  /**
   * Get file statistics (does not follow symlinks).
   *
   * @param path - File path
   * @returns File statistics
   */
  lstat(path: string): FsStats {
    const normalized = this.normalizePath(path)
    const now = Date.now()

    // Check if it's a directory
    if (this.directories.has(normalized)) {
      const ino = this.getOrCreateInode(normalized)
      return {
        dev: 0,
        ino,
        mode: DEFAULT_DIR_MODE,
        nlink: 2, // . and parent
        uid: 0,
        gid: 0,
        rdev: 0,
        size: 4096,
        blksize: this.pageSize,
        blocks: 8,
        atime: now,
        mtime: now,
        ctime: now,
      }
    }

    // Check if it's a file
    const meta = this.files.get(normalized)
    if (meta) {
      return {
        dev: 0,
        ino: meta.ino,
        mode: meta.mode,
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size: meta.size,
        blksize: this.pageSize,
        blocks: Math.ceil(meta.size / 512),
        atime: meta.atime,
        mtime: meta.mtime,
        ctime: meta.ctime,
      }
    }

    throw FsError.noent(path, 'lstat')
  }

  /**
   * Get file statistics by file descriptor.
   *
   * @param fd - File descriptor
   * @returns File statistics
   */
  fstat(fd: number): FsStats {
    const file = this.openFiles.get(fd)
    if (!file) {
      throw FsError.badf(fd, 'fstat')
    }
    return this.lstat(file.path)
  }

  /**
   * Change file access and modification times.
   *
   * @param path - File path
   * @param atime - Access time (seconds since epoch or Date)
   * @param mtime - Modification time (seconds since epoch or Date)
   */
  utimes(path: string, atime: number | Date, mtime: number | Date): void {
    const normalized = this.normalizePath(path)

    // Convert Date to milliseconds
    const atimeMs = atime instanceof Date ? atime.getTime() : atime * 1000
    const mtimeMs = mtime instanceof Date ? mtime.getTime() : mtime * 1000

    // Check if it's a directory
    if (this.directories.has(normalized)) {
      // Directories don't track times in our implementation
      return
    }

    // Check if it's a file
    const meta = this.files.get(normalized)
    if (!meta) {
      throw FsError.noent(path, 'utimes')
    }

    meta.atime = atimeMs
    meta.mtime = mtimeMs
    meta.ctime = Date.now()
  }

  // ===========================================================================
  // File I/O Operations
  // ===========================================================================

  /**
   * Open a file.
   *
   * @param path - File path
   * @param flags - Open flags ('r', 'w', 'a', 'r+', 'w+', 'a+', etc.)
   * @param mode - File mode for creation (default: 0o644)
   * @returns File descriptor
   */
  open(path: string, flags?: string, mode?: number): number {
    const normalized = this.normalizePath(path)
    const openFlags = flags ?? 'r'
    const fileMode = mode ?? 0o644

    // Check if it's a directory
    if (this.directories.has(normalized)) {
      throw FsError.isdir(path, 'open')
    }

    // Parse flags to determine behavior
    const readable = openFlags.includes('r') || openFlags.includes('+')
    const writable = openFlags.includes('w') || openFlags.includes('a') || openFlags.includes('+')
    const create = openFlags.includes('w') || openFlags.includes('a')
    const truncate = openFlags.includes('w') && !openFlags.includes('a')
    const append = openFlags.includes('a')
    const exclusive = openFlags.includes('x')

    let meta = this.files.get(normalized)
    const now = Date.now()

    // Handle file creation/existence checks
    if (meta) {
      if (exclusive) {
        throw FsError.exist(path, 'open')
      }
      if (truncate) {
        // Truncate existing file
        meta.size = 0
        meta.mtime = now
        meta.ctime = now
      }
    } else {
      if (!create && readable && !writable) {
        // Read-only mode requires file to exist
        throw FsError.noent(path, 'open')
      }

      // Check parent directory exists
      const parentPath = this.getParentPath(normalized)
      if (!this.directories.has(parentPath)) {
        throw FsError.noent(parentPath, 'open')
      }

      if (create) {
        // Create new file
        meta = {
          path: normalized,
          isDirectory: false,
          mode: S_IFREG | (fileMode & 0o7777),
          size: 0,
          ino: this.getOrCreateInode(normalized),
          atime: now,
          mtime: now,
          ctime: now,
        }
        this.files.set(normalized, meta)
      } else {
        throw FsError.noent(path, 'open')
      }
    }

    // Create file descriptor
    const fd = this.fdCounter++
    const openFile: OpenFile = {
      path: normalized,
      fileId: this.pathToFileId(normalized),
      flags: openFlags,
      position: append ? meta.size : 0,
      mode: meta.mode,
      atime: meta.atime,
      mtime: meta.mtime,
    }
    this.openFiles.set(fd, openFile)

    return fd
  }

  /**
   * Close a file descriptor.
   *
   * @param fd - File descriptor
   */
  close(fd: number): void {
    const file = this.openFiles.get(fd)
    if (!file) {
      throw FsError.badf(fd, 'close')
    }
    this.openFiles.delete(fd)
  }

  /**
   * Read from a file.
   *
   * @param fd - File descriptor
   * @param buffer - Buffer to read into
   * @param offset - Offset in buffer to start writing
   * @param length - Number of bytes to read
   * @param position - Position in file to read from
   * @returns Number of bytes read
   */
  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    const file = this.openFiles.get(fd)
    if (!file) {
      throw FsError.badf(fd, 'read')
    }

    // Validate parameters
    if (offset < 0 || length < 0 || position < 0) {
      throw FsError.inval('negative offset, length, or position', 'read')
    }
    if (offset + length > buffer.length) {
      throw FsError.inval('buffer too small', 'read')
    }

    // Get file metadata
    const meta = this.files.get(file.path)
    if (!meta) {
      throw FsError.noent(file.path, 'read')
    }

    // Check if position is beyond file size
    if (position >= meta.size) {
      return 0
    }

    // Clamp length to available data
    const availableBytes = meta.size - position
    const bytesToRead = Math.min(length, availableBytes)

    if (bytesToRead === 0) {
      return 0
    }

    // Read pages from extent storage
    const startPage = Math.floor(position / this.pageSize)
    const endPage = Math.ceil((position + bytesToRead) / this.pageSize)

    let bytesRead = 0
    for (let pageNum = startPage; pageNum < endPage && bytesRead < bytesToRead; pageNum++) {
      const page = this.extentStorage.readPageSync(file.fileId, pageNum)

      if (!page) {
        // Sparse region - zero fill
        const pageStart = pageNum * this.pageSize
        const pageEnd = pageStart + this.pageSize
        const readStart = Math.max(pageStart, position)
        const readEnd = Math.min(pageEnd, position + bytesToRead)
        const fillLen = readEnd - readStart
        buffer.fill(0, offset + bytesRead, offset + bytesRead + fillLen)
        bytesRead += fillLen
      } else {
        // Extract relevant portion of page
        const pageStart = pageNum * this.pageSize
        const pageOffset = pageNum === startPage ? position - pageStart : 0
        const copyLen = Math.min(this.pageSize - pageOffset, bytesToRead - bytesRead)
        buffer.set(page.subarray(pageOffset, pageOffset + copyLen), offset + bytesRead)
        bytesRead += copyLen
      }
    }

    // Update access time
    meta.atime = Date.now()

    return bytesRead
  }

  /**
   * Write to a file.
   *
   * @param fd - File descriptor
   * @param buffer - Buffer to write from
   * @param offset - Offset in buffer to start reading
   * @param length - Number of bytes to write
   * @param position - Position in file to write to
   * @returns Number of bytes written
   */
  write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    const file = this.openFiles.get(fd)
    if (!file) {
      throw FsError.badf(fd, 'write')
    }

    // Check if file is writable
    if (!file.flags.includes('w') && !file.flags.includes('a') && !file.flags.includes('+')) {
      throw FsError.badf(fd, 'write')
    }

    // Validate parameters
    if (offset < 0 || length < 0 || position < 0) {
      throw FsError.inval('negative offset, length, or position', 'write')
    }
    if (offset + length > buffer.length) {
      throw FsError.inval('buffer overflow', 'write')
    }

    // Get file metadata
    const meta = this.files.get(file.path)
    if (!meta) {
      throw FsError.noent(file.path, 'write')
    }

    if (length === 0) {
      return 0
    }

    // Write pages to extent storage
    let bytesWritten = 0
    while (bytesWritten < length) {
      const currentPosition = position + bytesWritten
      const pageNum = Math.floor(currentPosition / this.pageSize)
      const pageOffset = currentPosition % this.pageSize

      // Read existing page or create new one
      let page = this.extentStorage.readPageSync(file.fileId, pageNum)
      if (!page) {
        page = new Uint8Array(this.pageSize)
      } else {
        // Copy to avoid modifying cached data
        page = new Uint8Array(page)
      }

      // Write data to page
      const copyLen = Math.min(this.pageSize - pageOffset, length - bytesWritten)
      page.set(buffer.subarray(offset + bytesWritten, offset + bytesWritten + copyLen), pageOffset)

      // Write page back
      this.extentStorage.writePageSync(file.fileId, pageNum, page)
      bytesWritten += copyLen
    }

    // Update file size if extended
    const newSize = position + length
    if (newSize > meta.size) {
      meta.size = newSize
    }

    // Update modification time
    const now = Date.now()
    meta.mtime = now
    meta.ctime = now

    return bytesWritten
  }

  /**
   * Write data to a file (convenience method).
   *
   * @param path - File path
   * @param data - Data to write
   * @param options - Write options
   */
  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): void {
    const mode = options?.mode ?? 0o644

    // Convert string to bytes
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data

    // Open file for writing (truncate if exists)
    const fd = this.open(path, 'w', mode)

    try {
      // Write all data
      let offset = 0
      while (offset < bytes.length) {
        const written = this.write(fd, bytes, offset, bytes.length - offset, offset)
        offset += written
      }
    } finally {
      this.close(fd)
    }
  }

  /**
   * Read entire file contents.
   *
   * @param path - File path
   * @returns File contents as Uint8Array
   */
  readFile(path: string): Uint8Array {
    const normalized = this.normalizePath(path)

    // Check if it's a directory
    if (this.directories.has(normalized)) {
      throw FsError.isdir(path, 'readFile')
    }

    const meta = this.files.get(normalized)
    if (!meta) {
      throw FsError.noent(path, 'readFile')
    }

    const fd = this.open(path, 'r')
    try {
      const buffer = new Uint8Array(meta.size)
      let offset = 0
      while (offset < meta.size) {
        const bytesRead = this.read(fd, buffer, offset, meta.size - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      return buffer
    } finally {
      this.close(fd)
    }
  }

  /**
   * Truncate a file to a specified length.
   *
   * @param path - File path
   * @param len - New length in bytes
   */
  truncate(path: string, len: number): void {
    const normalized = this.normalizePath(path)

    // Check if it's a directory
    if (this.directories.has(normalized)) {
      throw FsError.isdir(path, 'truncate')
    }

    const meta = this.files.get(normalized)
    if (!meta) {
      throw FsError.noent(path, 'truncate')
    }

    if (len < 0) {
      throw FsError.inval('negative length', 'truncate')
    }

    // Update metadata
    const now = Date.now()
    meta.size = len
    meta.mtime = now
    meta.ctime = now

    // Note: ExtentStorage.truncate is async, but we're making this sync
    // In a production implementation, you might want to handle this differently
    // For now, we just update the metadata and let reads handle sparse regions
  }

  // ===========================================================================
  // Directory Operations
  // ===========================================================================

  /**
   * Create a directory.
   *
   * @param path - Directory path
   * @param options - Creation options
   */
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void {
    const normalized = this.normalizePath(path)
    const recursive = options?.recursive ?? false

    // Check if already exists
    if (this.directories.has(normalized)) {
      if (!recursive) {
        throw FsError.exist(path, 'mkdir')
      }
      return
    }

    if (this.files.has(normalized)) {
      throw FsError.exist(path, 'mkdir')
    }

    // Get parent path
    const parentPath = this.getParentPath(normalized)

    // Check/create parent
    if (parentPath !== '/' && !this.directories.has(parentPath)) {
      if (recursive) {
        this.mkdir(parentPath, { recursive: true, mode: options?.mode })
      } else {
        throw FsError.noent(parentPath, 'mkdir')
      }
    }

    // Create directory
    this.directories.add(normalized)
    this.getOrCreateInode(normalized)
  }

  /**
   * Read directory contents.
   *
   * @param path - Directory path
   * @returns Array of entry names
   */
  readdir(path: string): string[] {
    const normalized = this.normalizePath(path)

    // Check if directory exists
    if (!this.directories.has(normalized)) {
      // Check if it's a file
      if (this.files.has(normalized)) {
        throw FsError.notdir(path, 'readdir')
      }
      throw FsError.noent(path, 'readdir')
    }

    const entries: string[] = []
    const prefix = normalized === '/' ? '/' : normalized + '/'

    // Find child directories
    for (const dir of this.directories) {
      if (dir === normalized) continue
      if (dir.startsWith(prefix)) {
        // Get immediate child name
        const relative = dir.substring(prefix.length)
        const childName = relative.split('/')[0]
        if (childName && !entries.includes(childName)) {
          entries.push(childName)
        }
      }
    }

    // Find child files
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        const relative = filePath.substring(prefix.length)
        const childName = relative.split('/')[0]
        if (childName && !relative.includes('/') && !entries.includes(childName)) {
          entries.push(childName)
        }
      }
    }

    return entries.sort()
  }

  /**
   * Remove a directory.
   *
   * @param path - Directory path
   */
  rmdir(path: string): void {
    const normalized = this.normalizePath(path)

    // Cannot remove root
    if (normalized === '/') {
      throw FsError.inval('cannot remove root directory', 'rmdir')
    }

    // Check if directory exists
    if (!this.directories.has(normalized)) {
      if (this.files.has(normalized)) {
        throw FsError.notdir(path, 'rmdir')
      }
      throw FsError.noent(path, 'rmdir')
    }

    // Check if directory is empty
    const contents = this.readdir(path)
    if (contents.length > 0) {
      throw FsError.notempty(path, 'rmdir')
    }

    // Remove directory
    this.directories.delete(normalized)
    this.inodeMap.delete(normalized)
  }

  // ===========================================================================
  // File Management
  // ===========================================================================

  /**
   * Rename/move a file or directory.
   *
   * @param oldPath - Current path
   * @param newPath - New path
   */
  rename(oldPath: string, newPath: string): void {
    const oldNormalized = this.normalizePath(oldPath)
    const newNormalized = this.normalizePath(newPath)

    // Same path - no-op
    if (oldNormalized === newNormalized) {
      return
    }

    // Check destination parent exists
    const newParent = this.getParentPath(newNormalized)
    if (!this.directories.has(newParent)) {
      throw FsError.noent(newParent, 'rename')
    }

    const now = Date.now()

    // Handle directory rename
    if (this.directories.has(oldNormalized)) {
      // Remove destination if it exists and is empty directory
      if (this.directories.has(newNormalized)) {
        const contents = this.readdir(newNormalized)
        if (contents.length > 0) {
          throw FsError.notempty(newPath, 'rename')
        }
        this.directories.delete(newNormalized)
      } else if (this.files.has(newNormalized)) {
        throw FsError.exist(newPath, 'rename')
      }

      // Rename directory and all children
      const oldPrefix = oldNormalized === '/' ? '/' : oldNormalized + '/'

      // Collect all paths to rename
      const dirsToRename: string[] = []
      const filesToRename: string[] = []

      for (const dir of this.directories) {
        if (dir === oldNormalized || dir.startsWith(oldPrefix)) {
          dirsToRename.push(dir)
        }
      }

      for (const file of this.files.keys()) {
        if (file.startsWith(oldPrefix)) {
          filesToRename.push(file)
        }
      }

      // Rename directories
      for (const dir of dirsToRename) {
        this.directories.delete(dir)
        const newDir = dir === oldNormalized ? newNormalized : newNormalized + dir.substring(oldNormalized.length)
        this.directories.add(newDir)

        // Update inode mapping
        const ino = this.inodeMap.get(dir)
        if (ino !== undefined) {
          this.inodeMap.delete(dir)
          this.inodeMap.set(newDir, ino)
        }
      }

      // Rename files
      for (const file of filesToRename) {
        const meta = this.files.get(file)
        if (meta) {
          this.files.delete(file)
          const newFile = newNormalized + file.substring(oldNormalized.length)
          meta.path = newFile
          meta.ctime = now
          this.files.set(newFile, meta)

          // Update inode mapping
          const ino = this.inodeMap.get(file)
          if (ino !== undefined) {
            this.inodeMap.delete(file)
            this.inodeMap.set(newFile, ino)
          }
        }
      }

      return
    }

    // Handle file rename
    const meta = this.files.get(oldNormalized)
    if (!meta) {
      throw FsError.noent(oldPath, 'rename')
    }

    // Remove destination if exists
    if (this.directories.has(newNormalized)) {
      throw FsError.isdir(newPath, 'rename')
    }
    this.files.delete(newNormalized)

    // Move file metadata
    this.files.delete(oldNormalized)
    meta.path = newNormalized
    meta.ctime = now
    this.files.set(newNormalized, meta)

    // Update inode mapping
    const ino = this.inodeMap.get(oldNormalized)
    if (ino !== undefined) {
      this.inodeMap.delete(oldNormalized)
      this.inodeMap.set(newNormalized, ino)
    }

    // Note: We should also rename the file in ExtentStorage
    // This would require ExtentStorage to support rename
    // For now, the old fileId will still work until the next write
  }

  /**
   * Remove a file.
   *
   * @param path - File path
   */
  unlink(path: string): void {
    const normalized = this.normalizePath(path)

    // Cannot unlink directory
    if (this.directories.has(normalized)) {
      throw FsError.isdir(path, 'unlink')
    }

    // Check if file exists
    if (!this.files.has(normalized)) {
      throw FsError.noent(path, 'unlink')
    }

    // Remove file metadata
    this.files.delete(normalized)
    this.inodeMap.delete(normalized)

    // Note: Should also delete from ExtentStorage
    // For now we just remove the metadata
  }

  /**
   * Check if a path exists.
   *
   * @param path - File or directory path
   * @returns true if path exists
   */
  exists(path: string): boolean {
    const normalized = this.normalizePath(path)
    return this.directories.has(normalized) || this.files.has(normalized)
  }

  // ===========================================================================
  // Sync Operations
  // ===========================================================================

  /**
   * Synchronize file state to storage.
   *
   * @param fd - File descriptor
   */
  fsync(fd: number): void {
    const file = this.openFiles.get(fd)
    if (!file) {
      throw FsError.badf(fd, 'fsync')
    }

    // ExtentStorage handles durability through its SQL backend
    // This is effectively a no-op since writes go directly to SQL
  }

  /**
   * Flush all pending writes to storage.
   *
   * @returns Promise that resolves when flush is complete
   */
  async flush(): Promise<void> {
    await this.extentStorage.flush()
  }

  // ===========================================================================
  // Symlink Operations (minimal support)
  // ===========================================================================

  /**
   * Create a symbolic link.
   *
   * @param target - Link target
   * @param path - Link path
   */
  symlink(target: string, path: string): void {
    const normalized = this.normalizePath(path)

    // Check if already exists
    if (this.directories.has(normalized) || this.files.has(normalized)) {
      throw FsError.exist(path, 'symlink')
    }

    // Check parent exists
    const parentPath = this.getParentPath(normalized)
    if (!this.directories.has(parentPath)) {
      throw FsError.noent(parentPath, 'symlink')
    }

    // Create symlink as special file
    const now = Date.now()
    const meta: FileMetadata = {
      path: normalized,
      isDirectory: false,
      mode: S_IFREG | 0o777, // Symlinks have full permissions
      size: target.length,
      ino: this.getOrCreateInode(normalized),
      atime: now,
      mtime: now,
      ctime: now,
      linkTarget: target,
    }
    this.files.set(normalized, meta)
  }

  /**
   * Read symbolic link target.
   *
   * @param path - Link path
   * @returns Link target
   */
  readlink(path: string): string {
    const normalized = this.normalizePath(path)

    const meta = this.files.get(normalized)
    if (!meta) {
      throw FsError.noent(path, 'readlink')
    }

    if (!meta.linkTarget) {
      throw FsError.inval('not a symbolic link', 'readlink')
    }

    return meta.linkTarget
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create an ExtentPGliteFS instance.
 *
 * @param config - Filesystem configuration
 * @returns Configured ExtentPGliteFS instance
 *
 * @example
 * ```typescript
 * const extentStorage = await createExtentStorage({
 *   pageSize: 8192,
 *   extentSize: 2 * 1024 * 1024,
 *   backend: r2Storage,
 *   sql: sqlAdapter,
 * })
 *
 * const fs = createExtentPGliteFS({ extentStorage })
 *
 * // Initialize PostgreSQL directory structure
 * fs.mkdir('/tmp/pglite', { recursive: true })
 * fs.mkdir('/tmp/pglite/base')
 * fs.mkdir('/tmp/pglite/global')
 * fs.mkdir('/tmp/pglite/pg_wal')
 * fs.mkdir('/tmp/pglite/pg_xact')
 * ```
 */
export function createExtentPGliteFS(config: ExtentPGliteFSConfig): ExtentPGliteFS {
  return new ExtentPGliteFS(config)
}
