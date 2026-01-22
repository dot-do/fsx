/**
 * Grep content search for fsx
 *
 * High-performance file content search, similar to Unix grep.
 * Optimized for large files with streaming line-by-line processing,
 * binary file detection, parallel file processing, and early termination.
 *
 * ## Features
 *
 * - **Streaming**: Processes files line-by-line without loading entire file into memory
 * - **Binary Detection**: Automatically skips binary files by checking first N bytes
 * - **Parallel Processing**: Searches multiple files concurrently for better throughput
 * - **Early Termination**: Stops immediately after maxCount matches to save resources
 * - **Context Lines**: Efficiently manages before/after context with circular buffer
 * - **Timeout/Abort**: Supports cancellation via AbortSignal and timeout limits
 *
 * ## Use Cases
 *
 * - Git grep functionality
 * - Searching commit messages
 * - Content-based file discovery
 * - Code search in repositories
 * - Log file analysis
 *
 * @module grep
 */
import type { FsBackend } from '../backend';
/**
 * Error thrown when a grep operation times out.
 *
 * This error is thrown when the grep operation exceeds the specified timeout.
 * The error includes details about the pattern being searched and the timeout
 * duration to help with debugging and logging.
 *
 * @example
 * ```typescript
 * try {
 *   await grep({ pattern: 'TODO', path: '/huge-repo', timeout: 5000 })
 * } catch (e) {
 *   if (e instanceof GrepTimeoutError) {
 *     console.log(`Search for '${e.pattern}' timed out after ${e.timeout}ms`)
 *   }
 * }
 * ```
 */
export declare class GrepTimeoutError extends Error {
    /** The search pattern that was being matched */
    pattern: string | RegExp;
    /** Timeout duration in milliseconds */
    timeout: number;
    constructor(pattern: string | RegExp, timeout: number);
}
/**
 * Error thrown when a grep operation is aborted.
 *
 * This error is thrown when the grep operation is cancelled via an AbortSignal.
 * Useful for implementing cancellation in long-running searches or user-initiated
 * cancellation in UI applications.
 *
 * @example
 * ```typescript
 * const controller = new AbortController()
 *
 * // Cancel after 3 seconds
 * setTimeout(() => controller.abort(), 3000)
 *
 * try {
 *   await grep({ pattern: 'TODO', path: '/', signal: controller.signal })
 * } catch (e) {
 *   if (e instanceof GrepAbortedError) {
 *     console.log('Search was cancelled by user')
 *   }
 * }
 * ```
 */
export declare class GrepAbortedError extends Error {
    /** The search pattern that was being matched */
    pattern: string | RegExp;
    constructor(pattern: string | RegExp);
}
/**
 * Options for grep content search.
 *
 * Provides fine-grained control over search behavior including pattern matching,
 * file filtering, output format, and performance tuning.
 *
 * @example
 * ```typescript
 * // Basic search
 * const options: GrepOptions = {
 *   pattern: 'TODO',
 *   path: '/src',
 * }
 *
 * // Advanced search with all options
 * const options: GrepOptions = {
 *   pattern: /TODO:\s*\w+/,
 *   path: '/src',
 *   recursive: true,
 *   glob: '*.{ts,tsx}',
 *   ignoreCase: true,
 *   before: 2,
 *   after: 2,
 *   maxCount: 10,
 *   timeout: 5000,
 * }
 * ```
 */
export interface GrepOptions {
    /**
     * Search pattern - string for literal match, RegExp for regex.
     *
     * String patterns are escaped and matched literally.
     * RegExp patterns preserve all regex features (groups, lookahead, etc.).
     *
     * @example
     * ```typescript
     * // Literal string match
     * { pattern: 'console.log' }
     *
     * // Regex match
     * { pattern: /function\s+\w+\(/ }
     *
     * // Regex with groups
     * { pattern: /(async\s+)?function\s+(\w+)/ }
     * ```
     */
    pattern: string | RegExp;
    /**
     * File or directory to search (default: '/').
     *
     * Can be a single file path or a directory. When a directory is specified,
     * set `recursive: true` to search subdirectories.
     */
    path?: string;
    /**
     * Search subdirectories recursively (default: false).
     *
     * When false, only searches files directly in the specified path.
     * When true, traverses all subdirectories.
     */
    recursive?: boolean;
    /**
     * Filter files by glob pattern.
     *
     * Supports common glob syntax:
     * - `*.ts` - Match .ts files
     * - `**\/*.ts` - Match .ts files at any depth
     * - `*.{ts,tsx}` - Match .ts or .tsx files
     *
     * @example
     * ```typescript
     * { glob: '*.ts' }         // TypeScript files only
     * { glob: '*.{js,jsx}' }   // JavaScript files
     * { glob: '**\/*.test.ts' } // Test files at any depth
     * ```
     */
    glob?: string;
    /**
     * Case insensitive search (default: false).
     *
     * When true, 'TODO' matches 'todo', 'Todo', 'TODO', etc.
     */
    ignoreCase?: boolean;
    /**
     * Include line numbers in results (default: true).
     *
     * Line numbers are always tracked internally; this option controls
     * whether they're emphasized in the output.
     */
    lineNumbers?: boolean;
    /**
     * Number of context lines before match (like grep -B).
     *
     * Uses a circular buffer for efficient memory usage.
     * Set to 0 or omit to disable before context.
     */
    before?: number;
    /**
     * Number of context lines after match (like grep -A).
     *
     * After context requires reading additional lines after each match.
     * Set to 0 or omit to disable after context.
     */
    after?: number;
    /**
     * Stop after N matches per file (like grep -m).
     *
     * Enables early termination - file processing stops immediately
     * after reaching maxCount matches, improving performance.
     */
    maxCount?: number;
    /**
     * Only return filenames, not match details (like grep -l).
     *
     * When true, returns one entry per matching file with minimal details.
     * Significantly faster for "which files contain X?" queries.
     */
    filesOnly?: boolean;
    /**
     * Return non-matching lines instead (like grep -v).
     *
     * Inverts the match logic - returns lines that do NOT match the pattern.
     */
    invert?: boolean;
    /**
     * Match whole words only (like grep -w).
     *
     * Adds word boundaries (\b) around the pattern.
     * 'help' won't match 'helper' when wordMatch is true.
     */
    wordMatch?: boolean;
    /**
     * FsBackend to use for filesystem operations.
     *
     * When not provided, uses the mock filesystem for testing.
     * Provide a real backend for production use.
     */
    backend?: FsBackend;
    /**
     * Timeout in milliseconds for the entire grep operation.
     *
     * Set to 0 or undefined for no timeout. Checked periodically during
     * file processing (approximately every 100 lines).
     *
     * @throws {GrepTimeoutError} When timeout is exceeded
     */
    timeout?: number;
    /**
     * AbortSignal for cancelling the grep operation.
     *
     * When the signal is aborted, throws GrepAbortedError.
     * Useful for implementing cancel buttons in UIs.
     *
     * @throws {GrepAbortedError} When signal is aborted
     */
    signal?: AbortSignal;
}
/**
 * A single match found by grep.
 *
 * Contains all information about a match including location,
 * matched text, and optional context lines.
 */
export interface GrepMatch {
    /** File path where match was found */
    file: string;
    /** Line number (1-indexed) */
    line: number;
    /** Column position within the line (1-indexed) */
    column: number;
    /** Full line content containing the match */
    content: string;
    /** The actual matched text */
    match: string;
    /** Context lines before the match (if requested via `before` option) */
    before?: string[];
    /** Context lines after the match (if requested via `after` option) */
    after?: string[];
}
/**
 * Result of a grep search operation.
 *
 * Contains all matches found plus summary statistics.
 */
export interface GrepResult {
    /** All matches found across all files */
    matches: GrepMatch[];
    /** Number of unique files that contained at least one match */
    fileCount: number;
    /** Total number of matches across all files */
    matchCount: number;
}
/**
 * Search file contents for a pattern.
 *
 * High-performance grep implementation optimized for large files with:
 *
 * - **Streaming processing**: Processes lines sequentially without loading
 *   entire file into memory for context operations
 * - **Early termination**: Stops immediately when maxCount or filesOnly
 *   conditions are met
 * - **Parallel file processing**: When using a backend, files can be
 *   processed concurrently for better throughput
 * - **Binary detection**: Automatically skips binary files when using
 *   a real filesystem backend
 * - **Timeout/abort support**: Checked every 100 lines for responsiveness
 *
 * @param options - Search options including pattern and path
 * @returns Search results with matches and statistics
 * @throws {Error} If path does not exist
 * @throws {GrepTimeoutError} If timeout is exceeded
 * @throws {GrepAbortedError} If abort signal is triggered
 *
 * @example
 * ```typescript
 * // Basic search for a string
 * const result = await grep({ pattern: 'TODO' })
 *
 * // Search with regex in specific directory
 * const result = await grep({
 *   pattern: /function\s+\w+/,
 *   path: '/src',
 *   recursive: true
 * })
 *
 * // Get only filenames containing matches (fast)
 * const files = await grep({
 *   pattern: 'import',
 *   path: '/src',
 *   recursive: true,
 *   filesOnly: true
 * })
 *
 * // Search with context lines
 * const result = await grep({
 *   pattern: 'error',
 *   before: 2,
 *   after: 2,
 *   ignoreCase: true
 * })
 *
 * // Search with timeout
 * const result = await grep({
 *   pattern: 'needle',
 *   path: '/huge-repo',
 *   recursive: true,
 *   timeout: 5000  // 5 second timeout
 * })
 *
 * // Search with abort support
 * const controller = new AbortController()
 * setTimeout(() => controller.abort(), 3000)
 * const result = await grep({
 *   pattern: 'needle',
 *   signal: controller.signal
 * })
 * ```
 */
export declare function grep(options: GrepOptions): Promise<GrepResult>;
//# sourceMappingURL=grep.d.ts.map