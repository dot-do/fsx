/**
 * Store a git object in content-addressable storage
 *
 * This function:
 * 1. Creates a git object: `<type> <content.length>\0<content>`
 * 2. Computes SHA-1 hash of the uncompressed git object
 * 3. Compresses the git object with zlib
 * 4. Writes to `objects/xx/yyyy...` path (first 2 chars as directory)
 * 5. Returns the 40-character hex hash
 */

import type { GitObjectType } from './git-object'
import { createGitObject } from './git-object'
import { sha1 } from './hash'
import { compress } from './compression'
import { hashToPath } from './path-mapping'

const VALID_TYPES = ['blob', 'tree', 'commit', 'tag'] as const

/**
 * Storage interface for writing objects
 */
export interface ObjectStorage {
  write(path: string, data: Uint8Array): Promise<void>
  exists(path: string): Promise<boolean>
  /**
   * Optional atomic write-if-absent operation.
   * If implemented, this should atomically check for existence and write.
   * Returns true if the write was performed, false if the path already exists.
   *
   * When not implemented, the default check-then-write pattern is used with
   * in-memory coordination to prevent race conditions.
   */
  writeIfAbsent?(path: string, data: Uint8Array): Promise<boolean>
}

/**
 * In-flight write coordination for preventing race conditions.
 * Maps path -> Promise that resolves when the write completes.
 * This ensures that concurrent writes to the same path are serialized.
 * @internal
 */
const inFlightWrites = new Map<string, Promise<void>>()

/**
 * Input item for batch putObject operation
 */
export interface BatchPutItem {
  /** Object content as Uint8Array */
  content: Uint8Array
  /** Git object type: 'blob', 'tree', 'commit', or 'tag' */
  type: string
}

/**
 * Result of a single item in batch putObject operation
 */
export interface BatchPutResult {
  /** 40-character lowercase hex SHA-1 hash */
  hash: string
  /** Whether the object was newly written (false if deduplicated) */
  written: boolean
  /** Index of this item in the original batch */
  index: number
}

/**
 * Progress callback for batch operations
 */
export interface BatchProgress {
  /** Number of items processed so far */
  processed: number
  /** Total number of items */
  total: number
  /** Hash of the most recently processed item */
  currentHash: string
  /** Whether the most recent item was written (false if deduplicated) */
  currentWritten: boolean
}

/**
 * Options for batch putObject operation
 */
export interface BatchPutOptions {
  /** Maximum number of concurrent writes (default: 10) */
  concurrency?: number
  /** Progress callback invoked after each item is processed */
  onProgress?: (progress: BatchProgress) => void
}

/**
 * Store a git object and return its content hash
 *
 * This function handles concurrent writes safely using one of two strategies:
 * 1. If storage implements writeIfAbsent, uses atomic check-and-write
 * 2. Otherwise, uses in-memory coordination to serialize writes to same path
 *
 * @param storage - Storage backend to write to
 * @param type - Object type: 'blob', 'tree', 'commit', or 'tag'
 * @param content - Object content as Uint8Array
 * @returns 40-character lowercase hex SHA-1 hash
 */
export async function putObject(
  storage: ObjectStorage,
  type: string,
  content: Uint8Array
): Promise<string> {
  // Validate type: non-empty, no spaces, no null bytes, must be valid git type
  if (!type || type.includes(' ') || type.includes('\0')) {
    throw new Error('Invalid type: type must be non-empty and not contain spaces or null bytes')
  }

  if (!VALID_TYPES.includes(type as GitObjectType)) {
    throw new Error(`Invalid type: must be one of ${VALID_TYPES.join(', ')}`)
  }

  // Create the git object (header + content)
  const gitObject = createGitObject(type, content)

  // Compute SHA-1 hash of the uncompressed git object
  const hash = await sha1(gitObject)

  // Get the storage path from the hash
  const path = hashToPath(hash)

  // Use atomic writeIfAbsent if available
  if (storage.writeIfAbsent) {
    // Compress the git object with zlib
    const compressedData = await compress(gitObject)
    // Atomic write - returns false if already exists
    await storage.writeIfAbsent(path, compressedData)
    return hash
  }

  // Fallback: use in-memory coordination to prevent race conditions
  // Acquire write lock SYNCHRONOUSLY before any async operations
  const lock = acquireWriteLock(path)

  if (!lock.shouldExecute) {
    // Another write is in progress - wait for it and return
    await lock.waitPromise
    return hash
  }

  // We have the lock - execute the write
  try {
    // Check if object already exists in storage
    const exists = await storage.exists(path)
    if (!exists) {
      // Compress the git object with zlib
      const compressedData = await compress(gitObject)
      // Write the compressed data to storage
      await storage.write(path, compressedData)
    }
    lock.completeWrite!()
  } catch (err) {
    lock.completeWrite!(err as Error)
    throw err
  }

  return hash
}

/**
 * Serialize writes to the same path to prevent race conditions.
 * This function returns a tuple: [shouldExecute, waitPromise]
 * - If shouldExecute is true, the caller should execute the write and then call completeWrite
 * - If shouldExecute is false, the caller should wait on waitPromise (the write is already in progress)
 *
 * This pattern ensures the check-and-register happens SYNCHRONOUSLY to prevent races.
 *
 * @internal
 */
function acquireWriteLock(path: string): { shouldExecute: boolean; waitPromise?: Promise<void>; completeWrite?: (err?: Error) => void } {
  // Check if there's an in-flight write for this path (synchronous check!)
  const existingWrite = inFlightWrites.get(path)
  if (existingWrite) {
    // Another write is in progress - caller should wait
    return { shouldExecute: false, waitPromise: existingWrite }
  }

  // Create a deferred promise for this write operation
  let resolveWrite!: () => void
  let rejectWrite!: (err: Error) => void
  const writePromise = new Promise<void>((resolve, reject) => {
    resolveWrite = resolve
    rejectWrite = reject
  })

  // Register SYNCHRONOUSLY before returning to prevent races
  inFlightWrites.set(path, writePromise)

  // Return a completeWrite function for the caller to signal completion
  const completeWrite = (err?: Error) => {
    inFlightWrites.delete(path)
    if (err) {
      rejectWrite(err)
    } else {
      resolveWrite()
    }
  }

  return { shouldExecute: true, completeWrite }
}

/**
 * Prepare a git object for storage without writing
 *
 * This is an internal helper that computes the hash and prepares
 * compressed data, enabling parallel processing in batch operations.
 *
 * @internal
 */
async function prepareObject(
  type: string,
  content: Uint8Array
): Promise<{ hash: string; path: string; compressedData: Uint8Array }> {
  // Validate type: non-empty, no spaces, no null bytes, must be valid git type
  if (!type || type.includes(' ') || type.includes('\0')) {
    throw new Error('Invalid type: type must be non-empty and not contain spaces or null bytes')
  }

  if (!VALID_TYPES.includes(type as GitObjectType)) {
    throw new Error(`Invalid type: must be one of ${VALID_TYPES.join(', ')}`)
  }

  // Create the git object (header + content)
  const gitObject = createGitObject(type, content)

  // Compute SHA-1 hash of the uncompressed git object
  const hash = await sha1(gitObject)

  // Get the storage path from the hash
  const path = hashToPath(hash)

  // Compress the git object with zlib
  const compressedData = await compress(gitObject)

  return { hash, path, compressedData }
}

/**
 * Store multiple git objects in parallel with progress reporting
 *
 * This function enables efficient batch storage of multiple objects:
 * - Parallelizes hash computation and compression
 * - Deduplicates writes (skips objects that already exist)
 * - Uses in-memory coordination to prevent race conditions on concurrent writes
 * - Reports progress via optional callback
 * - Controls concurrency to prevent resource exhaustion
 *
 * @param storage - Storage backend to write to
 * @param items - Array of objects to store
 * @param options - Configuration for concurrency and progress reporting
 * @returns Array of results with hash and write status for each item
 *
 * @example
 * ```typescript
 * const items = [
 *   { content: new TextEncoder().encode('hello'), type: 'blob' },
 *   { content: new TextEncoder().encode('world'), type: 'blob' },
 *   { content: treeData, type: 'tree' },
 * ]
 *
 * const results = await putObjectBatch(storage, items, {
 *   concurrency: 5,
 *   onProgress: ({ processed, total }) => {
 *     console.log(`Progress: ${processed}/${total}`)
 *   }
 * })
 *
 * results.forEach(r => console.log(`${r.hash}: ${r.written ? 'new' : 'deduped'}`))
 * ```
 */
export async function putObjectBatch(
  storage: ObjectStorage,
  items: BatchPutItem[],
  options: BatchPutOptions = {}
): Promise<BatchPutResult[]> {
  const { concurrency = 10, onProgress } = options

  if (items.length === 0) {
    return []
  }

  // Results array to maintain order
  const results: BatchPutResult[] = new Array(items.length)
  let processed = 0

  // Process items with controlled concurrency
  const processSingle = async (item: BatchPutItem, index: number): Promise<void> => {
    // Prepare the object (hash + compress)
    const { hash, path, compressedData } = await prepareObject(item.type, item.content)

    // Use atomic writeIfAbsent if available
    if (storage.writeIfAbsent) {
      const written = await storage.writeIfAbsent(path, compressedData)
      results[index] = { hash, written, index }
      processed++
      if (onProgress) {
        onProgress({
          processed,
          total: items.length,
          currentHash: hash,
          currentWritten: written,
        })
      }
      return
    }

    // Acquire write lock SYNCHRONOUSLY to prevent race conditions
    const lock = acquireWriteLock(path)

    if (!lock.shouldExecute) {
      // Another write is in progress - wait for it and return
      await lock.waitPromise
      // Object was written by another concurrent operation
      results[index] = { hash, written: false, index }
      processed++
      if (onProgress) {
        onProgress({
          processed,
          total: items.length,
          currentHash: hash,
          currentWritten: false,
        })
      }
      return
    }

    // We have the lock - execute the write
    let written = false
    try {
      // Check if object already exists in storage
      const exists = await storage.exists(path)
      if (!exists) {
        // Write the compressed data to storage
        await storage.write(path, compressedData)
        written = true
      }
      lock.completeWrite!()
    } catch (err) {
      lock.completeWrite!(err as Error)
      throw err
    }

    // Store result
    results[index] = { hash, written, index }

    // Update progress
    processed++
    if (onProgress) {
      onProgress({
        processed,
        total: items.length,
        currentHash: hash,
        currentWritten: written,
      })
    }
  }

  // Process in chunks with controlled concurrency using a pool pattern
  const processChunk = async (startIdx: number, endIdx: number): Promise<void> => {
    const chunkPromises: Promise<void>[] = []
    for (let i = startIdx; i < endIdx && i < items.length; i++) {
      chunkPromises.push(processSingle(items[i]!, i))
    }
    await Promise.all(chunkPromises)
  }

  // Process all items in batches of `concurrency` size
  for (let i = 0; i < items.length; i += concurrency) {
    await processChunk(i, i + concurrency)
  }

  return results
}

/**
 * Clear in-flight writes map.
 * **Only use in tests** to clear state between test cases.
 *
 * @internal
 */
export function __resetInFlightWrites(): void {
  inFlightWrites.clear()
}
