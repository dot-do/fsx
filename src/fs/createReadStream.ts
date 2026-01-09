import type { BufferEncoding } from '../core/types'
import { ENOENT, EISDIR, EINVAL } from '../core/errors'

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

/** Default chunk size: 64KB */
const DEFAULT_HIGH_WATER_MARK = 64 * 1024

/**
 * Normalize a file path by resolving . and .. components and removing double slashes
 */
function normalizePath(path: string): string {
  // Split path into segments, filtering empty strings (from double slashes)
  const segments = path.split('/').filter((s) => s !== '')
  const result: string[] = []

  for (const segment of segments) {
    if (segment === '.') {
      // Current directory, skip
      continue
    } else if (segment === '..') {
      // Parent directory, go up
      result.pop()
    } else {
      result.push(segment)
    }
  }

  return '/' + result.join('/')
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
 * @throws {EINVAL} If start > end or path is relative
 */
export async function createReadStream(
  path: string,
  options?: ReadStreamOptions
): Promise<ReadableStream<Uint8Array>> {
  // Validate absolute path
  if (!path.startsWith('/')) {
    throw new EINVAL('createReadStream', path)
  }

  // Check for pre-aborted signal
  if (options?.signal?.aborted) {
    const error = new Error('The operation was aborted')
    error.name = 'AbortError'
    throw error
  }

  // Normalize path to handle //, ., and ..
  const normalizedPath = normalizePath(path)

  // Get entry from storage
  if (!storage) {
    throw new ENOENT('open', normalizedPath)
  }

  const entry = storage.get(normalizedPath)
  if (!entry) {
    throw new ENOENT('open', normalizedPath)
  }

  if (entry.isDirectory) {
    throw new EISDIR('read', normalizedPath)
  }

  // Parse options
  const start = options?.start ?? 0
  const fileEnd = entry.content.length - 1
  // If end is beyond file size, clamp to file end
  const end = options?.end !== undefined ? Math.min(options.end, fileEnd) : fileEnd
  const highWaterMark = options?.highWaterMark ?? DEFAULT_HIGH_WATER_MARK

  // Validate range
  if (start > end && entry.content.length > 0) {
    throw new EINVAL('createReadStream', normalizedPath)
  }

  // Handle empty file case
  if (entry.content.length === 0) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
  }

  // Slice the data for the requested range
  const data = entry.content.slice(start, end + 1)
  let offset = 0
  const signal = options?.signal

  // Create ReadableStream with pull-based chunking for proper backpressure
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      // Check abort signal
      if (signal?.aborted) {
        controller.close()
        return
      }

      // Check if we've read all data
      if (offset >= data.length) {
        controller.close()
        return
      }

      // Read next chunk
      const chunk = data.slice(offset, offset + highWaterMark)
      offset += chunk.length
      controller.enqueue(chunk)
    },

    cancel() {
      // Clean up on cancel - nothing specific needed for in-memory data
    },
  })
}
