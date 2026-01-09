import type { BufferEncoding } from '../core/types'

/**
 * Options for createReadStream
 */
export interface ReadStreamOptions {
  /** Start byte position (inclusive), default: 0 */
  start?: number
  /** End byte position (inclusive), default: file size - 1 */
  end?: number
  /** Chunk size in bytes, default: 64KB */
  highWaterMark?: number
  /** Character encoding for text mode (null for binary) */
  encoding?: BufferEncoding | null
  /** Abort signal for cancellation */
  signal?: AbortSignal
}

/**
 * Storage interface for createReadStream
 */
export interface CreateReadStreamStorage {
  get(path: string): { content: Uint8Array; isDirectory: boolean } | undefined
  has(path: string): boolean
}

// Module-level storage that can be set for testing
let storage: CreateReadStreamStorage | null = null

/**
 * Set the storage backend for createReadStream
 * Used primarily for testing
 */
export function setStorage(s: CreateReadStreamStorage | null): void {
  storage = s
}

/**
 * Get the current storage backend
 */
export function getStorage(): CreateReadStreamStorage | null {
  return storage
}

/**
 * Create a readable stream for a file
 *
 * @param path - Path to the file
 * @param options - Stream options (start, end, highWaterMark, signal)
 * @returns A ReadableStream of Uint8Array chunks
 *
 * @throws {ENOENT} If file does not exist
 * @throws {EISDIR} If path is a directory
 * @throws {EINVAL} If start > end
 */
export async function createReadStream(
  path: string,
  options?: ReadStreamOptions
): Promise<ReadableStream<Uint8Array>> {
  // TODO: Implement createReadStream
  // This is a stub for RED phase TDD - implementation comes in GREEN phase
  throw new Error('createReadStream not implemented')
}
