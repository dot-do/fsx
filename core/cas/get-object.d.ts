/**
 * Get object from Content-Addressable Storage
 *
 * Retrieves a git object by its hash:
 * 1. Converts hash to path using hashToPath()
 * 2. Reads compressed data from storage
 * 3. Decompresses with zlib
 * 4. Parses git object format to extract type and content
 * 5. Returns { type: string, content: Uint8Array }
 */
/**
 * Result of retrieving a git object
 */
export interface GitObject {
    type: string;
    content: Uint8Array;
}
/**
 * Storage interface for reading objects
 *
 * This is the minimal interface required to retrieve objects from storage.
 * Implementations can use R2, local filesystem, memory, or any other backend.
 */
export interface GetObjectStorage {
    /**
     * Read data from a path
     * @param path - Storage path (e.g., 'objects/ab/cdef...')
     * @returns Object with data, or null if not found
     */
    get(path: string): Promise<{
        data: Uint8Array;
    } | null>;
}
/**
 * Retrieve a git object from storage by its hash
 *
 * @param hash - SHA-1 (40 char) or SHA-256 (64 char) hash
 * @param storage - Storage backend implementing GetObjectStorage interface
 * @returns The git object with type and content
 * @throws ENOENT if object doesn't exist
 * @throws Error if data is corrupted or invalid format
 */
export declare function getObject(hash: string, storage: GetObjectStorage): Promise<GitObject>;
//# sourceMappingURL=get-object.d.ts.map