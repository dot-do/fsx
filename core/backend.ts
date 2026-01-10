/**
 * FsBackend Interface
 *
 * The pluggable storage backend interface for @dotdo/fsx.
 * Implement this interface to create custom storage backends
 * (SQLite, R2, Memory, Node.js fs, etc.)
 *
 * @module backend
 */

import type {
  Stats,
  StatsInit,
  Dirent,
  ReadOptions,
  WriteOptions,
  MkdirOptions,
  RmdirOptions,
  ReaddirOptions,
  StorageTier,
  FileEntry,
} from './types.js'

// =============================================================================
// Backend Types
// =============================================================================

/**
 * Result of a backend write operation.
 */
export interface BackendWriteResult {
  /** Number of bytes written */
  bytesWritten: number
  /** Storage tier where data was placed */
  tier: StorageTier
}

/**
 * Result of a backend read operation.
 */
export interface BackendReadResult {
  /** Raw data bytes */
  data: Uint8Array
  /** Storage tier from which data was read */
  tier: StorageTier
  /** File size */
  size: number
}

/**
 * Options for backend initialization.
 */
export interface BackendOptions {
  /** Base path or namespace for this backend */
  basePath?: string
  /** Default storage tier for new files */
  defaultTier?: StorageTier
}

// =============================================================================
// FsBackend Interface
// =============================================================================

/**
 * Pluggable storage backend interface.
 *
 * This is the abstraction layer that allows @dotdo/fsx to work with
 * different storage backends without any platform-specific dependencies.
 *
 * Implementations:
 * - `SqliteBackend` - Durable Object SQLite (hot tier)
 * - `R2Backend` - Cloudflare R2 (warm tier)
 * - `TieredBackend` - Combines multiple backends with automatic tiering
 * - `MemoryBackend` - In-memory for testing
 * - `NodeBackend` - Node.js fs module
 *
 * @example
 * ```typescript
 * import { FsBackend, FSx } from '@dotdo/fsx'
 *
 * // Create a custom backend
 * class MyBackend implements FsBackend {
 *   async readFile(path: string): Promise<Uint8Array> {
 *     // Your implementation
 *   }
 *   // ... other methods
 * }
 *
 * // Use with FSx
 * const fs = new FSx(new MyBackend())
 * ```
 */
export interface FsBackend {
  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Read file contents.
   *
   * @param path - Absolute path to the file
   * @returns Raw file data as Uint8Array
   * @throws ENOENT if file does not exist
   * @throws EISDIR if path is a directory
   */
  readFile(path: string): Promise<Uint8Array>

  /**
   * Write data to a file, creating it if necessary.
   *
   * @param path - Absolute path to the file
   * @param data - Data to write
   * @param options - Write options (mode, flag, tier)
   * @returns Write result with bytes written and tier
   * @throws ENOENT if parent directory does not exist
   */
  writeFile(
    path: string,
    data: Uint8Array,
    options?: WriteOptions
  ): Promise<BackendWriteResult>

  /**
   * Delete a file.
   *
   * @param path - Absolute path to the file
   * @throws ENOENT if file does not exist
   * @throws EISDIR if path is a directory
   */
  unlink(path: string): Promise<void>

  /**
   * Rename or move a file.
   *
   * @param oldPath - Current path
   * @param newPath - New path
   */
  rename(oldPath: string, newPath: string): Promise<void>

  /**
   * Copy a file.
   *
   * @param src - Source file path
   * @param dest - Destination file path
   */
  copyFile(src: string, dest: string): Promise<void>

  // ===========================================================================
  // Directory Operations
  // ===========================================================================

  /**
   * Create a directory.
   *
   * @param path - Path to the directory
   * @param options - mkdir options (recursive, mode)
   */
  mkdir(path: string, options?: MkdirOptions): Promise<void>

  /**
   * Remove a directory.
   *
   * @param path - Path to the directory
   * @param options - rmdir options (recursive)
   */
  rmdir(path: string, options?: RmdirOptions): Promise<void>

  /**
   * Read directory contents.
   *
   * @param path - Path to the directory
   * @param options - readdir options
   * @returns Array of file names or Dirent objects
   */
  readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]>

  // ===========================================================================
  // Metadata Operations
  // ===========================================================================

  /**
   * Get file or directory statistics.
   *
   * @param path - Path to the file or directory
   * @returns Stats object
   * @throws ENOENT if path does not exist
   */
  stat(path: string): Promise<Stats>

  /**
   * Get statistics without following symbolic links.
   *
   * @param path - Path to check
   * @returns Stats object for the link itself
   */
  lstat(path: string): Promise<Stats>

  /**
   * Check if a path exists.
   *
   * @param path - Path to check
   * @returns true if exists, false otherwise
   */
  exists(path: string): Promise<boolean>

  /**
   * Change file permissions.
   *
   * @param path - Path to the file
   * @param mode - New permissions
   */
  chmod(path: string, mode: number): Promise<void>

  /**
   * Change file ownership.
   *
   * @param path - Path to the file
   * @param uid - User ID
   * @param gid - Group ID
   */
  chown(path: string, uid: number, gid: number): Promise<void>

  /**
   * Update file timestamps.
   *
   * @param path - Path to the file
   * @param atime - Access time
   * @param mtime - Modification time
   */
  utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void>

  // ===========================================================================
  // Symbolic Links
  // ===========================================================================

  /**
   * Create a symbolic link.
   *
   * @param target - Target path
   * @param path - Link path
   */
  symlink(target: string, path: string): Promise<void>

  /**
   * Create a hard link.
   *
   * @param existingPath - Existing file path
   * @param newPath - New link path
   */
  link(existingPath: string, newPath: string): Promise<void>

  /**
   * Read the target of a symbolic link.
   *
   * @param path - Path to the symbolic link
   * @returns Target path
   */
  readlink(path: string): Promise<string>

  // ===========================================================================
  // Optional Tiering Operations
  // ===========================================================================

  /**
   * Get the storage tier for a file.
   *
   * @param path - Path to the file
   * @returns Current storage tier
   */
  getTier?(path: string): Promise<StorageTier>

  /**
   * Move file to a higher tier.
   *
   * @param path - Path to the file
   * @param tier - Target tier
   */
  promote?(path: string, tier: 'hot' | 'warm'): Promise<void>

  /**
   * Move file to a lower tier.
   *
   * @param path - Path to the file
   * @param tier - Target tier
   */
  demote?(path: string, tier: 'warm' | 'cold'): Promise<void>
}

// =============================================================================
// Memory Backend (for testing)
// =============================================================================

/**
 * In-memory filesystem backend for testing.
 *
 * @example
 * ```typescript
 * const backend = new MemoryBackend()
 * const fs = new FSx(backend)
 *
 * await fs.write('/test.txt', 'Hello')
 * const content = await fs.read('/test.txt', { encoding: 'utf-8' })
 * ```
 */
export class MemoryBackend implements FsBackend {
  private files = new Map<string, { data: Uint8Array; stats: StatsInit }>()
  private directories = new Set<string>(['/'])

  async readFile(path: string): Promise<Uint8Array> {
    const file = this.files.get(path)
    if (!file) {
      throw new Error(`ENOENT: no such file: ${path}`)
    }
    return file.data
  }

  async writeFile(
    path: string,
    data: Uint8Array,
    options?: WriteOptions
  ): Promise<BackendWriteResult> {
    const now = Date.now()
    const mode = options?.mode ?? 0o644

    this.files.set(path, {
      data,
      stats: {
        dev: 1,
        ino: this.files.size + 1,
        mode: 0o100000 | mode, // S_IFREG | mode
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size: data.length,
        blksize: 4096,
        blocks: Math.ceil(data.length / 512),
        atimeMs: now,
        mtimeMs: now,
        ctimeMs: now,
        birthtimeMs: now,
      },
    })

    return { bytesWritten: data.length, tier: 'hot' }
  }

  async unlink(path: string): Promise<void> {
    if (!this.files.has(path)) {
      throw new Error(`ENOENT: no such file: ${path}`)
    }
    this.files.delete(path)
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const file = this.files.get(oldPath)
    if (!file) {
      throw new Error(`ENOENT: no such file: ${oldPath}`)
    }
    this.files.set(newPath, file)
    this.files.delete(oldPath)
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const file = this.files.get(src)
    if (!file) {
      throw new Error(`ENOENT: no such file: ${src}`)
    }
    const now = Date.now()
    this.files.set(dest, {
      data: new Uint8Array(file.data),
      stats: { ...file.stats, atimeMs: now, mtimeMs: now, ctimeMs: now },
    })
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    if (this.directories.has(path)) {
      throw new Error(`EEXIST: directory exists: ${path}`)
    }
    if (options?.recursive) {
      const parts = path.split('/').filter(Boolean)
      let current = ''
      for (const part of parts) {
        current += '/' + part
        this.directories.add(current)
      }
    } else {
      this.directories.add(path)
    }
  }

  async rmdir(path: string, options?: RmdirOptions): Promise<void> {
    if (!this.directories.has(path)) {
      throw new Error(`ENOENT: no such directory: ${path}`)
    }
    // Check if directory is empty
    const prefix = path.endsWith('/') ? path : path + '/'
    const hasChildren = [...this.files.keys(), ...this.directories].some(
      (p) => p !== path && p.startsWith(prefix)
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
    this.directories.delete(path)
  }

  async readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]> {
    const prefix = path.endsWith('/') ? path : path + '/'
    const entries = new Set<string>()

    // Find direct children
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) {
        const relative = file.slice(prefix.length)
        const firstPart = relative.split('/')[0]
        if (firstPart) entries.add(firstPart)
      }
    }
    for (const dir of this.directories) {
      if (dir.startsWith(prefix) && dir !== path) {
        const relative = dir.slice(prefix.length)
        const firstPart = relative.split('/')[0]
        if (firstPart) entries.add(firstPart)
      }
    }

    return [...entries]
  }

  async stat(path: string): Promise<Stats> {
    // Check if it's a file
    const file = this.files.get(path)
    if (file) {
      const { Stats } = await import('./types.js')
      return new Stats(file.stats)
    }

    // Check if it's a directory
    if (this.directories.has(path)) {
      const { Stats } = await import('./types.js')
      const now = Date.now()
      return new Stats({
        dev: 1,
        ino: 0,
        mode: 0o40755, // S_IFDIR | 0o755
        nlink: 2,
        uid: 0,
        gid: 0,
        rdev: 0,
        size: 4096,
        blksize: 4096,
        blocks: 8,
        atimeMs: now,
        mtimeMs: now,
        ctimeMs: now,
        birthtimeMs: now,
      })
    }

    throw new Error(`ENOENT: no such file or directory: ${path}`)
  }

  async lstat(path: string): Promise<Stats> {
    return this.stat(path)
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path)
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    // No-op for memory backend
  }

  async chown(_path: string, _uid: number, _gid: number): Promise<void> {
    // No-op for memory backend
  }

  async utimes(_path: string, _atime: Date | number, _mtime: Date | number): Promise<void> {
    // No-op for memory backend
  }

  async symlink(_target: string, _path: string): Promise<void> {
    throw new Error('Symlinks not supported in memory backend')
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error('Hard links not supported in memory backend')
  }

  async readlink(_path: string): Promise<string> {
    throw new Error('Symlinks not supported in memory backend')
  }
}
