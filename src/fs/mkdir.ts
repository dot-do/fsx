/**
 * mkdir operation - Create directories in the virtual filesystem
 *
 * This is a stub implementation for the RED phase of TDD.
 * All tests should fail until proper implementation is added.
 */

import { ENOENT, EEXIST, ENOTDIR, EINVAL } from '../core/errors'

/**
 * Options for mkdir operation
 */
export interface MkdirOptions {
  /**
   * File mode (permission bits) for the new directory
   * @default 0o777
   */
  mode?: number | string
  /**
   * Create parent directories as needed (like mkdir -p)
   * @default false
   */
  recursive?: boolean
}

/**
 * Filesystem context interface (to be implemented)
 */
interface FSContext {
  entries: Map<string, { type: 'file' | 'directory'; mode: number }>
}

/**
 * Create a directory
 *
 * @param ctx - Filesystem context
 * @param path - Directory path to create
 * @param options - Optional configuration (mode, recursive)
 * @returns undefined for non-recursive, or first created path for recursive
 * @throws {EEXIST} If path already exists
 * @throws {ENOENT} If parent doesn't exist and recursive is false
 * @throws {ENOTDIR} If a parent component is not a directory
 * @throws {EINVAL} If path is invalid
 */
export async function mkdir(
  ctx: FSContext,
  path: string,
  options?: MkdirOptions
): Promise<string | undefined> {
  // Stub implementation - will fail all tests
  throw new Error('mkdir not implemented')
}
