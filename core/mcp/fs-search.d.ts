/**
 * fs_search MCP Tool - Glob Pattern File Search
 *
 * Provides glob pattern file search functionality for AI-assisted file operations
 * via the Model Context Protocol (MCP).
 *
 * ## Features
 *
 * - Glob pattern matching with support for `*`, `**`, `?`, `[abc]`, `{a,b,c}`
 * - Recursive directory traversal
 * - Exclude patterns for filtering results
 * - Content search (grep-like) with match counting
 * - Depth limiting for controlled traversal
 * - Hidden file handling
 * - Result limiting for large directories
 *
 * ## Performance Optimizations
 *
 * 1. **Pattern pre-compilation**: Uses `createMatcher()` to compile patterns once
 * 2. **Early termination**: Stops traversal when limit is reached
 * 3. **Exclude pattern short-circuit**: Skips excluded paths without full traversal
 * 4. **Lazy content search**: Only reads file content when pattern matches
 *
 * @module core/mcp/fs-search
 */
/**
 * MCP tool result format.
 *
 * Standard response format for MCP tool invocations containing
 * either text or image content with optional error status.
 */
export interface McpToolResult {
    /** Array of content items (text or image) */
    content: Array<{
        type: 'text';
        text: string;
    } | {
        type: 'image';
        data: string;
        mimeType: string;
    }>;
    /** Whether the result represents an error */
    isError?: boolean;
}
/**
 * Options for the fs_search tool.
 *
 * All options except `pattern` are optional with sensible defaults.
 *
 * @example Basic search
 * ```typescript
 * const options: FsSearchOptions = {
 *   pattern: '**\/*.ts',
 *   path: '/src',
 * }
 * ```
 *
 * @example Advanced search with content filtering
 * ```typescript
 * const options: FsSearchOptions = {
 *   pattern: '**\/*.ts',
 *   path: '/src',
 *   exclude: ['node_modules', 'dist'],
 *   maxDepth: 3,
 *   showHidden: false,
 *   limit: 100,
 *   contentSearch: 'TODO',
 *   caseSensitive: false,
 * }
 * ```
 */
export interface FsSearchOptions {
    /**
     * Glob pattern to match files against.
     *
     * Supports standard glob syntax:
     * - `*` matches any characters except path separator
     * - `**` matches any characters including path separator (recursive)
     * - `?` matches a single character
     * - `[abc]` matches any character in the set
     * - `{a,b,c}` matches any of the alternatives
     *
     * @example
     * ```typescript
     * '*.ts'           // TypeScript files in current directory
     * '**\/*.ts'       // TypeScript files recursively
     * 'src/**\/*.{ts,tsx}'  // TS/TSX files in src
     * '[A-Z]*.ts'      // Files starting with uppercase
     * ```
     */
    pattern: string;
    /**
     * Base directory to search in.
     * @default '/'
     */
    path?: string;
    /**
     * Patterns to exclude from results.
     *
     * Matches are checked against both full relative paths and
     * individual path segments.
     *
     * @example
     * ```typescript
     * ['node_modules', '.git', 'dist']
     * ['**\/*.test.ts']  // Exclude test files
     * ```
     */
    exclude?: string[];
    /**
     * Maximum depth to traverse (0 = only files in path directory).
     * @default Infinity
     */
    maxDepth?: number;
    /**
     * Whether to include hidden files (starting with `.`).
     * @default false
     */
    showHidden?: boolean;
    /**
     * Maximum number of results to return.
     * @default Infinity
     */
    limit?: number;
    /**
     * Search within file contents (grep-like functionality).
     *
     * When specified, only files containing this string will be
     * included in results, with match count displayed.
     */
    contentSearch?: string;
    /**
     * Whether content search is case-sensitive.
     * @default true
     */
    caseSensitive?: boolean;
}
/**
 * Individual search result item.
 *
 * Contains information about a matched file or directory.
 */
export interface SearchResultItem {
    /** Full absolute path to the entry */
    path: string;
    /** Type of filesystem entry */
    type: 'file' | 'directory' | 'symlink';
    /** File size in bytes (0 for directories) */
    size?: number;
    /** Number of content matches (only for content search) */
    matches?: number;
}
/**
 * Storage backend interface for filesystem operations.
 *
 * This abstraction allows the search tool to work with both
 * real filesystems and in-memory test fixtures.
 */
export interface StorageBackend {
    /** Check if a path exists */
    has(path: string): boolean;
    /** Check if path is a directory */
    isDirectory(path: string): boolean;
    /** Get children of a directory (names only) */
    getChildren(path: string): string[];
    /** Get entry metadata */
    get(path: string): {
        type: 'file' | 'directory' | 'symlink';
        content: Uint8Array;
    } | undefined;
}
/**
 * Normalize a filesystem path.
 *
 * Removes trailing slashes (except for root) and collapses
 * multiple consecutive slashes.
 *
 * @param path - Path to normalize
 * @returns Normalized path
 *
 * @example
 * ```typescript
 * normalizePath('/foo//bar/')  // '/foo/bar'
 * normalizePath('/')           // '/'
 * normalizePath('')            // '/'
 * ```
 */
export declare function normalizePath(path: string): string;
/**
 * Get relative path from base to path.
 *
 * Returns the portion of `path` that comes after `base`.
 *
 * @param path - Target path
 * @param base - Base path to remove
 * @returns Relative path
 *
 * @example
 * ```typescript
 * getRelativePath('/home/user/foo', '/home/user')  // 'foo'
 * getRelativePath('/foo/bar', '/')                 // 'foo/bar'
 * ```
 */
export declare function getRelativePath(path: string, base: string): string;
/**
 * Check if a path should be excluded based on exclude patterns.
 *
 * Checks both the full relative path and individual path segments
 * against each exclude pattern.
 *
 * @param relativePath - Relative path to check
 * @param excludePatterns - Array of glob patterns to exclude
 * @returns True if the path should be excluded
 *
 * @example
 * ```typescript
 * shouldExclude('node_modules/lodash/index.js', ['node_modules'])  // true
 * shouldExclude('src/index.ts', ['**\/*.test.ts'])                 // false
 * ```
 */
export declare function shouldExclude(relativePath: string, excludePatterns: string[]): boolean;
/**
 * Count occurrences of a search term in content.
 *
 * Performs a non-overlapping count of substring matches.
 *
 * @param content - Text content to search
 * @param searchTerm - Term to search for
 * @param caseSensitive - Whether search is case-sensitive
 * @returns Number of matches found
 *
 * @example
 * ```typescript
 * countContentMatches('hello hello world', 'hello', true)   // 2
 * countContentMatches('HELLO hello', 'hello', false)        // 2
 * ```
 */
export declare function countContentMatches(content: string, searchTerm: string, caseSensitive: boolean): number;
/**
 * Recursively search a directory for matching files.
 *
 * This function performs depth-first traversal with early termination
 * when the result limit is reached. Pattern matching is optimized
 * using pre-compiled matchers.
 *
 * @param storage - Storage backend to search
 * @param dirPath - Current directory path
 * @param basePath - Base path for relative path calculation
 * @param options - Search options
 * @param results - Results array to populate (mutated)
 * @param currentDepth - Current traversal depth
 *
 * @internal
 */
export declare function searchDirectory(storage: StorageBackend, dirPath: string, basePath: string, options: FsSearchOptions, results: SearchResultItem[], currentDepth: number): void;
/**
 * Invoke the fs_search MCP tool.
 *
 * Searches for files matching a glob pattern with optional content search.
 * This is the main entry point for MCP tool invocation.
 *
 * ## Performance Characteristics
 *
 * - **Pattern compilation**: O(n) one-time cost, then O(m) per path
 * - **Directory traversal**: O(total_entries) in search path
 * - **Content search**: O(file_size) per matching file
 * - **Memory**: O(results_count) for result storage
 *
 * @param params - MCP tool parameters (see FsSearchOptions)
 * @param storage - Storage backend to search
 * @returns MCP tool result with search results or error
 *
 * @example
 * ```typescript
 * // Search for TypeScript files
 * const result = await invokeFsSearch(
 *   { pattern: '**\/*.ts', path: '/src' },
 *   storage
 * )
 *
 * // Search with content filter
 * const result = await invokeFsSearch(
 *   {
 *     pattern: '**\/*.ts',
 *     path: '/src',
 *     contentSearch: 'TODO',
 *     caseSensitive: false,
 *   },
 *   storage
 * )
 * ```
 */
export declare function invokeFsSearch(params: Record<string, unknown>, storage: StorageBackend): Promise<McpToolResult>;
/**
 * MCP tool schema definition for fs_search.
 *
 * This schema describes the tool's interface for MCP registration.
 */
export declare const fsSearchToolSchema: {
    readonly name: "fs_search";
    readonly description: "Search for files matching a glob pattern with optional content search";
    readonly inputSchema: {
        readonly type: "object";
        readonly properties: {
            readonly pattern: {
                readonly type: "string";
                readonly description: "Glob pattern to match files (e.g., \"**/*.ts\", \"*.json\")";
            };
            readonly path: {
                readonly type: "string";
                readonly description: "Base directory to search in (default: \"/\")";
            };
            readonly exclude: {
                readonly type: "array";
                readonly description: "Patterns to exclude from results (e.g., [\"node_modules\", \".git\"])";
            };
            readonly maxDepth: {
                readonly type: "number";
                readonly description: "Maximum directory depth to search (0 = current dir only)";
            };
            readonly showHidden: {
                readonly type: "boolean";
                readonly description: "Include hidden files and directories (default: false)";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Maximum number of results to return";
            };
            readonly contentSearch: {
                readonly type: "string";
                readonly description: "Search within file contents (grep-like)";
            };
            readonly caseSensitive: {
                readonly type: "boolean";
                readonly description: "Case-sensitive content search (default: true)";
            };
        };
        readonly required: readonly ["pattern"];
    };
};
//# sourceMappingURL=fs-search.d.ts.map