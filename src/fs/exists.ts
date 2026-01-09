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
  // Handle edge cases that should return false
  if (!path || path === '') {
    return false
  }

  // Check if storage is configured
  if (!storage) {
    return false
  }

  // Import normalize here to avoid circular dependency issues
  const { normalize } = await import('../core/path')

  // Normalize the path
  const normalizedPath = normalize(path)

  // Handle trailing slash: POSIX treats trailing slash as "must be directory"
  // So /file.txt/ should return false if file.txt is not a directory
  const hasTrailingSlash = path.endsWith('/') && path !== '/'

  // Look up the entry
  const entry = storage.get(normalizedPath)

  if (!entry) {
    return false
  }

  // If path had trailing slash but entry is not a directory, return false
  if (hasTrailingSlash && entry.type !== 'directory' && entry.type !== 'symlink') {
    return false
  }

  // Handle symlinks - exists follows symlinks
  if (entry.type === 'symlink') {
    if (storage.resolveSymlink) {
      const resolved = storage.resolveSymlink(normalizedPath)
      if (!resolved) {
        // Broken symlink - target doesn't exist
        return false
      }
      // If resolved is still a symlink, it's a circular reference that couldn't be resolved
      if (resolved.type === 'symlink') {
        return false
      }
      // If trailing slash was used, verify target is a directory
      if (hasTrailingSlash && resolved.type !== 'directory') {
        return false
      }
      return true
    } else {
      // No resolveSymlink method available, can't follow symlink
      // Return false since we can't verify target exists
      return false
    }
  }

  // Entry exists and is not a symlink
  return true
}
