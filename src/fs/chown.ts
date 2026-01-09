/**
 * chown - Change file owner and group
 *
 * Changes the owner (uid) and group (gid) of a file or directory.
 *
 * POSIX behavior:
 * - chown(path, uid, gid) - Changes ownership (follows symlinks)
 * - lchown(path, uid, gid) - Changes symlink ownership directly (doesn't follow)
 * - Use -1 to leave uid or gid unchanged
 * - Updates ctime (status change time) on successful change
 * - Throws ENOENT if path doesn't exist
 * - Throws EPERM if operation not permitted (only root can chown)
 */

import { type FileEntry } from '../core/types'
import { ENOENT, EPERM } from '../core/errors'
import { normalize } from '../core/path'

/**
 * Storage interface for chown operations
 */
export interface ChownStorage {
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
  getUid(): number

  /**
   * Get current group ID
   */
  getGid(): number

  /**
   * Check if current user is root
   */
  isRoot(): boolean
}

// Current storage instance
let storage: ChownStorage | null = null

/**
 * Set the storage implementation
 */
export function setStorage(s: ChownStorage | null): void {
  storage = s
}

/**
 * Get the current storage implementation
 */
export function getStorage(): ChownStorage | null {
  return storage
}

/**
 * Internal implementation for chown operations
 *
 * @param path - Path to the file or directory
 * @param uid - New owner user ID (-1 to leave unchanged)
 * @param gid - New owner group ID (-1 to leave unchanged)
 * @param followSymlinks - Whether to follow symbolic links
 * @param syscall - Name of the syscall for error messages
 */
async function chownInternal(
  path: string,
  uid: number,
  gid: number,
  followSymlinks: boolean,
  syscall: 'chown' | 'lchown'
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

  // Get current user info
  const currentUid = storage.getUid()
  const isRoot = storage.isRoot()

  // Check permissions: only root can change ownership
  // Non-root users cannot change uid at all
  // Non-root users can only change gid to a group they belong to (simplified: they can't change it)
  if (!isRoot) {
    // Non-root user trying to change uid
    if (uid !== -1) {
      throw new EPERM(syscall, path)
    }
    // Non-root user trying to change gid (simplified: not owner or not in target group)
    // In real POSIX, owner can change gid to a group they're a member of
    // For simplicity, we deny all gid changes for non-root
    if (gid !== -1) {
      throw new EPERM(syscall, path)
    }
  }

  // Calculate new uid and gid
  const newUid = uid === -1 ? targetEntry.uid : uid
  const newGid = gid === -1 ? targetEntry.gid : gid

  // Update the entry with new ownership and ctime
  storage.update(targetPath, {
    uid: newUid,
    gid: newGid,
    ctime: Date.now(),
  })
}

/**
 * Change file owner and group
 *
 * Changes the owner (uid) and group (gid) of the file specified by path.
 * If path refers to a symbolic link, this function follows the link
 * and changes the ownership of the target file.
 *
 * @param path - Path to the file or directory
 * @param uid - New owner user ID (-1 to leave unchanged)
 * @param gid - New owner group ID (-1 to leave unchanged)
 * @returns Promise that resolves when complete
 *
 * @throws {ENOENT} If path does not exist
 * @throws {EPERM} If operation is not permitted (not root)
 *
 * @example
 * ```typescript
 * // Change owner to uid 1000
 * await chown('/path/to/file.txt', 1000, -1)
 *
 * // Change group to gid 1000
 * await chown('/path/to/file.txt', -1, 1000)
 *
 * // Change both owner and group
 * await chown('/path/to/file.txt', 1000, 1000)
 * ```
 */
export async function chown(path: string, uid: number, gid: number): Promise<void> {
  return chownInternal(path, uid, gid, true, 'chown')
}

/**
 * Change symbolic link owner and group
 *
 * Like chown, but does not follow symbolic links.
 * Changes the ownership of the symbolic link itself.
 *
 * @param path - Path to the symbolic link (or file/directory)
 * @param uid - New owner user ID (-1 to leave unchanged)
 * @param gid - New owner group ID (-1 to leave unchanged)
 * @returns Promise that resolves when complete
 *
 * @throws {ENOENT} If path does not exist
 * @throws {EPERM} If operation is not permitted (not root)
 *
 * @example
 * ```typescript
 * // Change symlink ownership (without affecting target)
 * await lchown('/path/to/symlink', 1000, 1000)
 * ```
 */
export async function lchown(path: string, uid: number, gid: number): Promise<void> {
  return chownInternal(path, uid, gid, false, 'lchown')
}
