/**
 * @fileoverview Security module for fsx filesystem operations
 *
 * This module provides comprehensive security validation for filesystem paths,
 * protecting against common attack vectors including:
 *
 * - **Path Traversal (CWE-22)**: Prevents `../` and other sequences that could
 *   escape the filesystem jail and access unauthorized files.
 *   @see https://cwe.mitre.org/data/definitions/22.html
 *
 * - **Null Byte Injection (CWE-626)**: Detects null bytes that could truncate
 *   paths in C-based systems, bypassing validation.
 *   @see https://cwe.mitre.org/data/definitions/626.html
 *
 * - **Path Length Attacks (CWE-789)**: Enforces reasonable length limits to
 *   prevent buffer overflows and denial of service.
 *   @see https://cwe.mitre.org/data/definitions/789.html
 *
 * - **Control Character Injection**: Blocks terminal escape sequences and
 *   other control characters that could enable log injection or UI spoofing.
 *
 * - **Unicode Security Issues**: Detects bidirectional override characters
 *   (U+202E) used to disguise file extensions, and other dangerous Unicode.
 *
 * @category Application
 * @example
 * ```typescript
 * import { PathValidator, pathValidator, SecurityConstants } from './security'
 *
 * // Validate a path before filesystem operations
 * try {
 *   const safePath = pathValidator.validatePath(userInput, '/app/data')
 *   await fs.readFile(safePath)
 * } catch (error) {
 *   if (error.code === 'EACCES') {
 *     console.error('Path traversal attempt detected')
 *   }
 * }
 * ```
 *
 * @module do/security
 */
/**
 * Security constants for path validation and filesystem limits.
 *
 * These values are based on POSIX standards and common filesystem limits:
 * - PATH_MAX: Maximum total path length (Linux default: 4096)
 * - NAME_MAX: Maximum single component length (Linux default: 255)
 *
 * @see https://man7.org/linux/man-pages/man3/realpath.3.html
 */
export declare const SecurityConstants: {
    /**
     * Maximum total path length in bytes.
     * Based on Linux PATH_MAX (4096 bytes).
     * Prevents buffer overflows and DoS via memory exhaustion.
     */
    readonly MAX_PATH_LENGTH: 4096;
    /**
     * Maximum length of a single path component (filename/dirname).
     * Based on Linux NAME_MAX (255 bytes).
     * Prevents filesystem-specific truncation issues.
     */
    readonly MAX_NAME_LENGTH: 255;
    /**
     * Maximum symbolic link resolution depth.
     * Prevents infinite loops in symlink chains.
     */
    readonly MAX_SYMLINK_DEPTH: 40;
    /**
     * ASCII null byte - used in null byte injection attacks.
     * Can truncate strings in C-based systems.
     */
    readonly NULL_BYTE: "\0";
    /**
     * URL-encoded null byte representation.
     */
    readonly URL_ENCODED_NULL: "%00";
    /**
     * Unicode null character (equivalent to ASCII null).
     */
    readonly UNICODE_NULL: "\0";
    /**
     * DEL character (ASCII 0x7F) - often rejected in filenames.
     */
    readonly DEL_CHAR: "";
    /**
     * Unicode line separator - can cause parsing issues.
     */
    readonly LINE_SEPARATOR: "\u2028";
    /**
     * Unicode paragraph separator - can cause parsing issues.
     */
    readonly PARAGRAPH_SEPARATOR: "\u2029";
    /**
     * Right-to-left override character.
     * Used in bidirectional text attacks to disguise file extensions.
     * Example: "file\u202Etxt.exe" displays as "fileexe.txt"
     */
    readonly RTL_OVERRIDE: "‮";
    /**
     * Unicode replacement character - indicates encoding errors.
     */
    readonly REPLACEMENT_CHAR: "�";
};
/**
 * Type for SecurityConstants values
 */
export type SecurityConstantsType = typeof SecurityConstants;
/**
 * Result of path validation when successful
 */
export interface ValidationSuccess {
    valid: true;
    normalizedPath: string;
}
/**
 * Result of path validation when failed
 */
export interface ValidationFailure {
    valid: false;
    error: 'EINVAL' | 'ENAMETOOLONG' | 'EACCES';
    reason: string;
    path: string;
}
/**
 * Union type for validation results
 */
export type ValidationResult = ValidationSuccess | ValidationFailure;
/**
 * PathValidator - Secure path validation and traversal protection
 *
 * Provides comprehensive validation of filesystem paths to prevent
 * security vulnerabilities. All filesystem operations should validate
 * paths through this class before processing.
 *
 * ## Security Guarantees
 *
 * 1. **Jail Enforcement**: Paths cannot escape the designated root directory
 * 2. **Input Sanitization**: Dangerous characters are rejected, not sanitized
 * 3. **Consistent Normalization**: All paths are normalized consistently
 * 4. **Symlink Safety**: Symlink targets are validated for jail escape
 *
 * ## Usage Patterns
 *
 * ### Basic Validation
 * ```typescript
 * const validator = new PathValidator()
 * const safePath = validator.validatePath(userPath, '/app/jail')
 * ```
 *
 * ### Checking Without Throwing
 * ```typescript
 * if (validator.isPathTraversal(path, root)) {
 *   // Handle attack attempt
 * }
 * ```
 *
 * ### Input Validation Only
 * ```typescript
 * validator.validateInput(path) // Throws on invalid input
 * ```
 *
 * @example
 * ```typescript
 * const validator = new PathValidator()
 *
 * // Valid path within root
 * validator.validatePath('data/file.txt', '/app')
 * // Returns: '/app/data/file.txt'
 *
 * // Path traversal attempt - throws EACCES
 * validator.validatePath('../../../etc/passwd', '/app')
 * // Throws: EACCES: permission denied - path traversal detected
 *
 * // Invalid input - throws EINVAL
 * validator.validateInput('file\x00name.txt')
 * // Throws: EINVAL: invalid argument - null byte in path
 * ```
 */
export declare class PathValidator {
    /**
     * Validates a path string for security vulnerabilities.
     *
     * This method checks for dangerous characters and patterns without
     * considering the filesystem jail. Use this for early validation
     * before path normalization.
     *
     * ## Checks Performed
     *
     * 1. **Empty/whitespace paths**: Rejects empty or whitespace-only paths
     * 2. **Null bytes**: Detects literal and URL-encoded null bytes
     * 3. **Control characters**: Blocks ASCII 0x01-0x1F and DEL (0x7F)
     * 4. **Unicode dangers**: Blocks line/paragraph separators, RTL override
     * 5. **Length limits**: Enforces PATH_MAX and NAME_MAX
     * 6. **Whitespace issues**: Rejects trailing whitespace, leading whitespace after /
     *
     * @param path - The path string to validate
     * @throws {EINVAL} If path contains invalid characters or patterns
     * @throws {ENAMETOOLONG} If path exceeds length limits
     *
     * @example
     * ```typescript
     * // Valid path
     * validator.validateInput('/home/user/file.txt')  // OK
     *
     * // Null byte - throws EINVAL
     * validator.validateInput('file\x00.txt')
     * // Error: EINVAL: invalid argument - null byte detected in path
     *
     * // Control character - throws EINVAL
     * validator.validateInput('file\x1Bname.txt')
     * // Error: EINVAL: invalid argument - control character (0x1b) in path
     * ```
     */
    validateInput(path: string): void;
    /**
     * Validates that a path resolves within the allowed root directory.
     *
     * This is the primary security method that should be called before
     * any filesystem operation. It combines input validation with jail
     * enforcement to ensure paths cannot escape the designated root.
     *
     * ## Security Behavior
     *
     * 1. First runs input validation via `validateInput()`
     * 2. Normalizes backslashes to forward slashes (Windows attack vectors)
     * 3. Resolves `.` and `..` components
     * 4. Verifies resolved path is within or equal to root
     * 5. Returns the normalized, validated path
     *
     * ## Root Handling
     *
     * - If `root` is `/`, all valid paths are accepted
     * - Paths can equal the root exactly (e.g., `/app/data` with root `/app/data`)
     * - Paths must start with `root + '/'` to be within root
     *
     * @param path - The path to validate (can be relative or absolute)
     * @param root - The allowed root directory (default: '/')
     * @returns The normalized, validated path (always absolute)
     * @throws {EINVAL} If path contains invalid characters
     * @throws {ENAMETOOLONG} If path exceeds length limits
     * @throws {EACCES} If path would escape the root directory
     *
     * @example
     * ```typescript
     * const root = '/app/data'
     *
     * // Relative path - resolved against root
     * validator.validatePath('config.json', root)
     * // Returns: '/app/data/config.json'
     *
     * // Absolute path within root - accepted
     * validator.validatePath('/app/data/logs/app.log', root)
     * // Returns: '/app/data/logs/app.log'
     *
     * // Path with .. that stays in root - accepted
     * validator.validatePath('a/b/../c.txt', root)
     * // Returns: '/app/data/a/c.txt'
     *
     * // Path traversal attempt - throws EACCES
     * validator.validatePath('../../../etc/passwd', root)
     * // Throws: EACCES: permission denied - path traversal detected '../../../etc/passwd'
     *
     * // Absolute path outside root - throws EACCES
     * validator.validatePath('/etc/passwd', root)
     * // Throws: EACCES: permission denied - path traversal detected '/etc/passwd'
     * ```
     */
    validatePath(path: string, root?: string): string;
    /**
     * Checks if a path would escape the allowed root directory.
     *
     * This is a non-throwing alternative to `validatePath()` for cases
     * where you want to check without exception handling.
     *
     * @param path - The path to check
     * @param root - The allowed root directory (default: '/')
     * @returns `true` if path would escape root (is a traversal attack), `false` if safe
     *
     * @example
     * ```typescript
     * if (validator.isPathTraversal(userInput, '/app/data')) {
     *   auditLog.warn('Path traversal attempt', { path: userInput, user })
     *   return res.status(403).json({ error: 'Access denied' })
     * }
     * ```
     */
    isPathTraversal(path: string, root?: string): boolean;
    /**
     * Validates that a symlink target doesn't escape the root directory.
     *
     * Symlinks require special handling because they can point to arbitrary
     * locations. This method checks whether following a symlink would escape
     * the filesystem jail.
     *
     * ## Resolution Rules
     *
     * - **Absolute targets** (starting with `/`): Checked directly against root
     * - **Relative targets**: Resolved from symlink's parent directory
     *
     * ## Security Note
     *
     * This method should be called when creating symlinks to prevent users
     * from creating links that point outside the jail. It does NOT prevent
     * time-of-check-to-time-of-use (TOCTOU) attacks where the target is
     * modified after creation.
     *
     * @param target - The symlink target path
     * @param symlinkPath - The path where the symlink is/will be located
     * @param root - The allowed root directory (default: '/')
     * @returns `true` if target would escape root, `false` if safe
     *
     * @example
     * ```typescript
     * const root = '/jail'
     *
     * // Absolute target escaping jail
     * validator.isSymlinkEscape('/etc/passwd', '/jail/link', root)
     * // Returns: true (target /etc/passwd is outside /jail)
     *
     * // Relative target escaping jail
     * validator.isSymlinkEscape('../../etc/passwd', '/jail/user/link', root)
     * // Returns: true (resolves to /etc/passwd)
     *
     * // Safe relative target
     * validator.isSymlinkEscape('../shared/file.txt', '/jail/user/link', root)
     * // Returns: false (resolves to /jail/shared/file.txt)
     * ```
     */
    isSymlinkEscape(target: string, symlinkPath: string, root?: string): boolean;
    /**
     * Validates a path and returns a result object instead of throwing.
     *
     * Useful for validation in contexts where exceptions are undesirable,
     * such as batch validation or when building error aggregations.
     *
     * @param path - The path to validate
     * @param root - The allowed root directory (default: '/')
     * @returns ValidationResult object with success status and details
     *
     * @example
     * ```typescript
     * const result = validator.validatePathResult(userPath, '/app')
     *
     * if (result.valid) {
     *   await fs.readFile(result.normalizedPath)
     * } else {
     *   console.error(`Validation failed: ${result.reason}`)
     * }
     * ```
     */
    validatePathResult(path: string, root?: string): ValidationResult;
    /**
     * Normalize a path: resolve `.` and `..`, remove double slashes, handle backslashes.
     *
     * @internal
     * @param path - Path to normalize
     * @returns Normalized absolute path
     */
    private normalizePath;
    /**
     * Check if a resolved path is within the root directory.
     *
     * @internal
     * @param resolved - The resolved, normalized path
     * @param root - The normalized root directory
     * @returns true if path is within root, false otherwise
     */
    private isWithinRoot;
    /**
     * Get the parent path of a given path.
     *
     * @internal
     * @param path - The path to get parent of
     * @returns The parent directory path
     */
    private getParentPath;
}
/**
 * Singleton PathValidator instance for use across the module.
 *
 * Use this instance for most validation needs. Creating separate instances
 * is only necessary if you need to extend or customize validation behavior.
 *
 * @example
 * ```typescript
 * import { pathValidator } from './security'
 *
 * // Validate a user-provided path
 * const safePath = pathValidator.validatePath(userInput, '/app/data')
 * ```
 */
export declare const pathValidator: PathValidator;
//# sourceMappingURL=security.d.ts.map