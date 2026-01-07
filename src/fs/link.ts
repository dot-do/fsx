/**
 * Hard link creation (POSIX link syscall)
 *
 * Creates a hard link to an existing file. Both paths will refer to the same
 * inode, sharing the same content and metadata.
 *
 * Constraints:
 * - Cannot hard link directories (EPERM)
 * - Source must exist (ENOENT)
 * - Destination must not exist (EEXIST)
 * - Destination parent directory must exist (ENOENT)
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { ENOENT, EEXIST, EPERM } from '../core/errors'

/**
 * Filesystem context interface for link operations
 */
export interface LinkFS {
  files: Map<string, { ino: number; content: Uint8Array; nlink: number; isDirectory: boolean }>
  inodes: Map<number, { content: Uint8Array; nlink: number; isDirectory: boolean }>
  exists(path: string): boolean
}

/**
 * Create a hard link
 *
 * @param fs - Filesystem context
 * @param existingPath - Path to the existing file
 * @param newPath - Path for the new hard link
 * @throws {ENOENT} If existingPath does not exist or newPath parent does not exist
 * @throws {EEXIST} If newPath already exists
 * @throws {EPERM} If existingPath is a directory
 */
export async function link(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  fs: LinkFS,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  existingPath: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  newPath: string
): Promise<void> {
  // TODO: Implement in GREEN phase
  throw new Error('Not implemented')
}
