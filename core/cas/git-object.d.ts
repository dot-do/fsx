/**
 * Git Object Format Implementation
 *
 * Git objects are stored with a header format: `<type> <size>\0<content>`
 * Valid types: blob, tree, commit, tag
 *
 * This module provides:
 * - Header creation and parsing with strict validation
 * - Full git object encoding/decoding
 * - Type guards for runtime type checking
 * - Detailed error messages for debugging malformed objects
 */
/**
 * Valid git object types
 */
export declare const VALID_TYPES: readonly ["blob", "tree", "commit", "tag"];
/**
 * Git object type - one of: blob, tree, commit, tag
 */
export type GitObjectType = (typeof VALID_TYPES)[number];
/**
 * Parsed git object header information
 */
export interface GitObjectHeader {
    /** Git object type: blob, tree, commit, or tag */
    type: GitObjectType;
    /** Content size in bytes as declared in header */
    size: number;
    /** Byte offset where content begins (after null byte) */
    contentOffset: number;
}
/**
 * Parsed git object with type and content
 */
export interface ParsedGitObject {
    /** Git object type: blob, tree, commit, or tag */
    type: GitObjectType;
    /** Raw object content (without header) */
    content: Uint8Array;
}
/**
 * Error thrown when parsing malformed git objects
 */
export declare class GitObjectFormatError extends Error {
    readonly code: 'EMPTY_DATA' | 'MISSING_NULL_BYTE' | 'MISSING_SPACE' | 'INVALID_TYPE' | 'INVALID_SIZE' | 'SIZE_MISMATCH';
    readonly details?: Record<string, unknown> | undefined;
    constructor(message: string, code: 'EMPTY_DATA' | 'MISSING_NULL_BYTE' | 'MISSING_SPACE' | 'INVALID_TYPE' | 'INVALID_SIZE' | 'SIZE_MISMATCH', details?: Record<string, unknown> | undefined);
}
/**
 * Type guard to check if a string is a valid git object type
 *
 * @param type - String to check
 * @returns true if type is a valid GitObjectType
 *
 * @example
 * ```typescript
 * if (isGitObjectType(unknownType)) {
 *   // TypeScript now knows unknownType is GitObjectType
 *   handleGitObject(unknownType)
 * }
 * ```
 */
export declare function isGitObjectType(type: string): type is GitObjectType;
/**
 * Assert that a value is a valid git object type, throwing if not
 *
 * @param type - String to validate
 * @throws GitObjectFormatError if type is not valid
 *
 * @example
 * ```typescript
 * assertGitObjectType(userInput) // throws if invalid
 * // TypeScript now knows userInput is GitObjectType
 * ```
 */
export declare function assertGitObjectType(type: string): asserts type is GitObjectType;
/**
 * Create a git object header: `<type> <size>\0`
 *
 * @param type - Git object type (blob, tree, commit, or tag)
 * @param size - Content size in bytes (non-negative integer)
 * @returns Encoded header as Uint8Array
 *
 * @example
 * ```typescript
 * const header = createHeader('blob', 5)
 * // Returns: Uint8Array of "blob 5\0"
 * ```
 */
export declare function createHeader(type: string, size: number): Uint8Array;
/**
 * Parse a git object header from data
 *
 * Parses the git object header format: `<type> <size>\0`
 * Uses zero-copy parsing by working directly with byte indices.
 *
 * @param data - Raw git object data (header + content)
 * @returns Parsed header with type, size, and content offset
 * @throws GitObjectFormatError for malformed headers
 *
 * @example
 * ```typescript
 * const data = new Uint8Array([...]) // "blob 5\0hello"
 * const header = parseHeader(data)
 * // { type: 'blob', size: 5, contentOffset: 7 }
 * ```
 */
export declare function parseHeader(data: Uint8Array): GitObjectHeader;
/**
 * Create a full git object (header + content)
 *
 * Combines a git object header with content to create a complete git object.
 * The result can be hashed with SHA-1 to get the object ID.
 *
 * @param type - Git object type (blob, tree, commit, or tag)
 * @param content - Object content as Uint8Array
 * @returns Complete git object as Uint8Array: `<type> <size>\0<content>`
 *
 * @example
 * ```typescript
 * const content = new TextEncoder().encode('hello')
 * const object = createGitObject('blob', content)
 * // Result: Uint8Array of "blob 5\0hello"
 *
 * // Compute the git hash
 * const hash = await sha1(object)
 * ```
 */
export declare function createGitObject(type: string, content: Uint8Array): Uint8Array;
/**
 * Parse a full git object and return type and content
 *
 * Parses a complete git object, validating the header and extracting content.
 * Uses zero-copy where possible by returning a subarray view of the original data.
 *
 * @param data - Complete git object data: `<type> <size>\0<content>`
 * @returns Parsed object with validated type and content
 * @throws GitObjectFormatError for malformed objects or size mismatches
 *
 * @example
 * ```typescript
 * const data = new Uint8Array([...]) // "blob 5\0hello"
 * const obj = parseGitObject(data)
 * console.log(obj.type) // 'blob'
 * console.log(new TextDecoder().decode(obj.content)) // 'hello'
 * ```
 */
export declare function parseGitObject(data: Uint8Array): ParsedGitObject;
//# sourceMappingURL=git-object.d.ts.map