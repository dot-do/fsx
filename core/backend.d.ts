/**
 * FsBackend Interface
 *
 * The pluggable storage backend interface for @dotdo/fsx.
 * Implement this interface to create custom storage backends
 * (SQLite, R2, Memory, Node.js fs, etc.)
 *
 * @category Framework
 * @module backend
 */
import type { Stats, Dirent, WriteOptions, MkdirOptions, RmdirOptions, ReaddirOptions, StorageTier } from './types.js';
/**
 * File handle for low-level file operations.
 *
 * Provides direct access to file contents with positioned read/write
 * operations, similar to Node.js fs.FileHandle.
 */
export interface FileHandle {
    /** File descriptor number */
    readonly fd: number;
    /**
     * Read data from the file.
     *
     * @param buffer - Buffer to read into
     * @param offset - Offset in buffer to start writing
     * @param length - Number of bytes to read
     * @param position - Position in file to read from
     * @returns Bytes read and buffer
     */
    read(buffer: Uint8Array, offset?: number, length?: number, position?: number): Promise<{
        bytesRead: number;
        buffer: Uint8Array;
    }>;
    /**
     * Write data to the file.
     *
     * @param data - Data to write
     * @param position - Position in file to write at
     * @returns Bytes written
     */
    write(data: Uint8Array | string, position?: number): Promise<{
        bytesWritten: number;
    }>;
    /**
     * Read entire file contents.
     */
    readFile(): Promise<Uint8Array>;
    /**
     * Replace entire file contents.
     */
    writeFile(data: Uint8Array | string): Promise<void>;
    /**
     * Get file statistics.
     */
    stat(): Promise<Stats>;
    /**
     * Change file permissions.
     */
    chmod(mode: number): Promise<void>;
    /**
     * Change file ownership.
     */
    chown(uid: number, gid: number): Promise<void>;
    /**
     * Close the file handle.
     */
    close(): Promise<void>;
    /**
     * Synchronize file data and metadata to storage.
     */
    sync(): Promise<void>;
    /**
     * Synchronize file data (not metadata) to storage.
     */
    datasync(): Promise<void>;
    /**
     * Truncate the file to a specified length.
     *
     * @param length - The new file length in bytes (default: 0)
     */
    truncate(length?: number): Promise<void>;
}
/**
 * Result of a backend write operation.
 */
export interface BackendWriteResult {
    /** Number of bytes written */
    bytesWritten: number;
    /** Storage tier where data was placed */
    tier: StorageTier;
}
/**
 * Result of a backend read operation.
 */
export interface BackendReadResult {
    /** Raw data bytes */
    data: Uint8Array;
    /** Storage tier from which data was read */
    tier: StorageTier;
    /** File size */
    size: number;
}
/**
 * Options for backend initialization.
 */
export interface BackendOptions {
    /** Base path or namespace for this backend */
    basePath?: string;
    /** Default storage tier for new files */
    defaultTier?: StorageTier;
}
/**
 * Pluggable storage backend interface.
 *
 * This is the abstraction layer that allows @dotdo/fsx to work with
 * different storage backends without any platform-specific dependencies.
 *
 * Implementations:
 * - `SqliteBackend` - Durable Object SQLite (hot tier)
 * - `R2Backend` - Cloudflare R2 (warm tier)
 * - `TieredBackend` - Combines multiple backends with automatic tiering
 * - `MemoryBackend` - In-memory for testing
 * - `NodeBackend` - Node.js fs module
 *
 * @example
 * ```typescript
 * import { FsBackend, FSx } from '@dotdo/fsx'
 *
 * // Create a custom backend
 * class MyBackend implements FsBackend {
 *   async readFile(path: string): Promise<Uint8Array> {
 *     // Your implementation
 *   }
 *   // ... other methods
 * }
 *
 * // Use with FSx
 * const fs = new FSx(new MyBackend())
 * ```
 */
export interface FsBackend {
    /**
     * Read file contents.
     *
     * @param path - Absolute path to the file
     * @returns Raw file data as Uint8Array
     * @throws ENOENT if file does not exist
     * @throws EISDIR if path is a directory
     */
    readFile(path: string): Promise<Uint8Array>;
    /**
     * Write data to a file, creating it if necessary.
     *
     * @param path - Absolute path to the file
     * @param data - Data to write
     * @param options - Write options (mode, flag, tier)
     * @returns Write result with bytes written and tier
     * @throws ENOENT if parent directory does not exist
     */
    writeFile(path: string, data: Uint8Array, options?: WriteOptions): Promise<BackendWriteResult>;
    /**
     * Delete a file.
     *
     * @param path - Absolute path to the file
     * @throws ENOENT if file does not exist
     * @throws EISDIR if path is a directory
     */
    unlink(path: string): Promise<void>;
    /**
     * Rename or move a file.
     *
     * @param oldPath - Current path
     * @param newPath - New path
     */
    rename(oldPath: string, newPath: string): Promise<void>;
    /**
     * Append data to a file.
     *
     * @param path - Absolute path to the file
     * @param data - Data to append
     * @throws ENOENT if parent directory does not exist (creates file if it doesn't exist)
     */
    appendFile(path: string, data: Uint8Array): Promise<void>;
    /**
     * Copy a file.
     *
     * @param src - Source file path
     * @param dest - Destination file path
     */
    copyFile(src: string, dest: string): Promise<void>;
    /**
     * Create a directory.
     *
     * @param path - Path to the directory
     * @param options - mkdir options (recursive, mode)
     */
    mkdir(path: string, options?: MkdirOptions): Promise<void>;
    /**
     * Remove a directory.
     *
     * @param path - Path to the directory
     * @param options - rmdir options (recursive)
     */
    rmdir(path: string, options?: RmdirOptions): Promise<void>;
    /**
     * Read directory contents.
     *
     * @param path - Path to the directory
     * @param options - readdir options
     * @returns Array of file names or Dirent objects
     */
    readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]>;
    /**
     * Get file or directory statistics.
     *
     * @param path - Path to the file or directory
     * @returns Stats object
     * @throws ENOENT if path does not exist
     */
    stat(path: string): Promise<Stats>;
    /**
     * Get statistics without following symbolic links.
     *
     * @param path - Path to check
     * @returns Stats object for the link itself
     */
    lstat(path: string): Promise<Stats>;
    /**
     * Check if a path exists.
     *
     * @param path - Path to check
     * @returns true if exists, false otherwise
     */
    exists(path: string): Promise<boolean>;
    /**
     * Check file accessibility and permissions.
     *
     * @param path - Path to check
     * @param mode - Accessibility mode (F_OK, R_OK, W_OK, X_OK)
     * @throws ENOENT if path does not exist
     * @throws EACCES if access is denied
     */
    access(path: string, mode?: number): Promise<void>;
    /**
     * Change file permissions.
     *
     * @param path - Path to the file
     * @param mode - New permissions
     */
    chmod(path: string, mode: number): Promise<void>;
    /**
     * Change file ownership.
     *
     * @param path - Path to the file
     * @param uid - User ID
     * @param gid - Group ID
     */
    chown(path: string, uid: number, gid: number): Promise<void>;
    /**
     * Update file timestamps.
     *
     * @param path - Path to the file
     * @param atime - Access time
     * @param mtime - Modification time
     */
    utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void>;
    /**
     * Create a symbolic link.
     *
     * @param target - Target path
     * @param path - Link path
     */
    symlink(target: string, path: string): Promise<void>;
    /**
     * Create a hard link.
     *
     * @param existingPath - Existing file path
     * @param newPath - New link path
     */
    link(existingPath: string, newPath: string): Promise<void>;
    /**
     * Read the target of a symbolic link.
     *
     * @param path - Path to the symbolic link
     * @returns Target path
     */
    readlink(path: string): Promise<string>;
    /**
     * Resolve a path by following symbolic links.
     *
     * @param path - Path to resolve
     * @returns Resolved absolute path
     * @throws ENOENT if path does not exist
     * @throws ELOOP if too many symbolic links
     */
    realpath(path: string): Promise<string>;
    /**
     * Create a unique temporary directory.
     *
     * @param prefix - Prefix for the directory name
     * @returns Path to the created directory
     */
    mkdtemp(prefix: string): Promise<string>;
    /**
     * Open a file and return a file handle.
     *
     * @param path - Path to the file
     * @param flags - Open flags ('r', 'w', 'a', 'r+', etc.)
     * @param mode - File mode for new files
     * @returns FileHandle for the opened file
     * @throws ENOENT if file does not exist (for read modes)
     * @throws EEXIST if file exists (for exclusive modes)
     */
    open(path: string, flags?: string, mode?: number): Promise<FileHandle>;
    /**
     * Get the storage tier for a file.
     *
     * @param path - Path to the file
     * @returns Current storage tier
     */
    getTier?(path: string): Promise<StorageTier>;
    /**
     * Move file to a higher tier.
     *
     * @param path - Path to the file
     * @param tier - Target tier
     */
    promote?(path: string, tier: 'hot' | 'warm'): Promise<void>;
    /**
     * Move file to a lower tier.
     *
     * @param path - Path to the file
     * @param tier - Target tier
     */
    demote?(path: string, tier: 'warm' | 'cold'): Promise<void>;
}
/**
 * In-memory filesystem backend for testing.
 *
 * @example
 * ```typescript
 * const backend = new MemoryBackend()
 * const fs = new FSx(backend)
 *
 * await fs.write('/test.txt', 'Hello')
 * const content = await fs.read('/test.txt', { encoding: 'utf-8' })
 * ```
 */
export declare class MemoryBackend implements FsBackend {
    private files;
    private directories;
    /**
     * Normalize a path by resolving . and .., removing duplicate slashes,
     * and stripping trailing slashes (except for root).
     */
    private normalizePath;
    /**
     * Get the parent directory of a path.
     */
    private getParentDir;
    /**
     * Check if parent directory exists and path components are valid.
     * Returns error type or null if valid.
     */
    private validatePath;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array, options?: WriteOptions): Promise<BackendWriteResult>;
    appendFile(path: string, data: Uint8Array): Promise<void>;
    unlink(path: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    copyFile(src: string, dest: string): Promise<void>;
    mkdir(path: string, options?: MkdirOptions): Promise<void>;
    rmdir(path: string, options?: RmdirOptions): Promise<void>;
    readdir(path: string, options?: ReaddirOptions): Promise<string[] | Dirent[]>;
    stat(path: string): Promise<Stats>;
    lstat(path: string): Promise<Stats>;
    exists(path: string): Promise<boolean>;
    access(path: string, mode?: number): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
    chown(path: string, uid: number, gid: number): Promise<void>;
    utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void>;
    symlink(_target: string, _path: string): Promise<void>;
    link(_existingPath: string, _newPath: string): Promise<void>;
    readlink(_path: string): Promise<string>;
    realpath(path: string): Promise<string>;
    mkdtemp(prefix: string): Promise<string>;
    open(_path: string, _flags?: string, _mode?: number): Promise<FileHandle>;
    getTier(path: string): Promise<StorageTier>;
    promote(_path: string, _tier: 'hot' | 'warm'): Promise<void>;
    demote(_path: string, _tier: 'warm' | 'cold'): Promise<void>;
}
//# sourceMappingURL=backend.d.ts.map