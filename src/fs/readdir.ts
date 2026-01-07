/**
 * readdir - Read directory contents
 *
 * This is a stub file for the RED phase of TDD.
 * Implementation will be added in the GREEN phase.
 */

import type { Dirent, ReaddirOptions } from '../core/types'

/**
 * Read the contents of a directory
 *
 * @param path - Path to the directory
 * @param options - Optional settings for the operation
 * @returns Array of filenames or Dirent objects
 */
export async function readdir(path: string): Promise<string[]>
export async function readdir(path: string, options: ReaddirOptions & { withFileTypes: true }): Promise<Dirent[]>
export async function readdir(path: string, options: ReaddirOptions & { withFileTypes?: false }): Promise<string[]>
export async function readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]>
export async function readdir(
  path: string,
  options?: ReaddirOptions
): Promise<string[] | Dirent[]> {
  // TODO: Implement in GREEN phase
  throw new Error('Not implemented')
}
