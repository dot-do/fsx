/**
 * Glob file matching for fsx
 *
 * Finds files matching glob patterns by combining pattern matching
 * with directory traversal.
 *
 * ## Performance Optimizations
 *
 * This module implements several optimizations for efficient file globbing:
 *
 * 1. **Literal Prefix Extraction** - Patterns like `src/utils/*.ts` are analyzed
 *    to extract the literal prefix (`src/utils/`) and start traversal there
 *    instead of from the root, dramatically reducing filesystem operations.
 *
 * 2. **Early Directory Pruning** - During traversal, directories that cannot
 *    possibly match any pattern are skipped entirely. For example, with pattern
 *    `src/**\/*.ts`, directories like `node_modules/` are pruned early.
 *
 * 3. **Depth-Limited Traversal** - When `deep` option is set, traversal stops
 *    at the specified depth without descending further.
 *
 * 4. **Streaming Results** - The `globStream()` generator function yields
 *    results as they're found, enabling memory-efficient processing of
 *    large result sets.
 *
 * 5. **Timeout and Cancellation** - Both `glob()` and `globStream()` support
 *    timeout and AbortSignal for graceful cancellation of long-running operations.
 *
 * ## Usage Examples
 *
 * @example Basic glob
 * ```typescript
 * // Find all TypeScript files
 * const files = await glob('**\/*.ts')
 *
 * // Find files in specific directories
 * const sources = await glob(['src/**\/*.ts', 'lib/**\/*.ts'])
 * ```
 *
 * @example With options
 * ```typescript
 * const files = await glob('**\/*.ts', {
 *   cwd: '/project',
 *   ignore: ['**\/node_modules/**'],
 *   timeout: 5000,
 *   deep: 5,
 * })
 * ```
 *
 * @example Streaming for large result sets
 * ```typescript
 * for await (const file of globStream('**\/*.ts')) {
 *   console.log(file)
 * }
 * ```
 *
 * @module glob
 */
import type { FsBackend } from '../backend';
/**
 * Error thrown when a glob operation times out.
 */
export declare class GlobTimeoutError extends Error {
    /** The pattern(s) that were being matched */
    pattern: string | string[];
    /** Timeout duration in milliseconds */
    timeout: number;
    constructor(pattern: string | string[], timeout: number);
}
/**
 * Error thrown when a glob operation is aborted.
 */
export declare class GlobAbortedError extends Error {
    /** The pattern(s) that were being matched */
    pattern: string | string[];
    constructor(pattern: string | string[]);
}
/**
 * Options for glob file matching.
 *
 * @example
 * ```typescript
 * const options: GlobOptions = {
 *   cwd: '/src',
 *   deep: 3,
 *   ignore: ['node_modules/**'],
 *   timeout: 5000,
 *   backend: myBackend,
 * }
 * ```
 */
export interface GlobOptions {
    /** Base directory for matching (default: '/') */
    cwd?: string;
    /** Include dotfiles - files starting with . (default: false) */
    dot?: boolean;
    /** Patterns to exclude from results */
    ignore?: string[];
    /** Only return files, not directories (default: true) */
    onlyFiles?: boolean;
    /** Only return directories, not files */
    onlyDirectories?: boolean;
    /** Maximum depth to traverse (undefined = unlimited) */
    deep?: number;
    /** Return absolute paths instead of relative (default: false) */
    absolute?: boolean;
    /** Follow symbolic links (default: true) */
    followSymlinks?: boolean;
    /** FsBackend to use for filesystem operations (optional, falls back to mock FS) */
    backend?: FsBackend;
    /**
     * Timeout in milliseconds for the entire glob operation.
     * Set to 0 or undefined for no timeout.
     * @throws {GlobTimeoutError} When timeout is exceeded
     */
    timeout?: number;
    /**
     * AbortSignal for cancelling the glob operation.
     * When aborted, throws GlobAbortedError.
     * @throws {GlobAbortedError} When signal is aborted
     */
    signal?: AbortSignal;
}
/**
 * Find files matching glob patterns.
 *
 * This function searches for files matching one or more glob patterns.
 * It supports:
 * - Single or multiple patterns
 * - Exclusion patterns via `ignore` option
 * - Depth limiting
 * - Timeout and cancellation support
 * - Both real filesystem (via FsBackend) and mock filesystem
 *
 * @param pattern - Single pattern or array of patterns to match
 * @param options - Glob options for filtering and behavior control
 * @returns Promise resolving to array of matching file paths
 * @throws {Error} If cwd does not exist or pattern is empty
 * @throws {GlobTimeoutError} If timeout is exceeded
 * @throws {GlobAbortedError} If signal is aborted
 *
 * @example
 * ```typescript
 * // Find all TypeScript files
 * const files = await glob('**\/*.ts')
 *
 * // Find files in specific directories
 * const sources = await glob(['src/**\/*.ts', 'lib/**\/*.ts'])
 *
 * // Exclude node_modules
 * const filtered = await glob('**\/*.js', { ignore: ['**\/node_modules/**'] })
 *
 * // With timeout
 * const files = await glob('**\/*.ts', { timeout: 5000 })
 *
 * // With abort signal
 * const controller = new AbortController()
 * setTimeout(() => controller.abort(), 2000)
 * const files = await glob('**\/*.ts', { signal: controller.signal })
 * ```
 */
export declare function glob(pattern: string | string[], options?: GlobOptions): Promise<string[]>;
/**
 * Find files matching glob patterns, yielding results as they are found.
 *
 * This is a generator version of `glob()` that yields matching files as they
 * are discovered during traversal. Use this for memory-efficient processing
 * of large result sets.
 *
 * ## Memory Efficiency
 *
 * Unlike `glob()` which collects all results before returning, `globStream()`
 * yields results immediately as they are found. This means:
 *
 * - Memory usage is O(1) instead of O(n) for n results
 * - Processing can begin before traversal completes
 * - Early termination is possible (just stop iterating)
 *
 * ## Caveats
 *
 * - Results are yielded in traversal order, not sorted
 * - Deduplication happens incrementally (maintains a Set internally)
 * - For sorted results, use `glob()` instead
 *
 * @param pattern - Single pattern or array of patterns to match
 * @param options - Glob options for filtering and behavior control
 * @yields Matching file paths as they are found
 * @throws {Error} If cwd does not exist or pattern is empty
 * @throws {GlobTimeoutError} If timeout is exceeded
 * @throws {GlobAbortedError} If signal is aborted
 *
 * @example Basic streaming
 * ```typescript
 * // Process files as they're found (memory efficient)
 * for await (const file of globStream('**\/*.ts')) {
 *   await processFile(file)
 * }
 * ```
 *
 * @example Early termination
 * ```typescript
 * // Stop after finding first 10 matches
 * let count = 0
 * for await (const file of globStream('**\/*.ts')) {
 *   console.log(file)
 *   if (++count >= 10) break
 * }
 * ```
 *
 * @example With abort signal
 * ```typescript
 * const controller = new AbortController()
 * setTimeout(() => controller.abort(), 5000)
 *
 * try {
 *   for await (const file of globStream('**\/*', { signal: controller.signal })) {
 *     await processFile(file)
 *   }
 * } catch (e) {
 *   if (e instanceof GlobAbortedError) {
 *     console.log('Search cancelled')
 *   }
 * }
 * ```
 */
export declare function globStream(pattern: string | string[], options?: GlobOptions): AsyncGenerator<string, void, undefined>;
//# sourceMappingURL=glob.d.ts.map