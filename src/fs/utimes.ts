/**
 * utimes - Update file timestamps
 *
 * GREEN phase - implementation complete
 */

import { type FileEntry } from '../core/types'
import { ENOENT } from '../core/errors'
import { normalize } from '../core/path'

/**
 * Storage interface for utimes operations
 */
export interface UtimesStorage {
  get(path: string): FileEntry | undefined
  has(path: string): boolean
  update(path: string, changes: Partial<FileEntry>): void
  resolveSymlink?(path: string, maxDepth?: number): FileEntry | undefined
}

let storage: UtimesStorage | null = null

/**
 * Set the storage adapter for utimes operations
 */
export function setStorage(s: UtimesStorage | null): void {
  storage = s
}

/**
 * Convert a timestamp input to milliseconds.
 * Handles Date objects, numeric timestamps (ms or seconds), and string dates.
 *
 * @param time - The time value to convert
 * @returns The time in milliseconds
 */
function toMilliseconds(time: Date | number | string): number {
  if (time instanceof Date) {
    return time.getTime()
  }

  if (typeof time === 'string') {
    return new Date(time).getTime()
  }

  // Number: determine if seconds or milliseconds
  // Values >= 1e12 are treated as milliseconds (covers dates from ~2001 onwards)
  // Values < 1e12 are treated as seconds and converted to milliseconds
  if (time >= 1e12 || time === 0) {
    return time
  }

  return time * 1000
}

/**
 * Update the access and modification times of a file.
 * Follows symbolic links.
 *
 * @param path - Path to the file
 * @param atime - Access time (Date, number in ms/s, or string)
 * @param mtime - Modification time (Date, number in ms/s, or string)
 * @throws ENOENT if path does not exist
 */
export async function utimes(
  path: string,
  atime: Date | number | string,
  mtime: Date | number | string
): Promise<void> {
  if (!storage) {
    throw new Error('Storage not configured')
  }

  const normalizedPath = normalize(path)
  const entry = storage.get(normalizedPath)

  if (!entry) {
    throw new ENOENT('utimes', normalizedPath)
  }

  // If it's a symlink, follow it to the target
  if (entry.type === 'symlink') {
    if (!storage.resolveSymlink) {
      throw new ENOENT('utimes', normalizedPath)
    }

    const resolved = storage.resolveSymlink(normalizedPath)
    if (!resolved) {
      // Broken symlink - target doesn't exist
      throw new ENOENT('utimes', normalizedPath)
    }

    // Update the target's timestamps
    const atimeMs = toMilliseconds(atime)
    const mtimeMs = toMilliseconds(mtime)
    const now = Date.now()

    storage.update(resolved.path, {
      atime: atimeMs,
      mtime: mtimeMs,
      ctime: now,
    })
    return
  }

  // Update timestamps for regular files and directories
  const atimeMs = toMilliseconds(atime)
  const mtimeMs = toMilliseconds(mtime)
  const now = Date.now()

  storage.update(normalizedPath, {
    atime: atimeMs,
    mtime: mtimeMs,
    ctime: now,
  })
}

/**
 * Update the access and modification times of a symbolic link.
 * Does NOT follow symbolic links - changes the symlink itself.
 *
 * @param path - Path to the file or symlink
 * @param atime - Access time (Date, number in ms/s, or string)
 * @param mtime - Modification time (Date, number in ms/s, or string)
 * @throws ENOENT if path does not exist
 */
export async function lutimes(
  path: string,
  atime: Date | number | string,
  mtime: Date | number | string
): Promise<void> {
  if (!storage) {
    throw new Error('Storage not configured')
  }

  const normalizedPath = normalize(path)
  const entry = storage.get(normalizedPath)

  if (!entry) {
    throw new ENOENT('lutimes', normalizedPath)
  }

  // Update timestamps directly on the entry (don't follow symlinks)
  const atimeMs = toMilliseconds(atime)
  const mtimeMs = toMilliseconds(mtime)
  const now = Date.now()

  storage.update(normalizedPath, {
    atime: atimeMs,
    mtime: mtimeMs,
    ctime: now,
  })
}
