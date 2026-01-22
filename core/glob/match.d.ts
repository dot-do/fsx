/**
 * Pattern matching for glob patterns
 *
 * This module provides functions for matching file paths against glob patterns.
 * Supports standard glob syntax: *, **, ?, [abc], [a-z], [!abc], {a,b,c}
 *
 * ## Performance Characteristics
 *
 * - **Pattern compilation**: O(n) where n is pattern length
 * - **Pattern cache**: LRU cache with configurable size (default: 1000 entries)
 * - **Simple pattern matching**: O(n) where n is path length (regex-based)
 * - **Globstar matching**: O(m*n) where m is pattern segments, n is path segments
 *   (with memoization to avoid exponential backtracking)
 *
 * ## Optimization Tips
 *
 * 1. Use `createMatcher()` when matching many paths against the same pattern
 * 2. Use `CompiledPatterns` class for batch operations with multiple patterns
 * 3. Prefer non-globstar patterns when possible (** requires segment matching)
 * 4. Pattern cache is automatically used for repeated `match()` calls
 */
/**
 * Options for pattern matching
 */
export interface MatchOptions {
    /** Match dotfiles (files starting with .) - default: false */
    dot?: boolean;
    /** Case insensitive matching - default: false */
    nocase?: boolean;
}
/**
 * Match a path against a glob pattern
 *
 * Uses multiple optimization strategies:
 * 1. **Literal fast-path**: O(1) string comparison for patterns without wildcards
 * 2. **Early termination**: Rejects paths with wrong segment count before matching
 * 3. **Pattern caching**: Compiled patterns are cached in an LRU cache
 * 4. **Pre-compiled regexes**: Segment patterns are compiled once and reused
 *
 * @param pattern - The glob pattern to match against
 * @param path - The path to test
 * @param options - Matching options
 * @returns true if the path matches the pattern
 * @throws Error if pattern is empty
 *
 * @example Basic matching
 * ```typescript
 * match('*.ts', 'foo.ts')             // true
 * match('src/**\/*.ts', 'src/a/b.ts') // true
 * match('[abc].ts', 'a.ts')           // true
 * match('*.{ts,js}', 'foo.js')        // true
 * ```
 *
 * @example Literal patterns (fastest)
 * ```typescript
 * // Exact match - uses O(1) string comparison
 * match('src/index.ts', 'src/index.ts')  // true
 * match('package.json', 'tsconfig.json') // false
 * ```
 *
 * @example With options
 * ```typescript
 * match('*.TS', 'file.ts', { nocase: true })  // true (case-insensitive)
 * match('*', '.hidden', { dot: true })        // true (match dotfiles)
 * ```
 */
export declare function match(pattern: string, path: string, options?: MatchOptions): boolean;
/**
 * Create a reusable matcher function for a pattern
 *
 * More efficient when matching many paths against the same pattern,
 * as the pattern is only parsed once. The returned function includes
 * all optimizations (literal fast-path, early termination, pre-compiled regexes).
 *
 * @param pattern - The glob pattern to compile
 * @param options - Matching options
 * @returns A function that tests paths against the compiled pattern
 * @throws Error if pattern is empty
 *
 * @example Basic usage
 * ```typescript
 * const isTypeScript = createMatcher('**\/*.ts')
 * isTypeScript('src/index.ts')  // true
 * isTypeScript('README.md')     // false
 * ```
 *
 * @example Batch matching
 * ```typescript
 * const isSourceFile = createMatcher('src/**\/*.{ts,tsx}')
 * const sourceFiles = allFiles.filter(isSourceFile)
 * ```
 */
export declare function createMatcher(pattern: string, options?: MatchOptions): (path: string) => boolean;
/**
 * Pre-compiled pattern set for efficient batch matching
 *
 * Use this class when you need to match many paths against multiple patterns,
 * or when patterns are reused frequently. All patterns are compiled once and
 * cached for optimal performance.
 *
 * ## Performance Characteristics
 *
 * - Construction: O(n*m) where n is number of patterns, m is average pattern length
 * - match(): O(p) where p is number of patterns (short-circuits on first match)
 * - matchAll(): O(n*p) where n is number of paths, p is number of patterns
 * - Memory: O(n) for n patterns plus their compiled representations
 *
 * @example
 * ```typescript
 * const patterns = new CompiledPatterns(['*.ts', '*.tsx', 'src/**\/*.js'])
 *
 * // Single path matching
 * patterns.match('index.ts')      // true
 * patterns.match('readme.md')     // false
 *
 * // Batch matching - returns matching paths
 * const files = ['index.ts', 'app.tsx', 'readme.md', 'src/utils.js']
 * patterns.matchAll(files)        // ['index.ts', 'app.tsx', 'src/utils.js']
 *
 * // Get patterns that match a specific path
 * patterns.matchingPatterns('index.ts')  // ['*.ts']
 * ```
 */
export declare class CompiledPatterns {
    private readonly matchers;
    /** Options used for all patterns in this set */
    readonly options: MatchOptions;
    /**
     * Create a new CompiledPatterns instance
     *
     * All patterns are compiled with full optimizations:
     * - Literal fast-path for patterns without wildcards
     * - Early termination based on segment count
     * - Pre-compiled segment regexes
     *
     * @param patterns - Array of glob patterns to compile
     * @param options - Matching options applied to all patterns
     * @throws Error if any pattern is empty
     */
    constructor(patterns: string[], options?: MatchOptions);
    /**
     * Check if a path matches any of the compiled patterns
     *
     * @param path - The path to test
     * @returns true if the path matches any pattern
     */
    match(path: string): boolean;
    /**
     * Filter paths to return only those matching any pattern
     *
     * @param paths - Array of paths to test
     * @returns Array of paths that match at least one pattern
     */
    matchAll(paths: string[]): string[];
    /**
     * Get all patterns that match a given path
     *
     * @param path - The path to test
     * @returns Array of patterns that match the path
     */
    matchingPatterns(path: string): string[];
    /**
     * Get the number of compiled patterns
     */
    get size(): number;
    /**
     * Get all patterns as strings
     */
    get patterns(): string[];
}
/**
 * Clear the global pattern cache
 *
 * Useful for testing or when memory pressure is high.
 * Generally not needed in production as the cache is bounded.
 */
export declare function clearPatternCache(): void;
/**
 * Get the current size of the global pattern cache
 *
 * @returns Number of cached patterns
 */
export declare function getPatternCacheSize(): number;
//# sourceMappingURL=match.d.ts.map