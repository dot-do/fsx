/**
 * exists operation - check if path exists
 *
 * Returns true if the path exists, false otherwise.
 * Unlike access(), exists() never throws - it always returns a boolean.
 *
 * Following Node.js fs.promises API behavior:
 * - Returns Promise<boolean>
 * - Follows symbolic links (returns false for broken symlinks)
 * - Never throws - always returns true or false
 */

import type { FileEntry } from '../core/types'

/**
 * Storage interface for exists
 */
export interface ExistsStorage {
  /**
   * Get entry by path
   */
  get(path: string): FileEntry | undefined

  /**
   * Check if path exists
   */
  has(path: string): boolean

  /**
   * Resolve a symlink chain to get the final target entry
   * Returns undefined if the symlink target doesn't exist (broken link)
   */
  resolveSymlink?(path: string, maxDepth?: number): FileEntry | undefined
}

// Module-level storage that can be set for testing
let storage: ExistsStorage | null = null

/**
 * Set the storage backend for exists
 * Used primarily for testing
 */
export function setStorage(s: ExistsStorage | null): void {
  storage = s
}

/**
 * Get the current storage backend
 */
export function getStorage(): ExistsStorage | null {
  return storage
}

/**
 * Check if a path exists
 *
 * @param path - Path to check
 * @returns true if path exists, false otherwise
 *
 * @example
 * ```typescript
 * if (await exists('/config.json')) {
 *   const config = await readFile('/config.json', { encoding: 'utf-8' })
 * }
 * ```
 */
export async function exists(path: string): Promise<boolean> {
  // RED phase stub - not implemented yet
  // This will cause tests to fail with incorrect behavior
  throw new Error('exists() is not implemented yet')
}
