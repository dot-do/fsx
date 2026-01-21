/**
 * Git Object Format Implementation
 *
 * Git objects are stored with a header format: `<type> <size>\0<content>`
 * Valid types: blob, tree, commit, tag
 *
 * @module
 */

/**
 * Valid git object types as a readonly tuple.
 * Use `GitObjectType` for the union type.
 */
export declare const VALID_TYPES: readonly ["blob", "tree", "commit", "tag"];

/**
 * Git object type union: 'blob' | 'tree' | 'commit' | 'tag'
 */
export type GitObjectType = (typeof VALID_TYPES)[number];
/**
 * Create a git object header: `<type> <size>\0`
 *
 * @param type - The object type (blob, tree, commit, or tag)
 * @param size - The size of the content in bytes
 * @returns Binary header with null terminator
 */
export declare function createHeader(type: string, size: number): Uint8Array;
/**
 * Parse a git object header from data.
 * Returns the type, size, and offset where content begins.
 *
 * @param data - Binary data containing a git object header
 * @returns Object with type, size, and contentOffset
 * @throws Error if the header is malformed or missing null terminator
 */
export declare function parseHeader(data: Uint8Array): {
    type: string;
    size: number;
    contentOffset: number;
};
/**
 * Create a full git object (header + content).
 *
 * @param type - The object type (blob, tree, commit, or tag)
 * @param content - The object content as binary data
 * @returns Complete git object with header and content
 */
export declare function createGitObject(type: string, content: Uint8Array): Uint8Array;
/**
 * Parse a full git object and return type and content.
 *
 * @param data - Binary data containing a complete git object
 * @returns Object with type and content
 * @throws Error if the object is malformed
 */
export declare function parseGitObject(data: Uint8Array): {
    type: string;
    content: Uint8Array;
};
//# sourceMappingURL=git-object.d.ts.map