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
import { createGitObject } from './git-object';
import { sha1 } from './hash';
import { compress } from './compression';
import { hashToPath } from './path-mapping';
const VALID_TYPES = ['blob', 'tree', 'commit', 'tag'];
/**
 * Store a git object and return its content hash
 *
 * @param storage - Storage backend to write to
 * @param type - Object type: 'blob', 'tree', 'commit', or 'tag'
 * @param content - Object content as Uint8Array
 * @returns 40-character lowercase hex SHA-1 hash
 */
export async function putObject(storage, type, content) {
    // Validate type: non-empty, no spaces, no null bytes, must be valid git type
    if (!type || type.includes(' ') || type.includes('\0')) {
        throw new Error('Invalid type: type must be non-empty and not contain spaces or null bytes');
    }
    if (!VALID_TYPES.includes(type)) {
        throw new Error(`Invalid type: must be one of ${VALID_TYPES.join(', ')}`);
    }
    // Create the git object (header + content)
    const gitObject = createGitObject(type, content);
    // Compute SHA-1 hash of the uncompressed git object
    const hash = await sha1(gitObject);
    // Get the storage path from the hash
    const path = hashToPath(hash);
    // Deduplication: check if object already exists before writing
    const exists = await storage.exists(path);
    if (exists) {
        // Object already exists, skip write and return existing hash
        return hash;
    }
    // Compress the git object with zlib
    const compressedData = await compress(gitObject);
    // Write the compressed data to storage
    await storage.write(path, compressedData);
    // Return the 40-character hex hash
    return hash;
}
/**
 * Prepare a git object for storage without writing
 *
 * This is an internal helper that computes the hash and prepares
 * compressed data, enabling parallel processing in batch operations.
 *
 * @internal
 */
async function prepareObject(type, content) {
    // Validate type: non-empty, no spaces, no null bytes, must be valid git type
    if (!type || type.includes(' ') || type.includes('\0')) {
        throw new Error('Invalid type: type must be non-empty and not contain spaces or null bytes');
    }
    if (!VALID_TYPES.includes(type)) {
        throw new Error(`Invalid type: must be one of ${VALID_TYPES.join(', ')}`);
    }
    // Create the git object (header + content)
    const gitObject = createGitObject(type, content);
    // Compute SHA-1 hash of the uncompressed git object
    const hash = await sha1(gitObject);
    // Get the storage path from the hash
    const path = hashToPath(hash);
    // Compress the git object with zlib
    const compressedData = await compress(gitObject);
    return { hash, path, compressedData };
}
/**
 * Store multiple git objects in parallel with progress reporting
 *
 * This function enables efficient batch storage of multiple objects:
 * - Parallelizes hash computation and compression
 * - Deduplicates writes (skips objects that already exist)
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
export async function putObjectBatch(storage, items, options = {}) {
    const { concurrency = 10, onProgress } = options;
    if (items.length === 0) {
        return [];
    }
    // Results array to maintain order
    const results = new Array(items.length);
    let processed = 0;
    // Process items with controlled concurrency
    const processSingle = async (item, index) => {
        // Prepare the object (hash + compress)
        const { hash, path, compressedData } = await prepareObject(item.type, item.content);
        // Check if object already exists (deduplication)
        const exists = await storage.exists(path);
        let written = false;
        if (!exists) {
            // Write the compressed data to storage
            await storage.write(path, compressedData);
            written = true;
        }
        // Store result
        results[index] = { hash, written, index };
        // Update progress
        processed++;
        if (onProgress) {
            onProgress({
                processed,
                total: items.length,
                currentHash: hash,
                currentWritten: written,
            });
        }
    };
    // Process in chunks with controlled concurrency using a pool pattern
    const processChunk = async (startIdx, endIdx) => {
        const chunkPromises = [];
        for (let i = startIdx; i < endIdx && i < items.length; i++) {
            chunkPromises.push(processSingle(items[i], i));
        }
        await Promise.all(chunkPromises);
    };
    // Process all items in batches of `concurrency` size
    for (let i = 0; i < items.length; i += concurrency) {
        await processChunk(i, i + concurrency);
    }
    return results;
}
//# sourceMappingURL=put-object.js.map