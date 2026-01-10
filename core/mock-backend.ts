/**
 * MockBackend - Full in-memory filesystem implementation for testing.
 *
 * This module provides a complete FsBackend implementation with support for:
 * - Files and directories
 * - Symbolic links and hard links
 * - File handles with positioned read/write
 * - All POSIX error codes (ENOENT, EEXIST, EISDIR, ENOTDIR, ENOTEMPTY, etc.)
 *
 * @module mock-backend
 */

import type {
  Stats,
  StatsInit,
  Dirent,
  WriteOptions,
  MkdirOptions,
  RmdirOptions,
  ReaddirOptions,
  StorageTier,
} from './types.js'
import type { FsBackend, BackendWriteResult, FileHandle } from './backend.js'
import { constants } from './constants.js'

// =============================================================================
// MockBackend Implementation
// =============================================================================

/**
 * In-memory filesystem backend for testing.
 *
 * Provides a complete implementation of FsBackend with full support for:
 * - File and directory operations
 * - Symbolic links and hard links
 * - File handles for positioned I/O
 * - Proper POSIX error semantics
 *
 * @example
 * ```typescript
 * import { MockBackend } from '@dotdo/fsx/mock-backend'
 *
 * const backend = new MockBackend()
 *
 * // Create files and directories
 * await backend.mkdir('/src', { recursive: true })
 * await backend.writeFile('/src/index.ts', new TextEncoder().encode('export {}'))
 *
 * // Read back
 * const data = await backend.readFile('/src/index.ts')
 * console.log(new TextDecoder().decode(data))
 * ```
 */
export class MockBackend implements FsBackend {
  private files = new Map<string, { data: Uint8Array; stats: StatsInit }>()
  private directories = new Set<string>(['/'])
  private symlinks = new Map<string, string>()
  private nextFd = 3 // 0, 1, 2 are stdin, stdout, stderr

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  /**
   * Normalize a path by resolving . and .., removing duplicate slashes,
   * and stripping trailing slashes (except for root).
   */
  private normalizePath(path: string): string {
    if (!path) {
      throw new Error('ENOENT: path cannot be empty')
    }

    // Handle double slashes by replacing with single slash
    path = path.replace(/\/+/g, '/')

    // Split and resolve . and ..
    const parts = path.split('/')
    const resolved: string[] = []

    for (const part of parts) {
      if (part === '..') {
        resolved.pop()
      } else if (part !== '.' && part !== '') {
        resolved.push(part)
      }
    }

    // Reconstruct path
    let result = '/' + resolved.join('/')

    // Strip trailing slash (except for root)
    if (result !== '/' && result.endsWith('/')) {
      result = result.slice(0, -1)
    }

    return result
  }

  /**
   * Get the parent directory of a path.
   */
  private getParentDir(path: string): string {
    const normalized = this.normalizePath(path)
    if (normalized === '/') return '/'
    const lastSlash = normalized.lastIndexOf('/')
    return lastSlash === 0 ? '/' : normalized.slice(0, lastSlash)
  }

  /**
   * Create a Stats object from StatsInit.
   */
  private createStats(isDir: boolean, size: number, mode?: number): StatsInit {
    const now = Date.now()
    return {
      dev: 1,
      ino: this.files.size + this.directories.size + 1,
      mode: isDir ? constants.S_IFDIR | 0o755 : constants.S_IFREG | (mode ?? 0o644),
      nlink: isDir ? 2 : 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size: isDir ? 4096 : size,
      blksize: 4096,
      blocks: Math.ceil((isDir ? 4096 : size) / 512),
      atimeMs: now,
      mtimeMs: now,
      ctimeMs: now,
      birthtimeMs: now,
    }
  }

  /**
   * Create a Stats-like object from StatsInit.
   */
  private createStatsObject(init: StatsInit): Stats {
    return {
      ...init,
      get atime() {
        return new Date(init.atimeMs)
      },
      get mtime() {
        return new Date(init.mtimeMs)
      },
      get ctime() {
        return new Date(init.ctimeMs)
      },
      get birthtime() {
        return new Date(init.birthtimeMs)
      },
      isFile: () => (init.mode & constants.S_IFMT) === constants.S_IFREG,
      isDirectory: () => (init.mode & constants.S_IFMT) === constants.S_IFDIR,
      isSymbolicLink: () => (init.mode & constants.S_IFMT) === constants.S_IFLNK,
      isBlockDevice: () => (init.mode & constants.S_IFMT) === constants.S_IFBLK,
      isCharacterDevice: () => (init.mode & constants.S_IFMT) === constants.S_IFCHR,
      isFIFO: () => (init.mode & constants.S_IFMT) === constants.S_IFIFO,
      isSocket: () => (init.mode & constants.S_IFMT) === constants.S_IFSOCK,
    } as Stats
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  async readFile(path: string): Promise<Uint8Array> {
    const normalized = this.normalizePath(path)

    // Check if it's a directory
    if (this.directories.has(normalized)) {
      throw new Error(`EISDIR: illegal operation on a directory: ${path}`)
    }

    const file = this.files.get(normalized)
    if (!file) {
      throw new Error(`ENOENT: no such file: ${path}`)
    }
    return file.data
  }

  /**
   * Check if any path component (excluding the final name) is a file.
   * Returns the file path if found, null otherwise.
   */
  private findFileInPath(path: string): string | null {
    const normalized = this.normalizePath(path)
    const parts = normalized.split('/').filter(Boolean)
    let current = ''
    // Check all components except the last (which is the target file/dir name)
    for (let i = 0; i < parts.length - 1; i++) {
      current += '/' + parts[i]
      if (this.files.has(current)) {
        return current
      }
    }
    return null
  }

  async writeFile(
    path: string,
    data: Uint8Array,
    options?: WriteOptions
  ): Promise<BackendWriteResult> {
    const normalized = this.normalizePath(path)

    // Check if path is a directory
    if (this.directories.has(normalized)) {
      throw new Error(`EISDIR: illegal operation on a directory: ${path}`)
    }

    // Check if any path component is a file (ENOTDIR takes precedence)
    const fileInPath = this.findFileInPath(normalized)
    if (fileInPath) {
      throw new Error(`ENOTDIR: not a directory: ${path}`)
    }

    // Check parent exists
    const parent = this.getParentDir(normalized)
    if (parent !== '/' && !this.directories.has(parent)) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }

    const mode = options?.mode ?? 0o644
    const existing = this.files.get(normalized)

    if (existing) {
      // Update existing file (preserves hard links)
      existing.data = data
      existing.stats.size = data.length
      existing.stats.mtimeMs = Date.now()
      existing.stats.ctimeMs = Date.now()
      if (options?.mode !== undefined) {
        existing.stats.mode = constants.S_IFREG | (mode & 0o777)
      }
    } else {
      // Create new file
      this.files.set(normalized, {
        data,
        stats: this.createStats(false, data.length, mode),
      })
    }

    return { bytesWritten: data.length, tier: 'hot' }
  }

  async appendFile(path: string, data: Uint8Array): Promise<void> {
    const normalized = this.normalizePath(path)
    const existing = this.files.get(normalized)

    if (existing) {
      const newData = new Uint8Array(existing.data.length + data.length)
      newData.set(existing.data)
      newData.set(data, existing.data.length)
      existing.data = newData
      existing.stats.size = newData.length
      existing.stats.mtimeMs = Date.now()
    } else {
      await this.writeFile(path, data)
    }
  }

  async unlink(path: string): Promise<void> {
    const normalized = this.normalizePath(path)

    // Check if it's a directory
    if (this.directories.has(normalized)) {
      throw new Error(`EISDIR: illegal operation on a directory: ${path}`)
    }

    if (!this.files.has(normalized) && !this.symlinks.has(normalized)) {
      throw new Error(`ENOENT: no such file: ${path}`)
    }

    this.files.delete(normalized)
    this.symlinks.delete(normalized)
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const normalizedOld = this.normalizePath(oldPath)
    const normalizedNew = this.normalizePath(newPath)

    // Check destination parent exists
    const destParent = this.getParentDir(normalizedNew)
    if (destParent !== '/' && !this.directories.has(destParent)) {
      throw new Error(`ENOENT: no such file or directory: ${newPath}`)
    }

    // Check if source is a directory
    if (this.directories.has(normalizedOld)) {
      // Rename directory and all contents
      const oldPrefix = normalizedOld === '/' ? '/' : normalizedOld + '/'

      // Collect all paths to rename
      const filesToRename: Array<{
        old: string
        new: string
        file: { data: Uint8Array; stats: StatsInit }
      }> = []
      const dirsToRename: Array<{ old: string; new: string }> = []

      for (const [filePath, file] of this.files) {
        if (filePath.startsWith(oldPrefix)) {
          const newFilePath = normalizedNew + filePath.slice(normalizedOld.length)
          filesToRename.push({ old: filePath, new: newFilePath, file })
        }
      }

      for (const dirPath of this.directories) {
        if (dirPath === normalizedOld || dirPath.startsWith(oldPrefix)) {
          const newDirPath = normalizedNew + dirPath.slice(normalizedOld.length)
          dirsToRename.push({ old: dirPath, new: newDirPath })
        }
      }

      // Apply renames
      for (const { old, new: newP, file } of filesToRename) {
        this.files.delete(old)
        this.files.set(newP, file)
      }

      for (const { old, new: newP } of dirsToRename) {
        this.directories.delete(old)
        this.directories.add(newP)
      }

      return
    }

    // Rename file
    const file = this.files.get(normalizedOld)
    if (!file) {
      throw new Error(`ENOENT: no such file: ${oldPath}`)
    }

    // Remove destination if it exists (overwrite)
    this.files.delete(normalizedNew)

    this.files.set(normalizedNew, file)
    this.files.delete(normalizedOld)
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const normalizedSrc = this.normalizePath(src)
    const normalizedDest = this.normalizePath(dest)

    // Check if source is a directory
    if (this.directories.has(normalizedSrc)) {
      throw new Error(`EISDIR: illegal operation on a directory: ${src}`)
    }

    const file = this.files.get(normalizedSrc)
    if (!file) {
      throw new Error(`ENOENT: no such file: ${src}`)
    }

    // Check destination parent exists
    const destParent = this.getParentDir(normalizedDest)
    if (destParent !== '/' && !this.directories.has(destParent)) {
      throw new Error(`ENOENT: no such file or directory: ${dest}`)
    }

    const now = Date.now()
    this.files.set(normalizedDest, {
      data: new Uint8Array(file.data),
      stats: { ...file.stats, atimeMs: now, mtimeMs: now, ctimeMs: now },
    })
  }

  // ===========================================================================
  // Directory Operations
  // ===========================================================================

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const normalized = this.normalizePath(path)

    // Check if file exists at path
    if (this.files.has(normalized)) {
      throw new Error(`EEXIST: file exists: ${path}`)
    }

    if (options?.recursive) {
      // With recursive, we don't throw if directory exists
      if (this.directories.has(normalized)) {
        return
      }

      const parts = normalized.split('/').filter(Boolean)
      let current = ''
      for (const part of parts) {
        current += '/' + part
        // Check if a file exists in the path
        if (this.files.has(current)) {
          throw new Error(`ENOTDIR: not a directory: ${current}`)
        }
        this.directories.add(current)
      }
    } else {
      // Non-recursive: check if already exists
      if (this.directories.has(normalized)) {
        throw new Error(`EEXIST: directory exists: ${path}`)
      }

      // Check if any path component is a file (ENOTDIR takes precedence)
      const fileInPath = this.findFileInPath(normalized)
      if (fileInPath) {
        throw new Error(`ENOTDIR: not a directory: ${path}`)
      }

      // Check parent exists
      const parent = this.getParentDir(normalized)
      if (parent !== '/' && !this.directories.has(parent)) {
        throw new Error(`ENOENT: no such file or directory: ${path}`)
      }

      this.directories.add(normalized)
    }
  }

  async rmdir(path: string, options?: RmdirOptions): Promise<void> {
    const normalized = this.normalizePath(path)

    // Cannot remove root
    if (normalized === '/') {
      throw new Error('EPERM: operation not permitted: /')
    }

    // Check if it's a file
    if (this.files.has(normalized)) {
      throw new Error(`ENOTDIR: not a directory: ${path}`)
    }

    if (!this.directories.has(normalized)) {
      throw new Error(`ENOENT: no such directory: ${path}`)
    }

    // Check if directory is empty
    const prefix = normalized + '/'
    const hasChildren = [...this.files.keys(), ...this.directories].some(
      (p) => p !== normalized && p.startsWith(prefix)
    )

    if (hasChildren && !options?.recursive) {
      throw new Error(`ENOTEMPTY: directory not empty: ${path}`)
    }

    if (options?.recursive) {
      for (const file of this.files.keys()) {
        if (file.startsWith(prefix)) {
          this.files.delete(file)
        }
      }
      for (const dir of this.directories) {
        if (dir.startsWith(prefix)) {
          this.directories.delete(dir)
        }
      }
    }

    this.directories.delete(normalized)
  }

  async readdir(
    path: string,
    options?: ReaddirOptions
  ): Promise<string[] | Dirent[]> {
    const normalized = this.normalizePath(path)

    // Check if it's a file
    if (this.files.has(normalized)) {
      throw new Error(`ENOTDIR: not a directory: ${path}`)
    }

    // Check if directory exists
    if (!this.directories.has(normalized)) {
      throw new Error(`ENOENT: no such directory: ${path}`)
    }

    const prefix = normalized === '/' ? '/' : normalized + '/'
    const entries = new Set<string>()

    // Find direct children - files
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) {
        const relative = file.slice(prefix.length)
        const firstPart = relative.split('/')[0]
        if (firstPart) entries.add(firstPart)
      }
    }

    // Find direct children - directories
    for (const dir of this.directories) {
      if (dir.startsWith(prefix) && dir !== normalized) {
        const relative = dir.slice(prefix.length)
        const firstPart = relative.split('/')[0]
        if (firstPart) entries.add(firstPart)
      }
    }

    // Find direct children - symlinks
    for (const symlink of this.symlinks.keys()) {
      if (symlink.startsWith(prefix)) {
        const relative = symlink.slice(prefix.length)
        const firstPart = relative.split('/')[0]
        if (firstPart) entries.add(firstPart)
      }
    }

    if (options?.withFileTypes) {
      const result: Dirent[] = []
      for (const name of entries) {
        const fullPath = prefix + name
        const isSymlink = this.symlinks.has(fullPath)
        const isDir = this.directories.has(fullPath)
        const isFile = this.files.has(fullPath)
        result.push({
          name,
          parentPath: normalized,
          isFile: () => isFile && !isSymlink,
          isDirectory: () => isDir && !isSymlink,
          isSymbolicLink: () => isSymlink,
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isFIFO: () => false,
          isSocket: () => false,
          get path() {
            return fullPath
          },
        } as Dirent)
      }
      return result
    }

    return [...entries]
  }

  // ===========================================================================
  // Metadata Operations
  // ===========================================================================

  async stat(path: string): Promise<Stats> {
    const normalized = this.normalizePath(path)

    // Follow symlinks
    if (this.symlinks.has(normalized)) {
      const target = this.symlinks.get(normalized)!
      return this.stat(target)
    }

    const file = this.files.get(normalized)
    if (file) {
      return this.createStatsObject(file.stats)
    }

    if (this.directories.has(normalized)) {
      return this.createStatsObject(this.createStats(true, 4096))
    }

    throw new Error(`ENOENT: no such file or directory: ${path}`)
  }

  async lstat(path: string): Promise<Stats> {
    const normalized = this.normalizePath(path)

    // Don't follow symlinks
    if (this.symlinks.has(normalized)) {
      const target = this.symlinks.get(normalized)!
      return this.createStatsObject({
        ...this.createStats(false, target.length),
        mode: constants.S_IFLNK | 0o777,
      })
    }

    return this.stat(path)
  }

  async exists(path: string): Promise<boolean> {
    const normalized = this.normalizePath(path)
    return (
      this.files.has(normalized) ||
      this.directories.has(normalized) ||
      this.symlinks.has(normalized)
    )
  }

  async access(path: string, _mode?: number): Promise<void> {
    const normalized = this.normalizePath(path)
    if (
      !this.files.has(normalized) &&
      !this.directories.has(normalized) &&
      !this.symlinks.has(normalized)
    ) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }
    // In a full implementation, we'd check mode against file permissions
  }

  async chmod(path: string, mode: number): Promise<void> {
    const normalized = this.normalizePath(path)

    const file = this.files.get(normalized)
    if (file) {
      file.stats.mode = constants.S_IFREG | (mode & 0o777)
      return
    }

    if (this.directories.has(normalized)) {
      // Directories don't store stats in this simple impl
      return
    }

    throw new Error(`ENOENT: no such file or directory: ${path}`)
  }

  async chown(path: string, uid: number, gid: number): Promise<void> {
    const normalized = this.normalizePath(path)

    const file = this.files.get(normalized)
    if (file) {
      file.stats.uid = uid
      file.stats.gid = gid
      return
    }

    if (this.directories.has(normalized)) {
      // Directories don't store stats in this simple impl
      return
    }

    throw new Error(`ENOENT: no such file or directory: ${path}`)
  }

  async utimes(
    path: string,
    atime: Date | number,
    mtime: Date | number
  ): Promise<void> {
    const normalized = this.normalizePath(path)

    const atimeMs = atime instanceof Date ? atime.getTime() : atime
    const mtimeMs = mtime instanceof Date ? mtime.getTime() : mtime

    const file = this.files.get(normalized)
    if (file) {
      file.stats.atimeMs = atimeMs
      file.stats.mtimeMs = mtimeMs
      return
    }

    if (this.directories.has(normalized)) {
      // Directories don't store stats in this simple impl
      return
    }

    throw new Error(`ENOENT: no such file or directory: ${path}`)
  }

  // ===========================================================================
  // Symbolic Links
  // ===========================================================================

  async readlink(path: string): Promise<string> {
    const normalized = this.normalizePath(path)
    const target = this.symlinks.get(normalized)

    if (!target) {
      if (this.files.has(normalized) || this.directories.has(normalized)) {
        throw new Error(`EINVAL: invalid argument, not a symlink: ${path}`)
      }
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }

    return target
  }

  async symlink(target: string, path: string): Promise<void> {
    const normalized = this.normalizePath(path)

    if (
      this.files.has(normalized) ||
      this.directories.has(normalized) ||
      this.symlinks.has(normalized)
    ) {
      throw new Error(`EEXIST: file already exists: ${path}`)
    }

    const parent = this.getParentDir(normalized)
    if (parent !== '/' && !this.directories.has(parent)) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }

    this.symlinks.set(normalized, target)
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const normalizedExisting = this.normalizePath(existingPath)
    const normalizedNew = this.normalizePath(newPath)

    if (this.directories.has(normalizedExisting)) {
      throw new Error(
        `EPERM: operation not permitted, hard link to directory: ${existingPath}`
      )
    }

    const file = this.files.get(normalizedExisting)
    if (!file) {
      throw new Error(`ENOENT: no such file: ${existingPath}`)
    }

    if (
      this.files.has(normalizedNew) ||
      this.directories.has(normalizedNew) ||
      this.symlinks.has(normalizedNew)
    ) {
      throw new Error(`EEXIST: file already exists: ${newPath}`)
    }

    const parent = this.getParentDir(normalizedNew)
    if (parent !== '/' && !this.directories.has(parent)) {
      throw new Error(`ENOENT: no such file or directory: ${newPath}`)
    }

    // Hard link shares the same data
    this.files.set(normalizedNew, file)
    file.stats.nlink++
  }

  // ===========================================================================
  // Path Operations
  // ===========================================================================

  async realpath(path: string): Promise<string> {
    const normalized = this.normalizePath(path)
    let current = normalized
    const seen = new Set<string>()

    while (this.symlinks.has(current)) {
      if (seen.has(current)) {
        throw new Error(`ELOOP: too many levels of symbolic links: ${path}`)
      }
      seen.add(current)
      const target = this.symlinks.get(current)!
      current = target.startsWith('/')
        ? this.normalizePath(target)
        : this.normalizePath(this.getParentDir(current) + '/' + target)
    }

    if (!this.files.has(current) && !this.directories.has(current)) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }

    return current
  }

  async mkdtemp(prefix: string): Promise<string> {
    const random = Math.random().toString(36).substring(2, 8)
    const path = `${prefix}${random}`
    await this.mkdir(path)
    return path
  }

  // ===========================================================================
  // File Handle
  // ===========================================================================

  async open(
    path: string,
    flags?: string,
    mode?: number
  ): Promise<FileHandle> {
    const normalized = this.normalizePath(path)
    const flagStr = flags ?? 'r'

    // Check if file exists for read modes
    if (
      flagStr.includes('r') &&
      !flagStr.includes('+') &&
      !flagStr.includes('w')
    ) {
      if (!this.files.has(normalized)) {
        throw new Error(`ENOENT: no such file or directory: ${path}`)
      }
    }

    // Exclusive create mode
    if (flagStr.includes('x')) {
      if (this.files.has(normalized)) {
        throw new Error(`EEXIST: file already exists: ${path}`)
      }
    }

    // Create file if needed
    if (flagStr.includes('w') || flagStr.includes('a')) {
      if (!this.files.has(normalized)) {
        await this.writeFile(path, new Uint8Array(0), { mode: mode ?? 0o644 })
      }
    }

    const fd = this.nextFd++
    const file = this.files.get(normalized)!

    return new MockFileHandle(fd, file, this, normalized)
  }

  // ===========================================================================
  // Optional Tiering Operations
  // ===========================================================================

  async getTier(_path: string): Promise<StorageTier> {
    return 'hot'
  }

  async promote(_path: string, _tier: 'hot' | 'warm'): Promise<void> {
    // No-op for memory backend - everything is already "hot"
  }

  async demote(_path: string, _tier: 'warm' | 'cold'): Promise<void> {
    // No-op for memory backend
  }
}

// =============================================================================
// MockFileHandle Implementation
// =============================================================================

/**
 * File handle implementation for MockBackend.
 */
class MockFileHandle implements FileHandle {
  readonly fd: number
  private file: { data: Uint8Array; stats: StatsInit }
  private backend: MockBackend
  private path: string
  private closed = false
  private position = 0

  constructor(
    fd: number,
    file: { data: Uint8Array; stats: StatsInit },
    backend: MockBackend,
    path: string
  ) {
    this.fd = fd
    this.file = file
    this.backend = backend
    this.path = path
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('File handle is closed')
    }
  }

  async read(
    buffer: Uint8Array,
    offset = 0,
    length?: number,
    position?: number
  ): Promise<{ bytesRead: number; buffer: Uint8Array }> {
    this.ensureOpen()

    const pos = position ?? this.position
    const len =
      length ?? Math.min(buffer.length - offset, this.file.data.length - pos)
    const bytesToRead = Math.min(
      len,
      this.file.data.length - pos,
      buffer.length - offset
    )

    for (let i = 0; i < bytesToRead; i++) {
      buffer[offset + i] = this.file.data[pos + i]!
    }

    if (position === undefined) {
      this.position += bytesToRead
    }

    return { bytesRead: bytesToRead, buffer }
  }

  async write(
    data: Uint8Array | string,
    position?: number
  ): Promise<{ bytesWritten: number }> {
    this.ensureOpen()

    const bytes =
      typeof data === 'string' ? new TextEncoder().encode(data) : data
    const pos = position ?? this.position

    if (pos + bytes.length > this.file.data.length) {
      const newData = new Uint8Array(pos + bytes.length)
      newData.set(this.file.data)
      this.file.data = newData
    }

    for (let i = 0; i < bytes.length; i++) {
      this.file.data[pos + i] = bytes[i]!
    }

    this.file.stats.size = this.file.data.length
    this.file.stats.mtimeMs = Date.now()

    if (position === undefined) {
      this.position += bytes.length
    }

    return { bytesWritten: bytes.length }
  }

  async readFile(): Promise<Uint8Array> {
    this.ensureOpen()
    return new Uint8Array(this.file.data)
  }

  async writeFile(data: Uint8Array | string): Promise<void> {
    this.ensureOpen()
    const bytes =
      typeof data === 'string' ? new TextEncoder().encode(data) : data
    this.file.data = new Uint8Array(bytes)
    this.file.stats.size = bytes.length
    this.file.stats.mtimeMs = Date.now()
  }

  async stat(): Promise<Stats> {
    this.ensureOpen()
    return this.backend.stat(this.path)
  }

  async chmod(mode: number): Promise<void> {
    this.ensureOpen()
    return this.backend.chmod(this.path, mode)
  }

  async chown(uid: number, gid: number): Promise<void> {
    this.ensureOpen()
    return this.backend.chown(this.path, uid, gid)
  }

  async close(): Promise<void> {
    this.closed = true
  }

  async sync(): Promise<void> {
    this.ensureOpen()
    // No-op in memory backend
  }

  async datasync(): Promise<void> {
    this.ensureOpen()
    // No-op in memory backend
  }
}
