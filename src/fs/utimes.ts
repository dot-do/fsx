/**
 * utimes - Update file timestamps
 *
 * RED phase stub - implementation not yet complete
 */

import { type FileEntry } from '../core/types'

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
  // RED phase - not implemented yet
  throw new Error('utimes not implemented')
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
  // RED phase - not implemented yet
  throw new Error('lutimes not implemented')
}
