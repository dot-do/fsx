/**
 * truncate operation
 *
 * Truncate a file to a specified length.
 * If the file is larger, it will be shortened.
 * If the file is smaller, it will be extended with zero bytes.
 */

import { ENOENT, EISDIR, EINVAL } from '../core/errors'

/**
 * Storage interface that truncate operates on
 */
export interface TruncateStorage {
  getFile(path: string): { content: Uint8Array; metadata: { mode: number; mtime: number; birthtime: number; ctime: number } } | undefined
  addFile(path: string, content: Uint8Array, metadata?: { mode?: number; birthtime?: number }): void
  isDirectory(path: string): boolean
  updateFile?(path: string, content: Uint8Array): void
}

/**
 * Normalize a path: remove double slashes, resolve . and ..
 */
function normalizePath(path: string): string {
  // Split path into segments and filter out empty ones and '.'
  const segments = path.split('/').filter(s => s !== '' && s !== '.')

  // Process '..' segments
  const result: string[] = []
  for (const segment of segments) {
    if (segment === '..') {
      result.pop()
    } else {
      result.push(segment)
    }
  }

  return '/' + result.join('/')
}

/**
 * Truncate a file to the specified length
 *
 * @param storage - Storage backend
 * @param path - File path
 * @param length - New length in bytes (default: 0)
 * @returns undefined on success
 * @throws ENOENT if file does not exist
 * @throws EISDIR if path is a directory
 * @throws EINVAL if length is negative
 */
export async function truncate(
  storage: TruncateStorage,
  path: string,
  length: number = 0
): Promise<void> {
  const normalizedPath = normalizePath(path)

  // Check for negative length
  if (length < 0) {
    throw new EINVAL('truncate', normalizedPath)
  }

  // Check if path is root directory
  if (normalizedPath === '/') {
    throw new EISDIR('truncate', normalizedPath)
  }

  // Check if path is a directory
  if (storage.isDirectory(normalizedPath)) {
    throw new EISDIR('truncate', normalizedPath)
  }

  // Get the existing file
  const existingFile = storage.getFile(normalizedPath)
  if (existingFile === undefined) {
    throw new ENOENT('truncate', normalizedPath)
  }

  const currentLength = existingFile.content.length

  // If length is the same, no-op
  if (length === currentLength) {
    return
  }

  let newContent: Uint8Array

  if (length < currentLength) {
    // Truncate: take only the first `length` bytes
    newContent = existingFile.content.slice(0, length)
  } else {
    // Extend: create new array and zero-fill the extension
    newContent = new Uint8Array(length)
    newContent.set(existingFile.content)
    // The rest is already zero-filled by default in Uint8Array
  }

  // Update the file with new content, preserving birthtime and mode
  storage.addFile(normalizedPath, newContent, {
    mode: existingFile.metadata.mode,
    birthtime: existingFile.metadata.birthtime,
  })
}
