import type { BufferEncoding } from '../core/types'

/**
 * Options for readFile
 */
export interface ReadFileOptions {
  /** File encoding - if null returns Uint8Array, otherwise string */
  encoding?: BufferEncoding | null
  /** File open flag (default: 'r') */
  flag?: string
  /** Abort signal for cancellation */
  signal?: AbortSignal
}

/**
 * Read the entire contents of a file
 *
 * @param path - Path to the file
 * @param options - Encoding or options object
 * @returns File contents as string (with encoding) or Uint8Array (without)
 *
 * @throws {ENOENT} If file does not exist
 * @throws {EISDIR} If path is a directory
 */
export async function readFile(
  path: string,
  options?: ReadFileOptions | BufferEncoding | null
): Promise<string | Uint8Array> {
  // TODO: Implement readFile
  throw new Error('Not implemented')
}
