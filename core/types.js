/**
 * Core filesystem types
 *
 * This module defines the comprehensive TypeScript interfaces for the fsx.do
 * filesystem capability. These types provide a POSIX-like API for filesystem
 * operations on Cloudflare Durable Objects with tiered storage support.
 *
 * @module core/types
 */
import { constants } from './constants';
/**
 * POSIX-compatible file statistics class.
 *
 * Provides comprehensive metadata about a filesystem entry, including
 * size, timestamps, permissions, and type information. Compatible with
 * Node.js `fs.Stats` for easy migration.
 *
 * The type checking methods (`isFile()`, `isDirectory()`, etc.) use
 * bitwise operations on the mode field to determine the file type
 * according to POSIX standards.
 *
 * @example
 * ```typescript
 * const stats = await fs.stat('/path/to/file')
 *
 * // Check type
 * if (stats.isFile()) {
 *   console.log(`File size: ${stats.size} bytes`)
 * }
 *
 * // Access timestamps
 * console.log(`Last modified: ${stats.mtime}`)
 * console.log(`Created: ${stats.birthtime}`)
 *
 * // Check permissions via mode
 * const isReadable = (stats.mode & 0o444) !== 0
 * ```
 *
 * @see {@link StatsInit} for constructor properties
 * @see {@link constants} for mode bit definitions
 */
export class Stats {
    /** Device ID */
    dev;
    /** Inode number */
    ino;
    /** File mode (permissions + type) */
    mode;
    /** Number of hard links */
    nlink;
    /** User ID */
    uid;
    /** Group ID */
    gid;
    /** Device ID (if special file) */
    rdev;
    /** File size in bytes */
    size;
    /** Block size */
    blksize;
    /** Number of blocks */
    blocks;
    /** Access time in ms */
    atimeMs;
    /** Modification time in ms */
    mtimeMs;
    /** Change time (metadata) in ms */
    ctimeMs;
    /** Birth time (creation) in ms */
    birthtimeMs;
    constructor(init) {
        this.dev = init.dev;
        this.ino = init.ino;
        this.mode = init.mode;
        this.nlink = init.nlink;
        this.uid = init.uid;
        this.gid = init.gid;
        this.rdev = init.rdev;
        this.size = init.size;
        this.blksize = init.blksize;
        this.blocks = init.blocks;
        this.atimeMs = init.atimeMs;
        this.mtimeMs = init.mtimeMs;
        this.ctimeMs = init.ctimeMs;
        this.birthtimeMs = init.birthtimeMs;
    }
    /** Access time */
    get atime() {
        return new Date(this.atimeMs);
    }
    /** Modification time */
    get mtime() {
        return new Date(this.mtimeMs);
    }
    /** Change time (metadata) */
    get ctime() {
        return new Date(this.ctimeMs);
    }
    /** Birth time (creation) */
    get birthtime() {
        return new Date(this.birthtimeMs);
    }
    /** Is regular file */
    isFile() {
        return (this.mode & constants.S_IFMT) === constants.S_IFREG;
    }
    /** Is directory */
    isDirectory() {
        return (this.mode & constants.S_IFMT) === constants.S_IFDIR;
    }
    /** Is symbolic link */
    isSymbolicLink() {
        return (this.mode & constants.S_IFMT) === constants.S_IFLNK;
    }
    /** Is block device */
    isBlockDevice() {
        return (this.mode & constants.S_IFMT) === constants.S_IFBLK;
    }
    /** Is character device */
    isCharacterDevice() {
        return (this.mode & constants.S_IFMT) === constants.S_IFCHR;
    }
    /** Is FIFO (named pipe) */
    isFIFO() {
        return (this.mode & constants.S_IFMT) === constants.S_IFIFO;
    }
    /** Is socket */
    isSocket() {
        return (this.mode & constants.S_IFMT) === constants.S_IFSOCK;
    }
}
/**
 * Directory entry class representing a filesystem entry in a directory listing.
 *
 * Similar to Node.js `fs.Dirent`, this class provides metadata about directory
 * entries including name, parent path, and type information. Type checking
 * methods allow runtime identification of entry types.
 *
 * @example
 * ```typescript
 * const entries = await fs.readdir('/home/user', { withFileTypes: true })
 * for (const entry of entries) {
 *   if (entry.isFile()) {
 *     console.log(`File: ${entry.path}`)
 *   } else if (entry.isDirectory()) {
 *     console.log(`Directory: ${entry.path}`)
 *   }
 * }
 * ```
 */
export class Dirent {
    /** Entry name (filename without path) */
    name;
    /** Parent directory path */
    parentPath;
    /** Entry type stored internally */
    _type;
    /**
     * Create a new directory entry.
     *
     * @param name - The entry name (filename only, no path)
     * @param parentPath - The parent directory path
     * @param type - The type of filesystem entry
     */
    constructor(name, parentPath, type) {
        this.name = name;
        this.parentPath = parentPath;
        this._type = type;
    }
    /** Full path */
    get path() {
        if (this.parentPath.endsWith('/')) {
            return this.parentPath + this.name;
        }
        return this.parentPath + '/' + this.name;
    }
    /** Is regular file */
    isFile() {
        return this._type === 'file';
    }
    /** Is directory */
    isDirectory() {
        return this._type === 'directory';
    }
    /** Is symbolic link */
    isSymbolicLink() {
        return this._type === 'symlink';
    }
    /** Is block device */
    isBlockDevice() {
        return this._type === 'block';
    }
    /** Is character device */
    isCharacterDevice() {
        return this._type === 'character';
    }
    /** Is FIFO */
    isFIFO() {
        return this._type === 'fifo';
    }
    /** Is socket */
    isSocket() {
        return this._type === 'socket';
    }
}
/**
 * File handle for open files.
 *
 * Provides a low-level interface for file operations with proper tracking of
 * dirty state and POSIX-compliant sync semantics. The handle supports both
 * sequential and positioned I/O operations.
 *
 * Key features:
 * - **Dirty tracking**: Efficiently tracks whether data needs syncing
 * - **Sync vs datasync**: Supports both full sync (data + metadata) and datasync (data only)
 * - **Position management**: Tracks current file position for sequential operations
 * - **Access mode enforcement**: Respects read/write/append flags from open()
 *
 * @example
 * ```typescript
 * const handle = await fs.open('/file.txt', 'r+')
 * await handle.write('data')
 * await handle.sync()  // Flush data and metadata
 * await handle.close()
 * ```
 */
export class FileHandle {
    /** File descriptor number (3+ for user files; 0-2 reserved for stdin/stdout/stderr) */
    fd;
    /** Internal data buffer containing file contents */
    _data;
    /** Internal stats cache (includes size, timestamps, etc.) */
    _stats;
    /** Whether the handle has been closed */
    _closed = false;
    /** Current file position for sequential read/write operations */
    _position = 0;
    /** Whether this handle is in append mode (O_APPEND) */
    _appendMode = false;
    /** Whether this handle permits write operations */
    _writable = true;
    /** Whether this handle permits read operations */
    _readable = true;
    /**
     * Dirty flag for efficient sync tracking.
     * Set to true when data has been modified since last sync.
     * Allows sync() to be a no-op when no changes have been made.
     */
    _dirty = false;
    constructor(fd, data, stats) {
        this.fd = fd;
        this._data = data;
        this._stats = stats;
    }
    /**
     * Ensure the file handle is still open.
     * @throws {Error} EBADF if handle has been closed
     */
    _ensureOpen() {
        if (this._closed) {
            const error = new Error('EBADF: bad file descriptor - handle is closed');
            error.code = 'EBADF';
            throw error;
        }
    }
    /**
     * Create an Error with an errno code property.
     * Centralizes error creation for consistent error handling across read/write operations.
     *
     * @param code - POSIX errno code (e.g., 'EBADF', 'EINVAL')
     * @param message - Human-readable error message
     * @returns Error object with code property set
     */
    _createErrnoError(code, message) {
        const error = new Error(`${code}: ${message}`);
        error.code = code;
        return error;
    }
    /**
     * Validate that a numeric parameter is non-negative.
     * Throws EINVAL if the value is negative.
     *
     * @param value - The value to validate
     * @param paramName - Name of the parameter for error messages
     * @throws {Error} EINVAL if value is negative
     */
    _validateNonNegative(value, paramName) {
        if (value !== undefined && value < 0) {
            throw this._createErrnoError('EINVAL', `invalid argument, ${paramName} cannot be negative`);
        }
    }
    /**
     * Build a new StatsLike object with updated size and timestamps.
     * This helper promotes code reuse across stat(), truncate(), and write operations.
     *
     * @param options - Optional overrides for mtime and ctime
     * @returns A new StatsLike object reflecting current file state
     */
    _buildStatsLike(options) {
        const oldStats = this._stats;
        const currentSize = this._data.length;
        const blockSize = oldStats.blksize;
        const blocks = blockSize > 0 ? Math.ceil(currentSize / blockSize) : 0;
        return {
            dev: oldStats.dev,
            ino: oldStats.ino,
            mode: oldStats.mode,
            nlink: oldStats.nlink,
            uid: oldStats.uid,
            gid: oldStats.gid,
            rdev: oldStats.rdev,
            size: currentSize,
            blksize: blockSize,
            blocks: blocks,
            atime: oldStats.atime,
            mtime: options?.mtime ?? oldStats.mtime,
            ctime: options?.ctime ?? oldStats.ctime,
            birthtime: oldStats.birthtime,
            isFile: () => oldStats.isFile(),
            isDirectory: () => oldStats.isDirectory(),
            isSymbolicLink: () => oldStats.isSymbolicLink(),
            isBlockDevice: () => oldStats.isBlockDevice(),
            isCharacterDevice: () => oldStats.isCharacterDevice(),
            isFIFO: () => oldStats.isFIFO(),
            isSocket: () => oldStats.isSocket(),
        };
    }
    /**
     * Read from file into buffer.
     *
     * Reads data from the file starting at `position` (or current file position if not specified)
     * into `buffer` starting at `offset`. The number of bytes read is the minimum of:
     * - `length` (or available buffer space if not specified)
     * - Available space in buffer after offset
     * - Remaining bytes in file from read position
     *
     * @param buffer - Buffer to read data into (must be Uint8Array)
     * @param offset - Offset in buffer to start writing at (default: 0)
     * @param length - Maximum number of bytes to read (default: buffer.length - offset)
     * @param position - File position to read from. If undefined, uses and advances internal position.
     *                   If specified, does not modify internal position (absolute read).
     * @returns Object with bytesRead count and the same buffer reference
     *
     * @throws {Error} EBADF if handle is closed or not readable
     * @throws {TypeError} If buffer is not a Uint8Array
     * @throws {Error} EINVAL if offset, length, or position is negative
     * @throws {RangeError} If offset exceeds buffer length
     */
    async read(buffer, offset = 0, length, position) {
        // --- Precondition checks ---
        this._ensureOpen();
        this._ensureReadable();
        this._validateBuffer(buffer);
        this._validateReadParams(buffer, offset, length, position);
        // --- Determine read position ---
        // Absolute read (position specified): read from position, don't update internal position
        // Sequential read (position undefined): read from internal position, advance it after
        const isSequentialRead = position === undefined;
        const readPosition = isSequentialRead ? this._position : position;
        // --- Calculate bytes to read ---
        const bytesToRead = this._calculateBytesToRead(buffer, offset, length, readPosition);
        // Early return for EOF or zero-length reads
        if (bytesToRead === 0) {
            return { bytesRead: 0, buffer };
        }
        // --- Perform the read using efficient subarray copy ---
        const sourceSlice = this._data.subarray(readPosition, readPosition + bytesToRead);
        buffer.set(sourceSlice, offset);
        // --- Update position for sequential reads ---
        if (isSequentialRead) {
            this._position += bytesToRead;
        }
        return { bytesRead: bytesToRead, buffer };
    }
    /**
     * Ensure the handle is readable.
     * @throws {Error} EBADF if handle was opened write-only
     */
    _ensureReadable() {
        if (!this._readable) {
            throw this._createErrnoError('EBADF', 'bad file descriptor, read - not readable');
        }
    }
    /**
     * Validate that buffer is a valid Uint8Array.
     * @throws {TypeError} If buffer is null, undefined, or not a Uint8Array
     */
    _validateBuffer(buffer) {
        if (buffer === null || buffer === undefined || !(buffer instanceof Uint8Array)) {
            throw new TypeError('The "buffer" argument must be of type Uint8Array');
        }
    }
    /**
     * Validate read() parameters.
     * @throws {Error} EINVAL for negative offset, length, or position
     * @throws {RangeError} If offset exceeds buffer bounds
     */
    _validateReadParams(buffer, offset, length, position) {
        // Validate offset
        this._validateNonNegative(offset, 'offset');
        if (offset > buffer.length) {
            throw new RangeError('The value of "offset" is out of range');
        }
        // Validate length and position
        this._validateNonNegative(length, 'length');
        this._validateNonNegative(position, 'position');
    }
    /**
     * Calculate the actual number of bytes to read.
     *
     * Takes the minimum of:
     * 1. Requested length (or available buffer space if not specified)
     * 2. Remaining buffer capacity after offset
     * 3. Remaining file bytes from read position
     *
     * @returns Number of bytes to read (0 if at/past EOF or no capacity)
     */
    _calculateBytesToRead(buffer, offset, length, readPosition) {
        // Check for EOF
        const fileSize = this._data.length;
        if (readPosition >= fileSize) {
            return 0;
        }
        const bufferCapacity = buffer.length - offset;
        const remainingInFile = fileSize - readPosition;
        const requestedLength = length ?? bufferCapacity;
        // Return the minimum of all constraints, ensuring non-negative
        return Math.max(0, Math.min(requestedLength, bufferCapacity, remainingInFile));
    }
    /**
     * Write data to the file.
     *
     * Supports writing strings, Uint8Array buffers, or ArrayBuffers to the file.
     * For buffer writes, optional offset and length parameters allow writing
     * a portion of the source buffer.
     *
     * @param data - Data to write (string, Uint8Array, or ArrayBuffer)
     * @param position - File position to write at. If null, uses current position.
     *                   If undefined (for buffers), defaults to 0.
     * @param length - For buffer writes: number of bytes to write from buffer
     * @param offset - For buffer writes: offset in source buffer to start reading from
     * @returns Object with bytesWritten count and the source buffer
     *
     * @throws {Error} If handle is closed (EBADF)
     * @throws {Error} If handle is not writable (EBADF)
     * @throws {Error} If position is negative (EINVAL)
     * @throws {TypeError} If data is not a valid type
     * @throws {RangeError} If offset or length exceeds buffer bounds
     *
     * @example
     * ```typescript
     * // Write a string
     * await handle.write('Hello, World!')
     *
     * // Write at specific position
     * await handle.write('data', 100)
     *
     * // Write portion of buffer
     * const buffer = new Uint8Array([1, 2, 3, 4, 5])
     * await handle.write(buffer, 0, 3, 1)  // Write bytes [2,3,4] at position 0
     * ```
     */
    async write(data, position, length, offset) {
        this._ensureOpen();
        this._ensureWritable();
        // Convert input to bytes and determine what portion to write
        const { bytes, toWrite } = this._prepareWriteData(data, length, offset);
        // Determine write position (handles append mode, null/undefined semantics)
        const pos = this._getWritePosition(position);
        // Perform the write and update state
        this._writeBytes(toWrite, pos);
        this._position = pos + toWrite.length;
        this._updateMtime();
        return { bytesWritten: toWrite.length, buffer: bytes };
    }
    /**
     * Validate that the handle is writable, throwing EBADF if not.
     */
    _ensureWritable() {
        if (!this._writable) {
            const error = new Error('EBADF: bad file descriptor, write');
            error.code = 'EBADF';
            throw error;
        }
    }
    /**
     * Convert write data to bytes and extract the portion to write.
     * Handles strings, Uint8Arrays, and ArrayBuffers with optional offset/length.
     *
     * @param data - Input data (string, Uint8Array, or ArrayBuffer)
     * @param length - Optional length for buffer writes
     * @param offset - Optional offset for buffer writes
     * @returns Object containing the full buffer and the portion to write
     * @throws {TypeError} If data is an invalid type
     * @throws {RangeError} If offset/length exceed buffer bounds
     */
    _prepareWriteData(data, length, offset) {
        // Handle string input (always UTF-8 encoded)
        if (typeof data === 'string') {
            const bytes = new TextEncoder().encode(data);
            return { bytes, toWrite: bytes };
        }
        // Validate data type for non-string inputs
        this._validateWriteDataType(data);
        // Convert ArrayBuffer to Uint8Array if needed
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
        // Apply offset and length to extract the portion to write
        const bufferOffset = offset ?? 0;
        const writeLength = length ?? bytes.length - bufferOffset;
        // Validate offset and length bounds
        if (bufferOffset > bytes.length) {
            throw new RangeError('The value of "offset" is out of range');
        }
        if (bufferOffset + writeLength > bytes.length) {
            throw new RangeError('The value of "length" is out of range');
        }
        const toWrite = bytes.subarray(bufferOffset, bufferOffset + writeLength);
        return { bytes, toWrite };
    }
    /**
     * Validate that write data is a valid type.
     * @throws {TypeError} If data is null, undefined, number, or invalid object
     */
    _validateWriteDataType(data) {
        if (data === null || data === undefined) {
            throw new TypeError('The "buffer" argument must be of type Uint8Array, ArrayBuffer, or string');
        }
        if (typeof data === 'number') {
            throw new TypeError('The "buffer" argument must be of type Uint8Array, ArrayBuffer, or string');
        }
        if (typeof data === 'object' && !(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) {
            throw new TypeError('The "buffer" argument must be of type Uint8Array, ArrayBuffer, or string');
        }
    }
    /** Get the write position, handling append mode and defaults */
    _getWritePosition(position) {
        // Validate negative position
        if (position !== null && position !== undefined && position < 0) {
            const error = new Error('EINVAL: invalid argument, write');
            error.code = 'EINVAL';
            throw error;
        }
        // In append mode, always write at end regardless of specified position
        if (this._appendMode) {
            return this._data.length;
        }
        // null means use current position
        if (position === null) {
            return this._position;
        }
        // undefined means position 0 (default)
        if (position === undefined) {
            return 0;
        }
        return position;
    }
    /**
     * Write bytes at the specified position, extending the file if necessary.
     *
     * Uses Uint8Array.set() for efficient bulk copy operations instead of
     * byte-by-byte iteration. When extending past EOF, gaps are filled with zeros.
     *
     * @param bytes - The bytes to write
     * @param pos - Position in the file to write at
     */
    _writeBytes(bytes, pos) {
        const requiredSize = pos + bytes.length;
        // Extend file buffer if writing past current size
        if (requiredSize > this._data.length) {
            const newData = new Uint8Array(requiredSize);
            // Copy existing data (gaps beyond old size are already zero-initialized)
            newData.set(this._data);
            this._data = newData;
        }
        // Use set() for efficient bulk copy (much faster than byte-by-byte loop)
        this._data.set(bytes, pos);
    }
    /**
     * Update mtime and ctime after a write operation.
     * Called internally by write() to maintain POSIX-compliant timestamp behavior.
     * Also sets the dirty flag to indicate data needs syncing.
     */
    _updateMtime() {
        const now = new Date();
        this._stats = this._buildStatsLike({ mtime: now, ctime: now });
        this._dirty = true;
    }
    /**
     * Get statistics about the open file.
     *
     * Returns a Stats object reflecting the current state of the file,
     * including any pending (unflushed) writes. This is equivalent to
     * the POSIX fstat(2) system call.
     *
     * The returned Stats includes:
     * - **size**: Current file size including pending writes (not yet synced)
     * - **blocks**: Computed from current size (size / blksize, rounded up)
     * - **mtime/ctime**: Updated if writes have occurred since opening
     * - **atime**: Updated to reflect read operations
     * - Other properties (dev, ino, mode, etc.) remain as originally opened
     *
     * @returns A Stats object with current file metadata
     * @throws {Error} If the file handle has been closed
     *
     * @example
     * ```typescript
     * const handle = await fsx.open('/data.txt', 'r+')
     * const stats = await handle.stat()
     * console.log(`File size: ${stats.size} bytes`)
     * console.log(`Is file: ${stats.isFile()}`)
     * console.log(`Last modified: ${stats.mtime}`)
     * await handle.close()
     * ```
     *
     * @example
     * ```typescript
     * // Stats reflect pending writes
     * const handle = await fsx.open('/new.txt', 'w')
     * await handle.write('Hello, World!')
     * const stats = await handle.stat()
     * console.log(stats.size) // 13 (includes unflushed write)
     * ```
     *
     * @see {@link Stats} for available properties and type-checking methods
     * @see {@link FileHandle.sync} to flush pending writes to storage
     */
    async stat() {
        this._ensureOpen();
        // Compute current size from internal buffer (reflects pending writes)
        const currentSize = this._data.length;
        // Compute blocks based on current size
        // Use ceiling division to match POSIX behavior (partial block counts as full)
        const blockSize = this._stats.blksize;
        const blocks = blockSize > 0 ? Math.ceil(currentSize / blockSize) : 0;
        // Build Stats from current internal state
        // Note: mtime/ctime are updated by _updateMtime() on writes
        return new Stats({
            dev: this._stats.dev,
            ino: this._stats.ino,
            mode: this._stats.mode,
            nlink: this._stats.nlink,
            uid: this._stats.uid,
            gid: this._stats.gid,
            rdev: this._stats.rdev,
            size: currentSize,
            blksize: blockSize,
            blocks: blocks,
            atimeMs: this._stats.atime.getTime(),
            mtimeMs: this._stats.mtime.getTime(),
            ctimeMs: this._stats.ctime.getTime(),
            birthtimeMs: this._stats.birthtime.getTime(),
        });
    }
    /**
     * Truncate the file to a specified length.
     *
     * If the file was larger than the specified length, the extra bytes
     * are discarded. If the file was smaller, it is extended with null bytes.
     * Both operations mark the file as dirty and update timestamps.
     *
     * @param length - The new file length in bytes (default: 0)
     * @throws {Error} EBADF if the file handle has been closed
     *
     * @example
     * ```typescript
     * const handle = await fsx.open('/data.txt', 'r+')
     * await handle.truncate(100)  // Truncate or extend to 100 bytes
     * await handle.truncate()     // Truncate to 0 bytes (empty file)
     * ```
     */
    async truncate(length = 0) {
        this._ensureOpen();
        const oldLength = this._data.length;
        if (length < oldLength) {
            this._data = this._data.slice(0, length);
        }
        else if (length > oldLength) {
            const newData = new Uint8Array(length);
            newData.set(this._data);
            this._data = newData;
        }
        // Only mark dirty if size actually changed
        if (length !== oldLength) {
            this._dirty = true;
            const now = new Date();
            this._stats = this._buildStatsLike({ mtime: now, ctime: now });
        }
        else {
            // Update internal stats to reflect size (preserves timestamps)
            this._stats = this._buildStatsLike();
        }
    }
    /**
     * Synchronize the file's in-core state with the storage device.
     *
     * Equivalent to POSIX fsync(2). Ensures that all pending writes are
     * flushed to persistent storage, including both file data and metadata
     * (size, timestamps, permissions, etc.).
     *
     * **Dirty tracking**: This method uses internal dirty tracking to efficiently
     * skip the sync operation when no writes have occurred since the last sync.
     * This is an optimization - calling sync() multiple times is safe and idempotent.
     *
     * **sync vs datasync**: Use sync() when you need to ensure metadata updates
     * (like mtime) are also persisted. Use datasync() when you only need to
     * ensure the file data itself is persisted (which can be more efficient).
     *
     * In the in-memory implementation, this is effectively a no-op since all data
     * is already in memory. The dirty flag is cleared to indicate sync completed.
     *
     * @throws {Error} EBADF if the file handle has been closed
     *
     * @example
     * ```typescript
     * const handle = await fsx.open('/data.txt', 'w')
     * await handle.write('Important data')
     * await handle.sync()  // Ensure data AND metadata are persisted
     * await handle.close()
     * ```
     *
     * @see {@link FileHandle.datasync} for data-only synchronization
     */
    async sync() {
        this._ensureOpen();
        // In a real implementation, this would flush to the storage backend.
        // In the in-memory implementation, data is always "synced" immediately.
        // Clear dirty flag to indicate sync completed successfully.
        this._dirty = false;
    }
    /**
     * Synchronize the file's data (but not metadata) with the storage device.
     *
     * Equivalent to POSIX fdatasync(2). Similar to sync(), but only flushes
     * file data, not metadata like timestamps or permissions. This can be
     * more efficient when you only care about data integrity.
     *
     * **When to use datasync vs sync**:
     * - Use datasync() for performance-critical paths where you only need
     *   to ensure the file content is persisted (e.g., write-ahead logs)
     * - Use sync() when metadata updates (mtime, size) must also be durable
     *   (e.g., before reporting success to users)
     *
     * **Dirty tracking**: Like sync(), this method respects dirty tracking
     * and is idempotent - safe to call multiple times.
     *
     * In the in-memory implementation, this behaves identically to sync()
     * since there's no distinction between data and metadata persistence.
     *
     * @throws {Error} EBADF if the file handle has been closed
     *
     * @example
     * ```typescript
     * const handle = await fsx.open('/wal.log', 'a')
     * await handle.write(logEntry)
     * await handle.datasync()  // Ensure log entry is persisted (fast path)
     * await handle.close()
     * ```
     *
     * @see {@link FileHandle.sync} for full synchronization including metadata
     */
    async datasync() {
        this._ensureOpen();
        // In a real implementation, this would flush data without metadata.
        // In the in-memory implementation, this is equivalent to sync().
        // Clear dirty flag to indicate data sync completed successfully.
        this._dirty = false;
    }
    /**
     * Close the file handle and release any resources.
     *
     * This method is idempotent - calling close() multiple times is safe.
     * After closing, any further operations on this handle will throw an error.
     * It is important to always close file handles when done to free resources.
     *
     * Close behavior:
     * 1. Marks the handle as closed (prevents further operations)
     * 2. Releases internal data buffer (sets to empty array to aid GC)
     * 3. Clears the dirty flag
     *
     * Note: In the base FileHandle class, close() does not perform a flush.
     * Subclasses with actual storage backends should override this to call
     * sync() before closing if needed.
     *
     * @example
     * ```typescript
     * const handle = await fsx.open('/data.txt', 'r')
     * try {
     *   const buffer = new Uint8Array(100)
     *   await handle.read(buffer)
     * } finally {
     *   await handle.close()  // Always close, even on error
     * }
     * ```
     */
    async close() {
        // Idempotent - safe to call multiple times
        if (this._closed) {
            return;
        }
        // Mark as closed first to prevent any operations during cleanup
        this._closed = true;
        // Release resources - use empty array instead of keeping reference
        // to the original data buffer, allowing GC to collect it
        this._data = new Uint8Array(0);
        this._dirty = false;
    }
    /**
     * Async disposable support for 'await using' syntax.
     *
     * Enables automatic cleanup when used with 'await using':
     * ```typescript
     * await using handle = await fsx.open('/file.txt', 'r')
     * // handle is automatically closed when scope exits
     * ```
     *
     * This is the preferred pattern for resource management in modern TypeScript.
     */
    async [Symbol.asyncDispose]() {
        return this.close();
    }
    /** Create readable stream */
    createReadStream(options) {
        this._ensureOpen();
        const start = options?.start ?? 0;
        const end = options?.end ?? this._data.length - 1;
        const data = this._data.slice(start, end + 1);
        const highWaterMark = options?.highWaterMark ?? 16384;
        let offset = 0;
        return new ReadableStream({
            pull(controller) {
                if (offset >= data.length) {
                    controller.close();
                    return;
                }
                const chunk = data.slice(offset, offset + highWaterMark);
                offset += chunk.length;
                controller.enqueue(chunk);
            },
        });
    }
    /** Create writable stream */
    createWriteStream(options) {
        this._ensureOpen();
        let position = options?.start ?? 0;
        const self = this;
        return new WritableStream({
            async write(chunk) {
                await self.write(chunk, position);
                position += chunk.length;
            },
        });
    }
}
// =============================================================================
// Type Guards
// =============================================================================
/**
 * Type guard to check if a value is a Stats instance.
 *
 * @param value - Value to check
 * @returns true if value is a Stats instance
 *
 * @example
 * ```typescript
 * const result = await someOperation()
 * if (isStats(result)) {
 *   console.log(`File size: ${result.size}`)
 * }
 * ```
 */
export function isStats(value) {
    return value instanceof Stats;
}
/**
 * Type guard to check if a value is a Dirent instance.
 *
 * @param value - Value to check
 * @returns true if value is a Dirent instance
 *
 * @example
 * ```typescript
 * const entry = await getEntry()
 * if (isDirent(entry)) {
 *   console.log(`Entry name: ${entry.name}`)
 * }
 * ```
 */
export function isDirent(value) {
    return value instanceof Dirent;
}
/**
 * Type guard to check if a value is a FileHandle instance.
 *
 * @param value - Value to check
 * @returns true if value is a FileHandle instance
 *
 * @example
 * ```typescript
 * const resource = await acquireResource()
 * if (isFileHandle(resource)) {
 *   await resource.close()
 * }
 * ```
 */
export function isFileHandle(value) {
    return value instanceof FileHandle;
}
/**
 * Type guard to check if a value is a valid FileType.
 *
 * @param value - Value to check
 * @returns true if value is a valid FileType string
 *
 * @example
 * ```typescript
 * const type = getTypeFromInput(userInput)
 * if (isFileType(type)) {
 *   handleFileType(type)
 * }
 * ```
 */
export function isFileType(value) {
    return (value === 'file' ||
        value === 'directory' ||
        value === 'symlink' ||
        value === 'block' ||
        value === 'character' ||
        value === 'fifo' ||
        value === 'socket');
}
/**
 * Type guard to check if a value is a valid StorageTier.
 *
 * @param value - Value to check
 * @returns true if value is a valid StorageTier string
 *
 * @example
 * ```typescript
 * const tier = parseTier(config.tier)
 * if (isStorageTier(tier)) {
 *   await fs.write('/file', data, { tier })
 * }
 * ```
 */
export function isStorageTier(value) {
    return value === 'hot' || value === 'warm' || value === 'cold';
}
/**
 * Type guard to check if a value conforms to StatsLike interface.
 *
 * Performs runtime structural check to verify an object has all
 * required Stats properties and methods.
 *
 * @param value - Value to check
 * @returns true if value conforms to StatsLike interface
 *
 * @example
 * ```typescript
 * function processAnyStats(stats: unknown): void {
 *   if (isStatsLike(stats)) {
 *     console.log(`Size: ${stats.size}`)
 *   }
 * }
 * ```
 */
export function isStatsLike(value) {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    const obj = value;
    return (typeof obj.dev === 'number' &&
        typeof obj.ino === 'number' &&
        typeof obj.mode === 'number' &&
        typeof obj.size === 'number' &&
        typeof obj.isFile === 'function' &&
        typeof obj.isDirectory === 'function');
}
//# sourceMappingURL=types.js.map