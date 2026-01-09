/**
 * chmod - Change file mode bits
 *
 * Changes the permissions (mode) of a file or directory.
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
import { ENOENT, EPERM } from '../core/errors'
import { normalize } from '../core/path'
import { constants } from '../core/constants'

// Permission bits mask (includes setuid, setgid, sticky, and rwx for owner/group/other)
const PERMISSION_MASK = 0o7777

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
 * Internal implementation for chmod operations
 *
 * @param path - Path to the file or directory
 * @param mode - New permissions (numeric mode)
 * @param followSymlinks - Whether to follow symbolic links
 * @param syscall - Name of the syscall for error messages
 */
async function chmodInternal(
  path: string,
  mode: number,
  followSymlinks: boolean,
  syscall: 'chmod' | 'lchmod'
): Promise<void> {
  // Check if storage is configured
  if (!storage) {
    throw new Error('Storage not configured')
  }

  // Normalize the path
  const normalizedPath = normalize(path)

  // Get the entry at the path
  const entry = storage.get(normalizedPath)

  // Check if the entry exists
  if (!entry) {
    throw new ENOENT(syscall, path)
  }

  // Determine which entry to modify
  let targetEntry: FileEntry | undefined
  let targetPath: string

  if (followSymlinks && entry.type === 'symlink') {
    // Follow symlinks to get the target
    if (storage.resolveSymlink) {
      targetEntry = storage.resolveSymlink(normalizedPath)
    }
    // If symlink resolution fails or target doesn't exist, throw ENOENT
    if (!targetEntry) {
      throw new ENOENT(syscall, path)
    }
    targetPath = targetEntry.path
  } else {
    // Operate on the entry directly (no symlink following)
    targetEntry = entry
    targetPath = normalizedPath
  }

  // Get current user ID (default to 1000 if not provided)
  const currentUid = storage.getUid ? storage.getUid() : 1000

  // Check permissions: only owner or root can chmod
  // Root (uid 0) can chmod any file
  if (currentUid !== 0 && targetEntry.uid !== currentUid) {
    throw new EPERM(syscall, path)
  }

  // Calculate the new mode:
  // - Preserve file type bits (S_IFMT)
  // - Set new permission bits (masked to 0o7777)
  //
  // Get file type bits either from the existing mode or derive from type field
  let fileTypeBits = targetEntry.mode & constants.S_IFMT

  // If file type bits are not set in mode, derive them from the type field
  if (fileTypeBits === 0) {
    switch (targetEntry.type) {
      case 'file':
        fileTypeBits = constants.S_IFREG
        break
      case 'directory':
        fileTypeBits = constants.S_IFDIR
        break
      case 'symlink':
        fileTypeBits = constants.S_IFLNK
        break
      // Other types can be added as needed
    }
  }

  const newPermissionBits = mode & PERMISSION_MASK
  const newMode = fileTypeBits | newPermissionBits

  // Update the entry with new mode and ctime
  storage.update(targetPath, {
    mode: newMode,
    ctime: Date.now(),
  })
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
  return chmodInternal(path, mode, true, 'chmod')
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
  return chmodInternal(path, mode, false, 'lchmod')
}
