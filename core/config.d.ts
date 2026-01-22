/**
 * @fileoverview FSx Configuration Module
 *
 * Provides comprehensive configuration management for the fsx.do filesystem.
 * This module handles:
 *
 * - **Type-safe configuration** - Strongly typed interfaces with readonly properties
 * - **Validation** - Runtime validation of all configuration options
 * - **Normalization** - Path normalization and default merging
 * - **Immutability** - Frozen configuration objects to prevent mutation
 *
 * @module core/config
 *
 * @example Basic usage
 * ```typescript
 * import { createConfig, defaultConfig } from './config'
 *
 * // Use all defaults
 * const config = createConfig()
 *
 * // Custom configuration
 * const custom = createConfig({
 *   rootPath: '/home/user/data',
 *   readOnly: true,
 *   encoding: 'utf-8'
 * })
 * ```
 *
 * @example Validation
 * ```typescript
 * import { createConfig, isValidEncoding, isValidMode } from './config'
 *
 * // Validate before creating
 * if (isValidEncoding(userEncoding)) {
 *   const config = createConfig({ encoding: userEncoding })
 * }
 *
 * // Invalid options throw EINVAL
 * try {
 *   createConfig({ mode: -1 }) // Throws EINVAL
 * } catch (err) {
 *   console.error('Invalid configuration:', err.message)
 * }
 * ```
 */
import type { BufferEncoding } from './types.js';
/**
 * List of valid buffer encoding types supported by FSx.
 *
 * These encodings are compatible with Node.js Buffer and TextEncoder/TextDecoder.
 *
 * @remarks
 * - `utf8` and `utf-8` are equivalent and both accepted
 * - `binary` and `latin1` are equivalent (ISO-8859-1)
 *
 * @example
 * ```typescript
 * import { VALID_ENCODINGS } from './config'
 *
 * if (VALID_ENCODINGS.includes(userEncoding)) {
 *   // Safe to use
 * }
 * ```
 */
export declare const VALID_ENCODINGS: readonly BufferEncoding[];
/**
 * Minimum valid file mode value (no permissions).
 *
 * Mode 0 means no permissions for anyone. While unusual,
 * it's technically valid for special use cases.
 */
export declare const MIN_MODE = 0;
/**
 * Maximum valid file mode value (all permission and special bits set).
 *
 * This includes:
 * - Permission bits: rwx for owner, group, and others (0o777)
 * - Special bits: setuid, setgid, sticky bit (0o7000)
 *
 * @remarks
 * Value: 0o7777 = 4095 decimal
 */
export declare const MAX_MODE = 4095;
/**
 * Default file permission mode for newly created files.
 *
 * Mode 0o666 (rw-rw-rw-) allows read/write for owner, group, and others.
 * This is typically masked by umask to produce actual permissions.
 */
export declare const DEFAULT_FILE_MODE = 438;
/**
 * Default directory permission mode for newly created directories.
 *
 * Mode 0o755 (rwxr-xr-x) allows full access for owner, read/execute for others.
 */
export declare const DEFAULT_DIR_MODE = 493;
/**
 * FSx Configuration interface.
 *
 * Defines the complete set of configuration options for filesystem operations.
 * All properties are readonly to enforce immutability after creation.
 *
 * @remarks
 * Configuration objects should be created using {@link createConfig} which
 * validates all options and returns a frozen object.
 *
 * @example
 * ```typescript
 * const config: FSxConfig = {
 *   rootPath: '/data',
 *   readOnly: false,
 *   encoding: 'utf8',
 *   mode: 0o666,
 *   flags: constants.O_RDONLY,
 *   recursive: false
 * }
 * ```
 */
export interface FSxConfig {
    /**
     * Base path for all filesystem operations.
     *
     * All paths passed to filesystem methods are relative to this root.
     * Must be an absolute path (starts with '/').
     *
     * @defaultValue '/'
     *
     * @example
     * ```typescript
     * // With rootPath: '/home/user'
     * fs.read('data/file.txt') // Reads /home/user/data/file.txt
     * ```
     */
    readonly rootPath: string;
    /**
     * Whether the filesystem is in read-only mode.
     *
     * When `true`, all write operations (write, mkdir, unlink, etc.)
     * will throw an EROFS (read-only filesystem) error.
     *
     * @defaultValue false
     *
     * @example
     * ```typescript
     * const roConfig = createConfig({ readOnly: true })
     * if (isReadOnly(roConfig)) {
     *   throw new EROFS('write', path)
     * }
     * ```
     */
    readonly readOnly: boolean;
    /**
     * Default text encoding for read/write operations.
     *
     * Used when no encoding is specified in operation options.
     * See {@link VALID_ENCODINGS} for supported values.
     *
     * @defaultValue 'utf8'
     */
    readonly encoding: BufferEncoding;
    /**
     * Default file permission mode for newly created files.
     *
     * Specified as an octal number (e.g., 0o644).
     * Must be between {@link MIN_MODE} (0) and {@link MAX_MODE} (0o7777).
     *
     * @defaultValue 0o666 (rw-rw-rw-)
     *
     * @remarks
     * Common mode values:
     * - 0o644: Owner rw, others r (files)
     * - 0o755: Owner rwx, others rx (executables/directories)
     * - 0o600: Owner rw only (private files)
     */
    readonly mode: number;
    /**
     * Default file open flags.
     *
     * Specifies the default behavior for file operations.
     * Uses POSIX-style flags from the constants module.
     *
     * @defaultValue constants.O_RDONLY (read-only)
     *
     * @see constants for available flag values
     *
     * @example
     * ```typescript
     * import { constants } from './constants'
     *
     * // Read-write with create
     * const flags = constants.O_RDWR | constants.O_CREAT
     * ```
     */
    readonly flags: number;
    /**
     * Default behavior for recursive directory operations.
     *
     * When `true`, operations like mkdir and rmdir will
     * operate recursively by default.
     *
     * @defaultValue false
     *
     * @example
     * ```typescript
     * // With recursive: true
     * fs.mkdir('/a/b/c') // Creates all intermediate directories
     * ```
     */
    readonly recursive: boolean;
}
/**
 * Partial configuration options for user input.
 *
 * Used as input to {@link createConfig}. All properties are optional
 * and will be merged with {@link defaultConfig}.
 *
 * @example
 * ```typescript
 * const options: FSxConfigOptions = {
 *   rootPath: '/data',
 *   readOnly: true
 * }
 * const config = createConfig(options)
 * ```
 */
export interface FSxConfigOptions {
    /**
     * Base path for filesystem operations.
     * @see FSxConfig.rootPath
     */
    rootPath?: string;
    /**
     * Enable read-only mode.
     * @see FSxConfig.readOnly
     */
    readOnly?: boolean;
    /**
     * Default text encoding.
     * @see FSxConfig.encoding
     */
    encoding?: BufferEncoding;
    /**
     * Default file permission mode.
     * @see FSxConfig.mode
     */
    mode?: number;
    /**
     * Default file open flags.
     * @see FSxConfig.flags
     */
    flags?: number;
    /**
     * Enable recursive operations by default.
     * @see FSxConfig.recursive
     */
    recursive?: boolean;
}
/**
 * Default configuration values for FSx.
 *
 * This frozen object contains the default values used when
 * options are not specified in {@link createConfig}.
 *
 * @remarks
 * This object is frozen and cannot be modified. Use {@link createConfig}
 * to create custom configurations.
 *
 * @example
 * ```typescript
 * import { defaultConfig } from './config'
 *
 * console.log(defaultConfig.rootPath)   // '/'
 * console.log(defaultConfig.encoding)   // 'utf8'
 * console.log(defaultConfig.mode)       // 438 (0o666)
 * ```
 */
export declare const defaultConfig: FSxConfig;
/**
 * Check if a value is a valid BufferEncoding.
 *
 * Use this to validate user input before creating a configuration.
 *
 * @param value - The value to check
 * @returns `true` if the value is a valid encoding
 *
 * @example
 * ```typescript
 * const userInput = 'utf8'
 * if (isValidEncoding(userInput)) {
 *   const config = createConfig({ encoding: userInput })
 * }
 * ```
 */
export declare function isValidEncoding(value: unknown): value is BufferEncoding;
/**
 * Check if a value is a valid file mode.
 *
 * Valid modes are integers between 0 and 0o7777 (4095).
 *
 * @param value - The value to check
 * @returns `true` if the value is a valid mode
 *
 * @example
 * ```typescript
 * isValidMode(0o644)   // true
 * isValidMode(0o755)   // true
 * isValidMode(-1)      // false
 * isValidMode(0o10000) // false (exceeds max)
 * isValidMode('644')   // false (not a number)
 * ```
 */
export declare function isValidMode(value: unknown): value is number;
/**
 * Check if a value is a valid flags value.
 *
 * Flags must be a non-negative integer.
 *
 * @param value - The value to check
 * @returns `true` if the value is a valid flags value
 *
 * @example
 * ```typescript
 * import { constants } from './constants'
 *
 * isValidFlags(constants.O_RDONLY)              // true
 * isValidFlags(constants.O_RDWR | O_CREAT)      // true
 * isValidFlags(-1)                              // false
 * isValidFlags('r')                             // false
 * ```
 */
export declare function isValidFlags(value: unknown): value is number;
/**
 * Check if a value is a valid root path.
 *
 * Root paths must be strings. Empty strings are valid and
 * will be normalized to '/'.
 *
 * @param value - The value to check
 * @returns `true` if the value is a valid root path
 *
 * @example
 * ```typescript
 * isValidRootPath('/home/user') // true
 * isValidRootPath('')           // true (normalizes to '/')
 * isValidRootPath('relative')   // true (will be made absolute)
 * isValidRootPath(123)          // false
 * isValidRootPath(null)         // false
 * ```
 */
export declare function isValidRootPath(value: unknown): value is string;
/**
 * Create a new FSx configuration.
 *
 * Creates a validated, normalized, and frozen configuration object.
 * Options are merged with {@link defaultConfig}, and all values are
 * validated before the configuration is frozen.
 *
 * @param options - Optional configuration options to override defaults
 * @returns A frozen FSxConfig object
 *
 * @throws {EINVAL} If any option is invalid:
 *   - `rootPath` must be a string
 *   - `readOnly` must be a boolean
 *   - `encoding` must be a valid BufferEncoding (see {@link VALID_ENCODINGS})
 *   - `mode` must be a number between 0 and 0o7777
 *   - `flags` must be a number
 *   - `recursive` must be a boolean
 *
 * @example Use all defaults
 * ```typescript
 * const config = createConfig()
 * // {
 * //   rootPath: '/',
 * //   readOnly: false,
 * //   encoding: 'utf8',
 * //   mode: 0o666,
 * //   flags: 0,
 * //   recursive: false
 * // }
 * ```
 *
 * @example Custom root path
 * ```typescript
 * const config = createConfig({ rootPath: '/home/user' })
 * console.log(config.rootPath) // '/home/user'
 * ```
 *
 * @example Read-only mode
 * ```typescript
 * const roConfig = createConfig({ readOnly: true })
 * if (isReadOnly(roConfig)) {
 *   throw new EROFS('write', '/file.txt')
 * }
 * ```
 *
 * @example Path normalization
 * ```typescript
 * const config = createConfig({ rootPath: '/foo//bar/../baz' })
 * console.log(config.rootPath) // '/foo/baz'
 *
 * const config2 = createConfig({ rootPath: 'relative/path' })
 * console.log(config2.rootPath) // '/relative/path'
 * ```
 *
 * @example Multiple options
 * ```typescript
 * const config = createConfig({
 *   rootPath: '/data',
 *   readOnly: true,
 *   encoding: 'ascii',
 *   mode: 0o600,
 *   recursive: true
 * })
 * ```
 */
export declare function createConfig(options?: FSxConfigOptions): FSxConfig;
/**
 * Check if a configuration is in read-only mode.
 *
 * Helper function to check the readOnly property of a configuration.
 * Use this before performing write operations.
 *
 * @param config - The configuration to check
 * @returns `true` if the configuration is read-only
 *
 * @example
 * ```typescript
 * import { createConfig, isReadOnly } from './config'
 * import { EROFS } from './errors'
 *
 * const config = createConfig({ readOnly: true })
 *
 * function write(path: string, data: string): void {
 *   if (isReadOnly(config)) {
 *     throw new EROFS('write', path)
 *   }
 *   // Perform write...
 * }
 * ```
 */
export declare function isReadOnly(config: FSxConfig): boolean;
/**
 * Create a new configuration by merging updates with an existing config.
 *
 * This is useful for creating modified configurations while preserving
 * immutability. The original configuration is not modified.
 *
 * @param config - The base configuration to extend
 * @param updates - The options to override
 * @returns A new frozen FSxConfig with the updates applied
 *
 * @throws {EINVAL} If any update value is invalid
 *
 * @example
 * ```typescript
 * const baseConfig = createConfig({ rootPath: '/data' })
 * const roConfig = mergeConfig(baseConfig, { readOnly: true })
 *
 * console.log(baseConfig.readOnly) // false (unchanged)
 * console.log(roConfig.readOnly)   // true
 * console.log(roConfig.rootPath)   // '/data' (inherited)
 * ```
 */
export declare function mergeConfig(config: FSxConfig, updates: FSxConfigOptions): FSxConfig;
/**
 * Type guard to check if an object is a valid FSxConfig.
 *
 * Validates that the object has all required properties with correct types.
 * Does not validate that values are in valid ranges (use {@link createConfig}
 * for full validation).
 *
 * @param value - The value to check
 * @returns `true` if the value is a valid FSxConfig shape
 *
 * @example
 * ```typescript
 * const maybeConfig = JSON.parse(savedConfig)
 * if (isFSxConfig(maybeConfig)) {
 *   // Safe to use as FSxConfig
 *   console.log(maybeConfig.rootPath)
 * }
 * ```
 */
export declare function isFSxConfig(value: unknown): value is FSxConfig;
/**
 * Convert a configuration to a plain object for serialization.
 *
 * Creates a shallow copy of the configuration that can be safely
 * serialized to JSON. The returned object is NOT frozen.
 *
 * @param config - The configuration to convert
 * @returns A plain object with the same properties
 *
 * @example
 * ```typescript
 * const config = createConfig({ rootPath: '/data' })
 * const json = JSON.stringify(configToObject(config))
 * localStorage.setItem('fsxConfig', json)
 *
 * // Later:
 * const saved = JSON.parse(localStorage.getItem('fsxConfig'))
 * const restored = createConfig(saved)
 * ```
 */
export declare function configToObject(config: FSxConfig): FSxConfigOptions;
//# sourceMappingURL=config.d.ts.map