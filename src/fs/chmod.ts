/**
 * chmod - Change file mode bits
 *
 * Changes the permissions (mode) of a file or directory.
 * This is a stub implementation for RED phase TDD.
 *
 * POSIX behavior:
 * - chmod(path, mode) - Changes permissions of file at path (follows symlinks)
 * - lchmod(path, mode) - Changes permissions of symlink itself (if supported)
 * - Mode is a numeric octal value (e.g., 0o755, 0o644)
 * - Only permission bits are changed (lower 12 bits: 0o7777)
 * - File type bits (S_IFMT) are preserved
 * - Updates ctime (status change time) on successful change
 * - Throws ENOENT if path doesn't exist
 * - Throws EPERM if operation not permitted (not owner/root)
 */

import { type FileEntry } from '../core/types'

/**
 * Storage interface for chmod operations
 */
export interface ChmodStorage {
  /**
   * Get a file entry by path
   */
  get(path: string): FileEntry | undefined

  /**
   * Check if a path exists
   */
  has(path: string): boolean

  /**
   * Update a file entry
   */
  update(path: string, changes: Partial<FileEntry>): void

  /**
   * Resolve symlink to its target entry
   */
  resolveSymlink?(path: string, maxDepth?: number): FileEntry | undefined

  /**
   * Get current user ID
   */
  getUid?(): number

  /**
   * Get current group ID
   */
  getGid?(): number
}

// Current storage instance
let storage: ChmodStorage | null = null

/**
 * Set the storage implementation
 */
export function setStorage(s: ChmodStorage | null): void {
  storage = s
}

/**
 * Get the current storage implementation
 */
export function getStorage(): ChmodStorage | null {
  return storage
}

/**
 * Change file mode bits
 *
 * Changes the permissions of the file specified by path.
 * If path refers to a symbolic link, this function follows the link
 * and changes the permissions of the target file.
 *
 * @param path - Path to the file or directory
 * @param mode - New permissions (numeric mode, e.g., 0o755)
 * @returns Promise that resolves when complete
 *
 * @throws {ENOENT} If path does not exist
 * @throws {EPERM} If operation is not permitted (not owner or root)
 *
 * @example
 * ```typescript
 * // Make file executable
 * await chmod('/path/to/script.sh', 0o755)
 *
 * // Make file read-only
 * await chmod('/path/to/file.txt', 0o444)
 *
 * // Private file (owner only)
 * await chmod('/path/to/secret.txt', 0o600)
 * ```
 */
export async function chmod(path: string, mode: number): Promise<void> {
  throw new Error('chmod not implemented')
}

/**
 * Change symbolic link mode bits
 *
 * Like chmod, but does not follow symbolic links.
 * Changes the permissions of the symbolic link itself.
 *
 * Note: This operation may not be supported on all platforms.
 * Some platforms ignore permissions on symbolic links.
 *
 * @param path - Path to the symbolic link (or file/directory)
 * @param mode - New permissions (numeric mode, e.g., 0o755)
 * @returns Promise that resolves when complete
 *
 * @throws {ENOENT} If path does not exist
 * @throws {EPERM} If operation is not permitted
 *
 * @example
 * ```typescript
 * // Change symlink permissions (without affecting target)
 * await lchmod('/path/to/symlink', 0o755)
 * ```
 */
export async function lchmod(path: string, mode: number): Promise<void> {
  throw new Error('lchmod not implemented')
}
