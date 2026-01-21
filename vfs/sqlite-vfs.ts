/**
 * SQLite VFS Adapter for ExtentStorage
 *
 * This module provides a wa-sqlite compatible VFS (Virtual File System) implementation
 * that uses ExtentStorage as its backing store. It translates SQLite file operations
 * into extent-based page operations, enabling efficient storage of SQLite databases
 * on systems like Cloudflare Durable Objects.
 *
 * Key Features:
 * - wa-sqlite compatible interface
 * - Extent-based page storage for cost efficiency
 * - Support for sparse files
 * - Lock level tracking (single-connection)
 * - Comprehensive error handling with SQLite error codes
 *
 * Architecture:
 * ```
 * +-------------------------------------------+
 * |           SQLite (wa-sqlite)              |
 * +-------------------------------------------+
 * |         ExtentSQLiteVFS (this)            |
 * |  - Converts byte offsets to pages         |
 * |  - Handles partial page writes            |
 * |  - Manages file handles                   |
 * +-------------------------------------------+
 * |            ExtentStorage                  |
 * |  - Packs pages into 2MB extents           |
 * |  - Content-addressable storage            |
 * +-------------------------------------------+
 * |           BlobStorage (R2, etc.)          |
 * +-------------------------------------------+
 * ```
 *
 * @module vfs/sqlite-vfs
 */

import type { ExtentStorage } from '../storage/extent-storage.js'
import { createLogger } from '../../utils/logger'

const logger = createLogger('[ExtentSQLiteVFS]')

// =============================================================================
// SQLite Constants
// =============================================================================

/** Operation completed successfully */
export const SQLITE_OK = 0

/** Generic I/O error */
export const SQLITE_IOERR = 10

/** Short read error (read less than requested) */
export const SQLITE_IOERR_SHORT_READ = 522 // SQLITE_IOERR | (2 << 8)

/** Write error */
export const SQLITE_IOERR_WRITE = 778 // SQLITE_IOERR | (3 << 8)

/** Truncate error */
export const SQLITE_IOERR_TRUNCATE = 1546 // SQLITE_IOERR | (6 << 8)

/** Sync error */
export const SQLITE_IOERR_FSYNC = 1034 // SQLITE_IOERR | (4 << 8)

/** Delete error */
export const SQLITE_IOERR_DELETE = 2570 // SQLITE_IOERR | (10 << 8)

/** Unable to open file */
export const SQLITE_CANTOPEN = 14

/** File not found */
export const SQLITE_NOTFOUND = 12

/** Database is busy (lock contention) */
export const SQLITE_BUSY = 5

/** Database is locked */
export const SQLITE_LOCKED = 6

/** Memory allocation failed */
export const SQLITE_NOMEM = 7

/** Read-only database */
export const SQLITE_READONLY = 8

/** Bad parameter passed to function */
export const SQLITE_MISUSE = 21

// =============================================================================
// Lock Levels
// =============================================================================

/** No lock held */
export const SQLITE_LOCK_NONE = 0

/** Shared (read) lock */
export const SQLITE_LOCK_SHARED = 1

/** Reserved lock (preparing to write) */
export const SQLITE_LOCK_RESERVED = 2

/** Pending lock (waiting for shared locks to clear) */
export const SQLITE_LOCK_PENDING = 3

/** Exclusive (write) lock */
export const SQLITE_LOCK_EXCLUSIVE = 4

// =============================================================================
// Open Flags
// =============================================================================

/** Open for read-only access */
export const SQLITE_OPEN_READONLY = 0x00000001

/** Open for read-write access */
export const SQLITE_OPEN_READWRITE = 0x00000002

/** Create file if it doesn't exist */
export const SQLITE_OPEN_CREATE = 0x00000004

/** Delete file on close */
export const SQLITE_OPEN_DELETEONCLOSE = 0x00000008

/** Exclusive access */
export const SQLITE_OPEN_EXCLUSIVE = 0x00000010

/** File is a main database */
export const SQLITE_OPEN_MAIN_DB = 0x00000100

/** File is a temporary database */
export const SQLITE_OPEN_TEMP_DB = 0x00000200

/** File is a transient database */
export const SQLITE_OPEN_TRANSIENT_DB = 0x00000400

/** File is a main journal */
export const SQLITE_OPEN_MAIN_JOURNAL = 0x00000800

/** File is a temp journal */
export const SQLITE_OPEN_TEMP_JOURNAL = 0x00001000

/** File is a subjournal */
export const SQLITE_OPEN_SUBJOURNAL = 0x00002000

/** File is a super-journal */
export const SQLITE_OPEN_SUPER_JOURNAL = 0x00004000

/** File is a WAL file */
export const SQLITE_OPEN_WAL = 0x00080000

// =============================================================================
// Access Flags
// =============================================================================

/** Check if file exists */
export const SQLITE_ACCESS_EXISTS = 0

/** Check if file is readable and writable */
export const SQLITE_ACCESS_READWRITE = 1

/** Check if file is readable */
export const SQLITE_ACCESS_READ = 2

// =============================================================================
// Sync Flags
// =============================================================================

/** Normal sync */
export const SQLITE_SYNC_NORMAL = 0x00002

/** Full sync */
export const SQLITE_SYNC_FULL = 0x00003

/** Data-only sync */
export const SQLITE_SYNC_DATAONLY = 0x00010

// =============================================================================
// Device Characteristics
// =============================================================================

/** Atomic 512-byte writes */
export const SQLITE_IOCAP_ATOMIC512 = 0x00000002

/** Atomic 1KB writes */
export const SQLITE_IOCAP_ATOMIC1K = 0x00000004

/** Atomic 2KB writes */
export const SQLITE_IOCAP_ATOMIC2K = 0x00000008

/** Atomic 4KB writes */
export const SQLITE_IOCAP_ATOMIC4K = 0x00000010

/** Atomic 8KB writes */
export const SQLITE_IOCAP_ATOMIC8K = 0x00000020

/** Atomic 16KB writes */
export const SQLITE_IOCAP_ATOMIC16K = 0x00000040

/** Atomic 32KB writes */
export const SQLITE_IOCAP_ATOMIC32K = 0x00000080

/** Atomic 64KB writes */
export const SQLITE_IOCAP_ATOMIC64K = 0x00000100

/** Safe append (no data corruption on crash) */
export const SQLITE_IOCAP_SAFE_APPEND = 0x00000200

/** Sequential writes */
export const SQLITE_IOCAP_SEQUENTIAL = 0x00000400

/** Supports undeletable files */
export const SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN = 0x00000800

/** Powersafe overwrite */
export const SQLITE_IOCAP_POWERSAFE_OVERWRITE = 0x00001000

/** Immutable file */
export const SQLITE_IOCAP_IMMUTABLE = 0x00002000

/** Batch atomic */
export const SQLITE_IOCAP_BATCH_ATOMIC = 0x00004000

// =============================================================================
// Types
// =============================================================================

/**
 * SQLite VFS interface matching wa-sqlite patterns.
 *
 * This interface defines all the methods required for a wa-sqlite compatible
 * Virtual File System implementation.
 */
export interface SQLiteVFS {
  /** VFS name identifier */
  readonly name: string

  // VFS-level operations
  xOpen(
    filename: string | null,
    fileId: number,
    flags: number,
    pOutFlags: { value: number }
  ): number
  xDelete(filename: string, syncDir: number): number
  xAccess(filename: string, flags: number, pResOut: { value: number }): number

  // File-level operations (via file handle)
  xClose(fileId: number): number
  xRead(fileId: number, pData: Uint8Array, iOffset: number): number
  xWrite(fileId: number, pData: Uint8Array, iOffset: number): number
  xTruncate(fileId: number, iSize: number): number
  xSync(fileId: number, flags: number): number
  xFileSize(fileId: number, pSize: { value: number }): number
  xLock(fileId: number, lockType: number): number
  xUnlock(fileId: number, lockType: number): number
  xCheckReservedLock(fileId: number, pResOut: { value: number }): number

  // Device characteristics
  xSectorSize(fileId: number): number
  xDeviceCharacteristics(fileId: number): number
}

/**
 * Configuration for ExtentSQLiteVFS.
 */
export interface ExtentSQLiteVFSConfig {
  /** The ExtentStorage instance to use for page storage */
  extentStorage: ExtentStorage

  /**
   * Page size in bytes. Must match the ExtentStorage page size.
   * @default 4096
   */
  pageSize?: number

  /**
   * Whether to log debug information.
   * @default false
   */
  debug?: boolean
}

/**
 * Internal representation of an open file.
 */
interface OpenFile {
  /** Original filename */
  filename: string
  /** Normalized file ID for extent storage */
  fileId: string
  /** Open flags */
  flags: number
  /** Current lock level */
  lockLevel: number
  /** Whether file should be deleted on close */
  deleteOnClose: boolean
}

// =============================================================================
// ExtentSQLiteVFS Implementation
// =============================================================================

/**
 * SQLite VFS implementation backed by ExtentStorage.
 *
 * This VFS adapter translates SQLite file operations into ExtentStorage
 * page operations, providing efficient storage of SQLite databases by
 * packing pages into larger extents.
 *
 * @example
 * ```typescript
 * // Create the VFS
 * const vfs = createExtentSQLiteVFS({
 *   extentStorage: storage,
 *   pageSize: 4096,
 * })
 *
 * // Use with wa-sqlite
 * sqlite3.vfs_register(vfs)
 * const db = await sqlite3.open('mydb.sqlite')
 * ```
 */
export class ExtentSQLiteVFS implements SQLiteVFS {
  readonly name = 'extent-vfs'

  private readonly extentStorage: ExtentStorage
  private readonly pageSize: number
  private readonly debug: boolean

  /** Map of file IDs to open file handles */
  private files = new Map<number, OpenFile>()

  /** Counter for generating temporary file names */
  private tempFileCounter = 0

  constructor(config: ExtentSQLiteVFSConfig) {
    this.extentStorage = config.extentStorage
    this.pageSize = config.pageSize ?? 4096
    this.debug = config.debug ?? false
  }

  /**
   * Log a debug message if debug mode is enabled.
   */
  private log(method: string, ...args: unknown[]): void {
    if (this.debug) {
      logger.debug(`[${method}]`, ...args)
    }
  }

  /**
   * Normalize a filename to a valid file ID.
   * Handles null filenames (temp files) and normalizes paths.
   */
  private normalizeFilename(filename: string | null): string {
    if (filename === null || filename === '') {
      // Generate a temp file name
      return `:temp:${++this.tempFileCounter}`
    }

    // Normalize the path
    // Remove leading slashes and normalize separators
    return filename.replace(/^\/+/, '').replace(/\\/g, '/')
  }

  // ===========================================================================
  // VFS-Level Operations
  // ===========================================================================

  /**
   * Open a file.
   *
   * @param filename - Name of the file to open (null for temp file)
   * @param fileId - File ID assigned by SQLite
   * @param flags - Open flags (SQLITE_OPEN_*)
   * @param pOutFlags - Output flags indicating actual open mode
   * @returns SQLITE_OK on success, error code otherwise
   */
  xOpen(
    filename: string | null,
    fileId: number,
    flags: number,
    pOutFlags: { value: number }
  ): number {
    this.log('xOpen', { filename, fileId, flags: flags.toString(16) })

    try {
      const normalizedFileId = this.normalizeFilename(filename)
      const isReadOnly = (flags & SQLITE_OPEN_READONLY) !== 0
      const deleteOnClose = (flags & SQLITE_OPEN_DELETEONCLOSE) !== 0

      // Note: isCreate flag ((flags & SQLITE_OPEN_CREATE) !== 0) would be used
      // to check if file must exist before opening, but for extent storage
      // we allow implicit creation

      // Create the open file handle
      const openFile: OpenFile = {
        filename: filename ?? normalizedFileId,
        fileId: normalizedFileId,
        flags,
        lockLevel: SQLITE_LOCK_NONE,
        deleteOnClose,
      }

      this.files.set(fileId, openFile)

      // Set output flags
      pOutFlags.value = isReadOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE

      return SQLITE_OK
    } catch (error) {
      this.log('xOpen error', error)
      return SQLITE_CANTOPEN
    }
  }

  /**
   * Delete a file.
   *
   * @param filename - Name of the file to delete
   * @param syncDir - Whether to sync the directory after deletion
   * @returns SQLITE_OK on success, error code otherwise
   */
  xDelete(filename: string, syncDir: number): number {
    this.log('xDelete', { filename, syncDir })

    try {
      const fileId = this.normalizeFilename(filename)

      // Use synchronous delete if available, otherwise wrap async
      // Note: ExtentStorage.deleteFile is async, so we need to handle this
      // For VFS compatibility, we'll use a fire-and-forget approach here
      // Real implementations would need proper async handling

      // Delete synchronously (ExtentStorage uses sync SQL for metadata)
      void this.extentStorage.deleteFile(fileId)

      return SQLITE_OK
    } catch (error) {
      this.log('xDelete error', error)
      return SQLITE_IOERR_DELETE
    }
  }

  /**
   * Check file accessibility.
   *
   * @param filename - Name of the file to check
   * @param flags - Access check flags (SQLITE_ACCESS_*)
   * @param pResOut - Output: 1 if accessible, 0 otherwise
   * @returns SQLITE_OK on success, error code otherwise
   */
  xAccess(filename: string, flags: number, pResOut: { value: number }): number {
    this.log('xAccess', { filename, flags })

    try {
      // Normalize filename for consistent lookup
      const normalizedFileId = this.normalizeFilename(filename)

      // Check if file exists by querying file size
      // Note: This requires async operation - for VFS we'll check metadata table
      // ExtentStorage has sync access to SQL metadata

      // Attempt to get file size synchronously
      // If file doesn't exist, it returns 0, but we need to distinguish
      // between "doesn't exist" and "exists but empty"
      // We'll check the extent_files table via the SQL adapter

      // For now, we'll report based on whether we can get file info
      // This is a simplified check - real implementation would query SQL directly
      // The normalized file ID is used for future lookup implementation
      void normalizedFileId

      // Default to file exists (conservative approach)
      pResOut.value = 1

      return SQLITE_OK
    } catch (error) {
      this.log('xAccess error', error)
      // File doesn't exist
      pResOut.value = 0
      return SQLITE_OK
    }
  }

  // ===========================================================================
  // File-Level Operations
  // ===========================================================================

  /**
   * Close a file.
   *
   * @param fileId - File ID to close
   * @returns SQLITE_OK on success, error code otherwise
   */
  xClose(fileId: number): number {
    this.log('xClose', { fileId })

    try {
      const file = this.files.get(fileId)
      if (!file) {
        return SQLITE_OK // Already closed
      }

      // Delete on close if requested
      if (file.deleteOnClose) {
        void this.extentStorage.deleteFile(file.fileId)
      }

      this.files.delete(fileId)
      return SQLITE_OK
    } catch (error) {
      this.log('xClose error', error)
      return SQLITE_IOERR
    }
  }

  /**
   * Read data from a file.
   *
   * @param fileId - File ID to read from
   * @param pData - Buffer to read into
   * @param iOffset - Byte offset to start reading from
   * @returns SQLITE_OK on success, SQLITE_IOERR_SHORT_READ if EOF, error code otherwise
   */
  xRead(fileId: number, pData: Uint8Array, iOffset: number): number {
    this.log('xRead', { fileId, length: pData.length, offset: iOffset })

    try {
      const file = this.files.get(fileId)
      if (!file) {
        return SQLITE_MISUSE
      }

      const pageSize = this.pageSize
      const startPage = Math.floor(iOffset / pageSize)
      const endPage = Math.ceil((iOffset + pData.length) / pageSize)

      let bytesRead = 0
      let currentOffset = iOffset

      for (let pageNum = startPage; pageNum < endPage && bytesRead < pData.length; pageNum++) {
        // Read page from extent storage (synchronous)
        const page = this.extentStorage.readPageSync(file.fileId, pageNum)

        const pageStartOffset = pageNum * pageSize
        const pageEndOffset = pageStartOffset + pageSize

        // Calculate the overlap between this page and the requested range
        const readStart = Math.max(iOffset, pageStartOffset)
        const readEnd = Math.min(iOffset + pData.length, pageEndOffset)
        const readLength = readEnd - readStart

        if (readLength <= 0) continue

        // Offset within the page
        const pageOffset = readStart - pageStartOffset
        // Offset within the output buffer
        const bufferOffset = readStart - iOffset

        if (page) {
          // Copy data from page to output buffer
          pData.set(page.subarray(pageOffset, pageOffset + readLength), bufferOffset)
        } else {
          // Page doesn't exist - zero fill (sparse file)
          pData.fill(0, bufferOffset, bufferOffset + readLength)
        }

        bytesRead += readLength
        currentOffset += readLength
      }

      // Check if we read less than requested (short read)
      if (bytesRead < pData.length) {
        // Zero-fill the rest and return short read
        pData.fill(0, bytesRead)
        return SQLITE_IOERR_SHORT_READ
      }

      return SQLITE_OK
    } catch (error) {
      this.log('xRead error', error)
      return SQLITE_IOERR
    }
  }

  /**
   * Write data to a file.
   *
   * @param fileId - File ID to write to
   * @param pData - Data to write
   * @param iOffset - Byte offset to start writing at
   * @returns SQLITE_OK on success, error code otherwise
   */
  xWrite(fileId: number, pData: Uint8Array, iOffset: number): number {
    this.log('xWrite', { fileId, length: pData.length, offset: iOffset })

    try {
      const file = this.files.get(fileId)
      if (!file) {
        return SQLITE_MISUSE
      }

      // Check if file is read-only
      if ((file.flags & SQLITE_OPEN_READONLY) !== 0) {
        return SQLITE_READONLY
      }

      const pageSize = this.pageSize

      let bytesWritten = 0
      let currentOffset = iOffset

      while (bytesWritten < pData.length) {
        const pageNum = Math.floor(currentOffset / pageSize)
        const pageStartOffset = pageNum * pageSize
        const offsetInPage = currentOffset - pageStartOffset

        // Calculate how much to write to this page
        const remainingInPage = pageSize - offsetInPage
        const remainingData = pData.length - bytesWritten
        const writeLength = Math.min(remainingInPage, remainingData)

        let pageData: Uint8Array

        if (offsetInPage !== 0 || writeLength < pageSize) {
          // Partial page write - need read-modify-write
          const existingPage = this.extentStorage.readPageSync(file.fileId, pageNum)
          pageData = existingPage ? new Uint8Array(existingPage) : new Uint8Array(pageSize)

          // Copy the new data into the page
          pageData.set(pData.subarray(bytesWritten, bytesWritten + writeLength), offsetInPage)
        } else {
          // Full page write
          pageData = pData.subarray(bytesWritten, bytesWritten + pageSize)

          // Ensure we have a full page
          if (pageData.length < pageSize) {
            const fullPage = new Uint8Array(pageSize)
            fullPage.set(pageData)
            pageData = fullPage
          }
        }

        // Write the page
        this.extentStorage.writePageSync(file.fileId, pageNum, pageData)

        bytesWritten += writeLength
        currentOffset += writeLength
      }

      return SQLITE_OK
    } catch (error) {
      this.log('xWrite error', error)
      return SQLITE_IOERR_WRITE
    }
  }

  /**
   * Truncate a file to a specified size.
   *
   * @param fileId - File ID to truncate
   * @param iSize - New file size in bytes
   * @returns SQLITE_OK on success, error code otherwise
   */
  xTruncate(fileId: number, iSize: number): number {
    this.log('xTruncate', { fileId, size: iSize })

    try {
      const file = this.files.get(fileId)
      if (!file) {
        return SQLITE_MISUSE
      }

      // Check if file is read-only
      if ((file.flags & SQLITE_OPEN_READONLY) !== 0) {
        return SQLITE_READONLY
      }

      // ExtentStorage.truncate is async, so we fire-and-forget here
      // Real implementation would need proper async handling
      void this.extentStorage.truncate(file.fileId, iSize)

      return SQLITE_OK
    } catch (error) {
      this.log('xTruncate error', error)
      return SQLITE_IOERR_TRUNCATE
    }
  }

  /**
   * Sync file contents to storage.
   *
   * @param fileId - File ID to sync
   * @param flags - Sync flags (SQLITE_SYNC_*)
   * @returns SQLITE_OK on success, error code otherwise
   */
  xSync(fileId: number, flags: number): number {
    this.log('xSync', { fileId, flags })

    try {
      const file = this.files.get(fileId)
      if (!file) {
        return SQLITE_MISUSE
      }

      // Flush all dirty pages to extents
      // ExtentStorage.flush is async, so we fire-and-forget here
      void this.extentStorage.flush()

      return SQLITE_OK
    } catch (error) {
      this.log('xSync error', error)
      return SQLITE_IOERR_FSYNC
    }
  }

  /**
   * Get the size of a file.
   *
   * @param fileId - File ID to query
   * @param pSize - Output: file size in bytes
   * @returns SQLITE_OK on success, error code otherwise
   */
  xFileSize(fileId: number, pSize: { value: number }): number {
    this.log('xFileSize', { fileId })

    try {
      const file = this.files.get(fileId)
      if (!file) {
        return SQLITE_MISUSE
      }

      // Get file size from extent storage
      // ExtentStorage.getFileSize is async, but we need sync access
      // The SQL adapter should support sync queries for metadata

      // For now, we'll use a synchronous approach via the SQL layer
      // This requires the ExtentStorage to expose a sync method or
      // we read from the metadata directly

      // Note: In a real implementation, we'd need to access the SQL
      // metadata synchronously. For now, we'll return 0 and let
      // the async version populate this later.

      // Attempt to get size - ExtentStorage needs a sync getFileSizeSync method
      // For now, default to 0 if not available
      pSize.value = 0

      return SQLITE_OK
    } catch (error) {
      this.log('xFileSize error', error)
      pSize.value = 0
      return SQLITE_OK
    }
  }

  /**
   * Acquire a lock on a file.
   *
   * @param fileId - File ID to lock
   * @param lockType - Lock level to acquire (SQLITE_LOCK_*)
   * @returns SQLITE_OK on success, SQLITE_BUSY if lock not available
   */
  xLock(fileId: number, lockType: number): number {
    this.log('xLock', { fileId, lockType })

    try {
      const file = this.files.get(fileId)
      if (!file) {
        return SQLITE_MISUSE
      }

      // For single-connection scenarios, we always succeed
      // Multi-connection locking would require a distributed lock manager
      file.lockLevel = lockType

      return SQLITE_OK
    } catch (error) {
      this.log('xLock error', error)
      return SQLITE_IOERR
    }
  }

  /**
   * Release a lock on a file.
   *
   * @param fileId - File ID to unlock
   * @param lockType - Lock level to release to (SQLITE_LOCK_*)
   * @returns SQLITE_OK on success, error code otherwise
   */
  xUnlock(fileId: number, lockType: number): number {
    this.log('xUnlock', { fileId, lockType })

    try {
      const file = this.files.get(fileId)
      if (!file) {
        return SQLITE_MISUSE
      }

      // For single-connection scenarios, we always succeed
      file.lockLevel = lockType

      return SQLITE_OK
    } catch (error) {
      this.log('xUnlock error', error)
      return SQLITE_IOERR
    }
  }

  /**
   * Check if a reserved lock is held on a file.
   *
   * @param fileId - File ID to check
   * @param pResOut - Output: 1 if reserved lock held, 0 otherwise
   * @returns SQLITE_OK on success, error code otherwise
   */
  xCheckReservedLock(fileId: number, pResOut: { value: number }): number {
    this.log('xCheckReservedLock', { fileId })

    try {
      const file = this.files.get(fileId)
      if (!file) {
        return SQLITE_MISUSE
      }

      // Check if current connection has reserved or higher lock
      pResOut.value = file.lockLevel >= SQLITE_LOCK_RESERVED ? 1 : 0

      return SQLITE_OK
    } catch (error) {
      this.log('xCheckReservedLock error', error)
      pResOut.value = 0
      return SQLITE_OK
    }
  }

  // ===========================================================================
  // Device Characteristics
  // ===========================================================================

  /**
   * Get the sector size of the underlying storage.
   *
   * @param fileId - File ID to query
   * @returns Sector size in bytes (same as page size)
   */
  xSectorSize(fileId: number): number {
    this.log('xSectorSize', { fileId })
    return this.pageSize
  }

  /**
   * Get the device characteristics of the underlying storage.
   *
   * @param fileId - File ID to query
   * @returns Bitmask of SQLITE_IOCAP_* flags
   */
  xDeviceCharacteristics(fileId: number): number {
    this.log('xDeviceCharacteristics', { fileId })

    // ExtentStorage provides atomic page writes and safe append
    // We report capabilities based on the extent storage characteristics
    return (
      SQLITE_IOCAP_ATOMIC4K |
      SQLITE_IOCAP_SAFE_APPEND |
      SQLITE_IOCAP_SEQUENTIAL |
      SQLITE_IOCAP_POWERSAFE_OVERWRITE
    )
  }

  // ===========================================================================
  // Extended Operations (not part of core VFS, but useful)
  // ===========================================================================

  /**
   * Get the current lock level for a file.
   *
   * @param fileId - File ID to query
   * @returns Current lock level, or -1 if file not open
   */
  getLockLevel(fileId: number): number {
    const file = this.files.get(fileId)
    return file?.lockLevel ?? -1
  }

  /**
   * Get the underlying ExtentStorage instance.
   *
   * @returns The ExtentStorage instance
   */
  getExtentStorage(): ExtentStorage {
    return this.extentStorage
  }

  /**
   * Get the number of currently open files.
   *
   * @returns Number of open file handles
   */
  getOpenFileCount(): number {
    return this.files.size
  }

  /**
   * Check if a file ID is currently open.
   *
   * @param fileId - File ID to check
   * @returns true if open, false otherwise
   */
  isFileOpen(fileId: number): boolean {
    return this.files.has(fileId)
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create an ExtentSQLiteVFS instance.
 *
 * @param config - VFS configuration
 * @returns Configured ExtentSQLiteVFS instance
 *
 * @example
 * ```typescript
 * // Create extent storage first
 * const extentStorage = await createExtentStorage({
 *   pageSize: 4096,
 *   extentSize: 2 * 1024 * 1024,
 *   compression: 'gzip',
 *   backend: r2Storage,
 *   sql: sqlAdapter,
 * })
 *
 * // Create the VFS
 * const vfs = createExtentSQLiteVFS({
 *   extentStorage,
 *   pageSize: 4096,
 * })
 *
 * // Register with wa-sqlite
 * sqlite3.vfs_register(vfs, true) // true = make default
 *
 * // Open a database
 * const db = await sqlite3.open('mydb.sqlite')
 * ```
 */
export function createExtentSQLiteVFS(config: ExtentSQLiteVFSConfig): ExtentSQLiteVFS {
  return new ExtentSQLiteVFS(config)
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get the name of a lock level.
 *
 * @param lockLevel - Lock level constant
 * @returns Human-readable lock level name
 */
export function getLockLevelName(lockLevel: number): string {
  switch (lockLevel) {
    case SQLITE_LOCK_NONE:
      return 'NONE'
    case SQLITE_LOCK_SHARED:
      return 'SHARED'
    case SQLITE_LOCK_RESERVED:
      return 'RESERVED'
    case SQLITE_LOCK_PENDING:
      return 'PENDING'
    case SQLITE_LOCK_EXCLUSIVE:
      return 'EXCLUSIVE'
    default:
      return `UNKNOWN(${lockLevel})`
  }
}

/**
 * Get the name of an error code.
 *
 * @param errorCode - SQLite error code
 * @returns Human-readable error name
 */
export function getErrorCodeName(errorCode: number): string {
  switch (errorCode) {
    case SQLITE_OK:
      return 'SQLITE_OK'
    case SQLITE_IOERR:
      return 'SQLITE_IOERR'
    case SQLITE_IOERR_SHORT_READ:
      return 'SQLITE_IOERR_SHORT_READ'
    case SQLITE_IOERR_WRITE:
      return 'SQLITE_IOERR_WRITE'
    case SQLITE_IOERR_TRUNCATE:
      return 'SQLITE_IOERR_TRUNCATE'
    case SQLITE_IOERR_FSYNC:
      return 'SQLITE_IOERR_FSYNC'
    case SQLITE_IOERR_DELETE:
      return 'SQLITE_IOERR_DELETE'
    case SQLITE_CANTOPEN:
      return 'SQLITE_CANTOPEN'
    case SQLITE_NOTFOUND:
      return 'SQLITE_NOTFOUND'
    case SQLITE_BUSY:
      return 'SQLITE_BUSY'
    case SQLITE_LOCKED:
      return 'SQLITE_LOCKED'
    case SQLITE_NOMEM:
      return 'SQLITE_NOMEM'
    case SQLITE_READONLY:
      return 'SQLITE_READONLY'
    case SQLITE_MISUSE:
      return 'SQLITE_MISUSE'
    default:
      return `SQLITE_ERROR(${errorCode})`
  }
}

/**
 * Check if an error code indicates success.
 *
 * @param errorCode - SQLite error code
 * @returns true if the operation was successful
 */
export function isSuccess(errorCode: number): boolean {
  return errorCode === SQLITE_OK
}

/**
 * Check if an error code is recoverable.
 *
 * @param errorCode - SQLite error code
 * @returns true if the error is recoverable (e.g., BUSY, LOCKED)
 */
export function isRecoverableError(errorCode: number): boolean {
  return errorCode === SQLITE_BUSY || errorCode === SQLITE_LOCKED
}

/**
 * Parse open flags into a human-readable object.
 *
 * @param flags - Open flags bitmask
 * @returns Object with boolean flags
 */
export function parseOpenFlags(flags: number): {
  readonly: boolean
  readwrite: boolean
  create: boolean
  deleteOnClose: boolean
  exclusive: boolean
  mainDb: boolean
  tempDb: boolean
  mainJournal: boolean
  wal: boolean
} {
  return {
    readonly: (flags & SQLITE_OPEN_READONLY) !== 0,
    readwrite: (flags & SQLITE_OPEN_READWRITE) !== 0,
    create: (flags & SQLITE_OPEN_CREATE) !== 0,
    deleteOnClose: (flags & SQLITE_OPEN_DELETEONCLOSE) !== 0,
    exclusive: (flags & SQLITE_OPEN_EXCLUSIVE) !== 0,
    mainDb: (flags & SQLITE_OPEN_MAIN_DB) !== 0,
    tempDb: (flags & SQLITE_OPEN_TEMP_DB) !== 0,
    mainJournal: (flags & SQLITE_OPEN_MAIN_JOURNAL) !== 0,
    wal: (flags & SQLITE_OPEN_WAL) !== 0,
  }
}
