/**
 * Statistics for pattern cache performance monitoring
 */
export interface PatternCacheStats {
    /** Number of cache hits */
    hits: number;
    /** Number of cache misses */
    misses: number;
    /** Current number of cached entries */
    size: number;
    /** Maximum cache capacity */
    capacity: number;
    /** Cache hit rate (0.0 - 1.0) */
    hitRate: number;
}
/**
 * Get the global pattern cache statistics
 *
 * Use this to monitor cache performance and tune cache size.
 *
 * @returns Current cache statistics
 *
 * @example
 * ```typescript
 * const stats = getPatternCacheStats()
 * console.log(`Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`)
 * console.log(`Cache size: ${stats.size}/${stats.capacity}`)
 * ```
 */
export declare function getPatternCacheStats(): PatternCacheStats;
/**
 * Reset the global pattern cache statistics
 *
 * Useful for benchmarking or periodic monitoring.
 */
export declare function resetPatternCacheStats(): void;
/**
 * Clear the global pattern cache
 *
 * Use when patterns change or to free memory.
 */
export declare function clearPatternCache(): void;
/**
 * Configure the global pattern cache
 *
 * Note: This creates a new cache, losing any cached entries.
 *
 * @param capacity - New maximum cache capacity
 */
export declare function configurePatternCache(capacity: number): void;
/**
 * Parsed pattern structure for glob matching
 *
 * Supports gitignore-style pattern syntax:
 * - `*` matches anything except `/`
 * - `**` matches anything including `/` (any depth)
 * - `?` matches any single character except `/`
 * - `[abc]` matches any character in the set
 * - `[a-z]` matches any character in the range
 * - `[!abc]` or `[^abc]` matches any character NOT in the set
 * - `{a,b,c}` matches any of the alternatives
 * - `!` at start negates the entire pattern
 * - `/` at start anchors to the root (relative patterns match anywhere)
 * - `/` at end matches directories only
 * - `#` at start is a comment (when using parsePatterns)
 *
 * @see https://git-scm.com/docs/gitignore#_pattern_format
 */
export interface ParsedPattern {
    /** Original pattern string */
    pattern: string;
    /** Whether the pattern is negated (starts with !) */
    isNegated: boolean;
    /** Pattern segments split by path separator */
    segments: string[];
    /** Whether the pattern matches only directories (ends with /) */
    isDirectory: boolean;
    /** Whether the pattern is anchored to root (starts with /) */
    isRooted: boolean;
}
/**
 * Parse a glob pattern string into a structured ParsedPattern object
 *
 * @param pattern - The glob pattern to parse
 * @returns ParsedPattern object with pattern metadata
 * @throws Error if pattern is invalid
 */
export declare function parsePattern(pattern: string): ParsedPattern;
/**
 * Parse multiple patterns from gitignore-style text
 *
 * Supports gitignore format:
 * - Blank lines are ignored
 * - Lines starting with # are comments
 * - Lines starting with \# treat # as literal
 * - All other lines are parsed as patterns
 *
 * @param input - Multi-line string with one pattern per line
 * @returns Array of ParsedPattern objects (excludes comments and blank lines)
 *
 * @example
 * ```typescript
 * const patterns = parsePatterns(`
 *   # Build artifacts
 *   dist/
 *   build/
 *
 *   # Dependencies
 *   node_modules/
 *
 *   # But keep certain files
 *   !dist/important.js
 * `)
 * // Returns parsed patterns for dist/, build/, node_modules/, !dist/important.js
 * ```
 */
export declare function parsePatterns(input: string): ParsedPattern[];
/**
 * Parse patterns from an array of strings
 *
 * Filters out comments and blank lines, then parses remaining as patterns.
 *
 * @param lines - Array of pattern strings
 * @returns Array of ParsedPattern objects
 */
export declare function parsePatternsArray(lines: string[]): ParsedPattern[];
/**
 * Match a path against a glob pattern
 *
 * @param path - The path to match
 * @param pattern - The glob pattern
 * @returns true if the path matches the pattern
 * @throws Error if pattern is empty
 */
export declare function matchPattern(path: string, pattern: string): boolean;
/**
 * Lazy pattern matcher that defers regex compilation until first use.
 *
 * Use this class when you have patterns that may never be matched against,
 * or when you want to spread out compilation cost over time.
 *
 * @example
 * ```typescript
 * const matcher = new LazyPatternMatcher('src/**\/*.ts')
 * // No compilation happens yet
 *
 * matcher.matches('src/index.ts') // Compiles and caches on first call
 * matcher.matches('src/utils.ts') // Uses cached regex
 * ```
 */
export declare class LazyPatternMatcher {
    private readonly pattern;
    private readonly workingPattern;
    private readonly shouldNegate;
    private regex;
    /**
     * Create a lazy pattern matcher
     *
     * @param pattern - The glob pattern (compilation is deferred)
     * @throws Error if pattern is empty
     */
    constructor(pattern: string);
    /**
     * Check if a path matches the pattern
     *
     * On first call, compiles the regex and caches it.
     * Subsequent calls use the cached regex.
     *
     * @param path - The path to match
     * @returns true if the path matches the pattern
     */
    matches(path: string): boolean;
    /**
     * Check if the pattern has been compiled yet
     */
    get isCompiled(): boolean;
    /**
     * Force immediate compilation of the pattern
     *
     * Useful when you want to pre-warm the cache or validate
     * the pattern before using it.
     */
    compile(): void;
    /**
     * Get the original pattern string
     */
    get originalPattern(): string;
}
/**
 * Create a reusable matcher function from a pattern
 *
 * This is an eager version that compiles immediately.
 * For lazy compilation, use `LazyPatternMatcher` instead.
 *
 * @param pattern - The glob pattern
 * @returns A function that takes a path and returns true if it matches
 * @throws Error if pattern is empty
 */
export declare function createPatternMatcher(pattern: string): (path: string) => boolean;
//# sourceMappingURL=patterns.d.ts.map