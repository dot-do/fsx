/**
 * CAS Path Mapping Functions
 *
 * Maps between content hashes and file paths in the content-addressable storage.
 * Uses git-style object storage: objects/xx/yyyy... where xx is first 2 hex chars.
 *
 * Supports both SHA-1 (40 char) and SHA-256 (64 char) hashes.
 */
/**
 * Options for path mapping configuration
 */
export interface PathMappingOptions {
    /** Base directory for object storage (default: 'objects') */
    baseDir?: string;
    /** Number of characters to use for the prefix directory (default: 2, range: 1-8) */
    prefixLen?: number;
}
/**
 * Validate that a hash is valid (correct length and hex characters)
 * @param hash - The hash string to validate
 * @returns true if valid, false otherwise
 */
export declare function isValidHash(hash: string): boolean;
/**
 * Validate that a path is a valid CAS object path
 * @param path - The path to validate
 * @param options - Path mapping options
 * @returns true if valid, false otherwise
 */
export declare function isValidPath(path: string, options?: PathMappingOptions): boolean;
/**
 * Convert a hash to a storage path
 * @param hash - 40 or 64 character hex string (SHA-1 or SHA-256)
 * @param options - Path mapping options
 * @returns Path in format: baseDir/xx.../yyyy...
 */
export declare function hashToPath(hash: string, options?: PathMappingOptions): string;
/**
 * Extract a hash from a storage path
 * @param path - Path in format: baseDir/xx.../yyyy...
 * @param options - Path mapping options
 * @returns Lowercase hex hash string
 */
export declare function pathToHash(path: string, options?: PathMappingOptions): string;
/**
 * PathMapper interface for factory-created mappers
 */
export interface PathMapper {
    /** Convert hash to path using the configured options */
    hashToPath(hash: string): string;
    /** Convert path to hash using the configured options */
    pathToHash(path: string): string;
    /** The options used to create this mapper */
    options: Required<PathMappingOptions>;
}
/**
 * Create a path mapper with pre-configured options
 * @param options - Path mapping options
 * @returns PathMapper with bound options
 */
export declare function createPathMapper(options?: PathMappingOptions): PathMapper;
//# sourceMappingURL=path-mapping.d.ts.map