/**
 * POSIX Filesystem Constants
 *
 * This module provides POSIX-compatible filesystem constants for use with fsx.do.
 * All values follow the POSIX.1-2017 standard (IEEE Std 1003.1-2017).
 *
 * @see https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/sys_stat.h.html
 * @see https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/fcntl.h.html
 * @see https://pubs.opengroup.org/onlinepubs/9699919799/basedefs/unistd.h.html
 *
 * @module
 */
/**
 * Test for existence of file.
 * @example
 * ```typescript
 * import { constants } from 'fsx.do'
 * await fs.access('/path/to/file', constants.F_OK)
 * ```
 */
export declare const F_OK = 0;
/**
 * Test for read permission.
 * Value: 4 (binary: 100)
 * @example
 * ```typescript
 * await fs.access('/path/to/file', constants.R_OK)
 * ```
 */
export declare const R_OK = 4;
/**
 * Test for write permission.
 * Value: 2 (binary: 010)
 * @example
 * ```typescript
 * await fs.access('/path/to/file', constants.W_OK)
 * ```
 */
export declare const W_OK = 2;
/**
 * Test for execute permission.
 * Value: 1 (binary: 001)
 * @example
 * ```typescript
 * await fs.access('/path/to/file', constants.X_OK)
 * ```
 */
export declare const X_OK = 1;
/**
 * Open for reading only.
 * Value: 0
 * @example
 * ```typescript
 * const fd = await fs.open('/file.txt', constants.O_RDONLY)
 * ```
 */
export declare const O_RDONLY = 0;
/**
 * Open for writing only.
 * Value: 1
 * @example
 * ```typescript
 * const fd = await fs.open('/file.txt', constants.O_WRONLY | constants.O_CREAT)
 * ```
 */
export declare const O_WRONLY = 1;
/**
 * Open for reading and writing.
 * Value: 2
 * @example
 * ```typescript
 * const fd = await fs.open('/file.txt', constants.O_RDWR)
 * ```
 */
export declare const O_RDWR = 2;
/**
 * Create file if it does not exist.
 * Value: 64 (0x40)
 *
 * When used, the mode argument specifies the file mode bits.
 * @example
 * ```typescript
 * const fd = await fs.open('/new.txt', constants.O_WRONLY | constants.O_CREAT, 0o644)
 * ```
 */
export declare const O_CREAT = 64;
/**
 * Exclusive use flag. Fail if file exists (when used with O_CREAT).
 * Value: 128 (0x80)
 *
 * Ensures atomic file creation - prevents race conditions.
 * @example
 * ```typescript
 * // Create file only if it doesn't exist
 * const fd = await fs.open('/lock.txt', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
 * ```
 */
export declare const O_EXCL = 128;
/**
 * Truncate file to zero length.
 * Value: 512 (0x200)
 *
 * If the file exists and is a regular file, truncate it to length 0.
 * @example
 * ```typescript
 * const fd = await fs.open('/file.txt', constants.O_WRONLY | constants.O_TRUNC)
 * ```
 */
export declare const O_TRUNC = 512;
/**
 * Set append mode. Writes always occur at end of file.
 * Value: 1024 (0x400)
 *
 * The file offset is positioned at the end before each write.
 * @example
 * ```typescript
 * const fd = await fs.open('/log.txt', constants.O_WRONLY | constants.O_APPEND)
 * ```
 */
export declare const O_APPEND = 1024;
/**
 * Synchronized I/O file integrity completion.
 * Value: 4096 (0x1000)
 *
 * Write operations complete as defined by synchronized I/O file integrity completion.
 * @example
 * ```typescript
 * const fd = await fs.open('/critical.dat', constants.O_WRONLY | constants.O_SYNC)
 * ```
 */
export declare const O_SYNC = 4096;
/**
 * Fail if not a directory.
 * Value: 65536 (0x10000)
 *
 * If the path resolves to a non-directory file, fail with ENOTDIR.
 * @example
 * ```typescript
 * const fd = await fs.open('/must/be/dir', constants.O_RDONLY | constants.O_DIRECTORY)
 * ```
 */
export declare const O_DIRECTORY = 65536;
/**
 * Do not follow symbolic links.
 * Value: 131072 (0x20000)
 *
 * If the path refers to a symbolic link, fail with ELOOP.
 * @example
 * ```typescript
 * const fd = await fs.open('/maybe/symlink', constants.O_RDONLY | constants.O_NOFOLLOW)
 * ```
 */
export declare const O_NOFOLLOW = 131072;
/**
 * File type mask for extracting file type from mode.
 * Value: 0o170000 (61440 decimal, 0xF000)
 *
 * Use with bitwise AND to extract the file type bits.
 * @example
 * ```typescript
 * const fileType = mode & constants.S_IFMT
 * const isRegular = fileType === constants.S_IFREG
 * ```
 */
export declare const S_IFMT = 61440;
/**
 * Regular file type.
 * Value: 0o100000 (32768 decimal, 0x8000)
 * @example
 * ```typescript
 * if ((mode & constants.S_IFMT) === constants.S_IFREG) {
 *   console.log('This is a regular file')
 * }
 * ```
 */
export declare const S_IFREG = 32768;
/**
 * Directory type.
 * Value: 0o040000 (16384 decimal, 0x4000)
 * @example
 * ```typescript
 * if ((mode & constants.S_IFMT) === constants.S_IFDIR) {
 *   console.log('This is a directory')
 * }
 * ```
 */
export declare const S_IFDIR = 16384;
/**
 * Symbolic link type.
 * Value: 0o120000 (40960 decimal, 0xA000)
 * @example
 * ```typescript
 * if ((mode & constants.S_IFMT) === constants.S_IFLNK) {
 *   console.log('This is a symbolic link')
 * }
 * ```
 */
export declare const S_IFLNK = 40960;
/**
 * Block special (block device) type.
 * Value: 0o060000 (24576 decimal, 0x6000)
 *
 * Typically used for disk devices and similar hardware.
 */
export declare const S_IFBLK = 24576;
/**
 * Character special (character device) type.
 * Value: 0o020000 (8192 decimal, 0x2000)
 *
 * Typically used for terminals, serial ports, and similar hardware.
 */
export declare const S_IFCHR = 8192;
/**
 * FIFO (named pipe) type.
 * Value: 0o010000 (4096 decimal, 0x1000)
 *
 * Used for inter-process communication.
 */
export declare const S_IFIFO = 4096;
/**
 * Socket type.
 * Value: 0o140000 (49152 decimal, 0xC000)
 *
 * Unix domain socket for local IPC.
 */
export declare const S_IFSOCK = 49152;
/**
 * Read, write, execute for owner (user).
 * Value: 0o700 (448 decimal)
 *
 * Combination of S_IRUSR | S_IWUSR | S_IXUSR.
 * Symbolic: rwx------
 */
export declare const S_IRWXU = 448;
/**
 * Read permission for owner.
 * Value: 0o400 (256 decimal)
 *
 * Symbolic: r--------
 */
export declare const S_IRUSR = 256;
/**
 * Write permission for owner.
 * Value: 0o200 (128 decimal)
 *
 * Symbolic: -w-------
 */
export declare const S_IWUSR = 128;
/**
 * Execute permission for owner.
 * Value: 0o100 (64 decimal)
 *
 * Symbolic: --x------
 * For directories, this is the search (traverse) permission.
 */
export declare const S_IXUSR = 64;
/**
 * Read, write, execute for group.
 * Value: 0o070 (56 decimal)
 *
 * Combination of S_IRGRP | S_IWGRP | S_IXGRP.
 * Symbolic: ---rwx---
 */
export declare const S_IRWXG = 56;
/**
 * Read permission for group.
 * Value: 0o040 (32 decimal)
 *
 * Symbolic: ---r-----
 */
export declare const S_IRGRP = 32;
/**
 * Write permission for group.
 * Value: 0o020 (16 decimal)
 *
 * Symbolic: ----w----
 */
export declare const S_IWGRP = 16;
/**
 * Execute permission for group.
 * Value: 0o010 (8 decimal)
 *
 * Symbolic: -----x---
 * For directories, this is the search (traverse) permission.
 */
export declare const S_IXGRP = 8;
/**
 * Read, write, execute for others.
 * Value: 0o007 (7 decimal)
 *
 * Combination of S_IROTH | S_IWOTH | S_IXOTH.
 * Symbolic: ------rwx
 */
export declare const S_IRWXO = 7;
/**
 * Read permission for others.
 * Value: 0o004 (4 decimal)
 *
 * Symbolic: ------r--
 */
export declare const S_IROTH = 4;
/**
 * Write permission for others.
 * Value: 0o002 (2 decimal)
 *
 * Symbolic: -------w-
 */
export declare const S_IWOTH = 2;
/**
 * Execute permission for others.
 * Value: 0o001 (1 decimal)
 *
 * Symbolic: --------x
 * For directories, this is the search (traverse) permission.
 */
export declare const S_IXOTH = 1;
/**
 * Set user ID on execution (setuid).
 * Value: 0o4000 (2048 decimal)
 *
 * When this bit is set on an executable file, the process runs with
 * the effective user ID of the file owner rather than the user who runs it.
 * Symbolic: s (in place of user execute bit)
 *
 * @example
 * ```typescript
 * const setuidExecutable = constants.S_IFREG | constants.S_ISUID | 0o755
 * ```
 */
export declare const S_ISUID = 2048;
/**
 * Set group ID on execution (setgid).
 * Value: 0o2000 (1024 decimal)
 *
 * When set on executable: process runs with effective group ID of file.
 * When set on directory: new files inherit the directory's group.
 * Symbolic: s (in place of group execute bit)
 */
export declare const S_ISGID = 1024;
/**
 * Sticky bit (restricted deletion flag).
 * Value: 0o1000 (512 decimal)
 *
 * On directories: only the file owner, directory owner, or root
 * can delete or rename files within the directory.
 * Classic example: /tmp directory.
 * Symbolic: t (in place of other execute bit)
 */
export declare const S_ISVTX = 512;
/**
 * Fail if destination exists.
 * Value: 1
 *
 * @example
 * ```typescript
 * await fs.copyFile('/src.txt', '/dest.txt', constants.COPYFILE_EXCL)
 * ```
 */
export declare const COPYFILE_EXCL = 1;
/**
 * Use copy-on-write if supported by the filesystem.
 * Value: 2
 *
 * Attempts to create a reflink (copy-on-write clone) for efficiency.
 * Falls back to regular copy if not supported.
 */
export declare const COPYFILE_FICLONE = 2;
/**
 * Require copy-on-write. Fail if not supported.
 * Value: 4
 *
 * Unlike COPYFILE_FICLONE, this will not fall back to regular copy.
 */
export declare const COPYFILE_FICLONE_FORCE = 4;
/**
 * Seek from beginning of file.
 * Value: 0
 *
 * The file offset is set to offset bytes from the beginning.
 */
export declare const SEEK_SET = 0;
/**
 * Seek from current position.
 * Value: 1
 *
 * The file offset is set to its current location plus offset.
 */
export declare const SEEK_CUR = 1;
/**
 * Seek from end of file.
 * Value: 2
 *
 * The file offset is set to the size of the file plus offset.
 */
export declare const SEEK_END = 2;
/**
 * All filesystem constants in a single object.
 *
 * This export provides Node.js fs.constants compatibility.
 * Individual constants are also exported for tree-shaking.
 *
 * @example
 * ```typescript
 * import { constants } from 'fsx.do'
 *
 * // Use like Node.js fs.constants
 * await fs.access('/file', constants.R_OK | constants.W_OK)
 *
 * // Check file type
 * const isFile = (stats.mode & constants.S_IFMT) === constants.S_IFREG
 * ```
 */
export declare const constants: {
    readonly F_OK: 0;
    readonly R_OK: 4;
    readonly W_OK: 2;
    readonly X_OK: 1;
    readonly O_RDONLY: 0;
    readonly O_WRONLY: 1;
    readonly O_RDWR: 2;
    readonly O_CREAT: 64;
    readonly O_EXCL: 128;
    readonly O_TRUNC: 512;
    readonly O_APPEND: 1024;
    readonly O_SYNC: 4096;
    readonly O_DIRECTORY: 65536;
    readonly O_NOFOLLOW: 131072;
    readonly S_IFMT: 61440;
    readonly S_IFREG: 32768;
    readonly S_IFDIR: 16384;
    readonly S_IFLNK: 40960;
    readonly S_IFBLK: 24576;
    readonly S_IFCHR: 8192;
    readonly S_IFIFO: 4096;
    readonly S_IFSOCK: 49152;
    readonly S_IRWXU: 448;
    readonly S_IRUSR: 256;
    readonly S_IWUSR: 128;
    readonly S_IXUSR: 64;
    readonly S_IRWXG: 56;
    readonly S_IRGRP: 32;
    readonly S_IWGRP: 16;
    readonly S_IXGRP: 8;
    readonly S_IRWXO: 7;
    readonly S_IROTH: 4;
    readonly S_IWOTH: 2;
    readonly S_IXOTH: 1;
    readonly S_ISUID: 2048;
    readonly S_ISGID: 1024;
    readonly S_ISVTX: 512;
    readonly COPYFILE_EXCL: 1;
    readonly COPYFILE_FICLONE: 2;
    readonly COPYFILE_FICLONE_FORCE: 4;
    readonly SEEK_SET: 0;
    readonly SEEK_CUR: 1;
    readonly SEEK_END: 2;
};
/**
 * Type representing all filesystem constants.
 */
export type Constants = typeof constants;
/**
 * File access mode constants for use with access().
 */
export declare const AccessModes: {
    readonly F_OK: 0;
    readonly R_OK: 4;
    readonly W_OK: 2;
    readonly X_OK: 1;
};
export type AccessModes = typeof AccessModes;
/**
 * File open flag constants for use with open().
 */
export declare const OpenFlags: {
    readonly O_RDONLY: 0;
    readonly O_WRONLY: 1;
    readonly O_RDWR: 2;
    readonly O_CREAT: 64;
    readonly O_EXCL: 128;
    readonly O_TRUNC: 512;
    readonly O_APPEND: 1024;
    readonly O_SYNC: 4096;
    readonly O_DIRECTORY: 65536;
    readonly O_NOFOLLOW: 131072;
};
export type OpenFlags = typeof OpenFlags;
/**
 * File type constants for mode bit detection.
 */
export declare const FileTypes: {
    readonly S_IFMT: 61440;
    readonly S_IFREG: 32768;
    readonly S_IFDIR: 16384;
    readonly S_IFLNK: 40960;
    readonly S_IFBLK: 24576;
    readonly S_IFCHR: 8192;
    readonly S_IFIFO: 4096;
    readonly S_IFSOCK: 49152;
};
export type FileTypes = typeof FileTypes;
/**
 * Permission bit constants for file mode.
 */
export declare const Permissions: {
    readonly S_IRWXU: 448;
    readonly S_IRUSR: 256;
    readonly S_IWUSR: 128;
    readonly S_IXUSR: 64;
    readonly S_IRWXG: 56;
    readonly S_IRGRP: 32;
    readonly S_IWGRP: 16;
    readonly S_IXGRP: 8;
    readonly S_IRWXO: 7;
    readonly S_IROTH: 4;
    readonly S_IWOTH: 2;
    readonly S_IXOTH: 1;
    readonly S_ISUID: 2048;
    readonly S_ISGID: 1024;
    readonly S_ISVTX: 512;
};
export type Permissions = typeof Permissions;
/**
 * Copy operation flag constants.
 */
export declare const CopyFlags: {
    readonly COPYFILE_EXCL: 1;
    readonly COPYFILE_FICLONE: 2;
    readonly COPYFILE_FICLONE_FORCE: 4;
};
export type CopyFlags = typeof CopyFlags;
/**
 * Seek whence constants for lseek().
 */
export declare const SeekWhence: {
    readonly SEEK_SET: 0;
    readonly SEEK_CUR: 1;
    readonly SEEK_END: 2;
};
export type SeekWhence = typeof SeekWhence;
/**
 * Common file mode presets for convenience.
 *
 * These combine file type with typical permission patterns.
 *
 * @example
 * ```typescript
 * import { CommonModes } from 'fsx.do'
 *
 * // Create a file with standard permissions
 * await fs.chmod('/script.sh', CommonModes.EXECUTABLE_755)
 * ```
 */
export declare const CommonModes: {
    /** Standard file permissions: rw-r--r-- (0644) */
    readonly FILE_644: 420;
    /** Private file: rw------- (0600) */
    readonly FILE_600: 384;
    /** Group-writable file: rw-rw-r-- (0664) */
    readonly FILE_664: 436;
    /** Standard directory: rwxr-xr-x (0755) */
    readonly DIR_755: 493;
    /** Private directory: rwx------ (0700) */
    readonly DIR_700: 448;
    /** Group-writable directory: rwxrwxr-x (0775) */
    readonly DIR_775: 509;
    /** Executable file: rwxr-xr-x (0755) */
    readonly EXECUTABLE_755: 493;
    /** User-only executable: rwx------ (0700) */
    readonly EXECUTABLE_700: 448;
    /** Symbolic link (no real permissions, shown as 0777) */
    readonly SYMLINK: 511;
};
export type CommonModes = typeof CommonModes;
/**
 * Entity type for permission checking.
 */
export type Who = 'user' | 'group' | 'other';
/**
 * Check if mode represents a regular file.
 *
 * @param mode - The file mode (e.g., from stats.mode)
 * @returns true if the mode indicates a regular file
 *
 * @example
 * ```typescript
 * import { isFile } from 'fsx.do'
 *
 * const stats = await fs.stat('/path/to/file')
 * if (isFile(stats.mode)) {
 *   console.log('This is a regular file')
 * }
 * ```
 */
export declare function isFile(mode: number): boolean;
/**
 * Check if mode represents a directory.
 *
 * @param mode - The file mode (e.g., from stats.mode)
 * @returns true if the mode indicates a directory
 *
 * @example
 * ```typescript
 * import { isDirectory } from 'fsx.do'
 *
 * const stats = await fs.stat('/path/to/dir')
 * if (isDirectory(stats.mode)) {
 *   console.log('This is a directory')
 * }
 * ```
 */
export declare function isDirectory(mode: number): boolean;
/**
 * Check if mode represents a symbolic link.
 *
 * @param mode - The file mode (e.g., from lstat().mode)
 * @returns true if the mode indicates a symbolic link
 *
 * @example
 * ```typescript
 * import { isSymlink } from 'fsx.do'
 *
 * // Use lstat to not follow symlinks
 * const stats = await fs.lstat('/path/to/link')
 * if (isSymlink(stats.mode)) {
 *   console.log('This is a symbolic link')
 * }
 * ```
 */
export declare function isSymlink(mode: number): boolean;
/**
 * Check if mode represents a block device.
 *
 * @param mode - The file mode
 * @returns true if the mode indicates a block device
 *
 * @example
 * ```typescript
 * import { isBlockDevice } from 'fsx.do'
 *
 * const stats = await fs.stat('/dev/sda')
 * if (isBlockDevice(stats.mode)) {
 *   console.log('This is a block device')
 * }
 * ```
 */
export declare function isBlockDevice(mode: number): boolean;
/**
 * Check if mode represents a character device.
 *
 * @param mode - The file mode
 * @returns true if the mode indicates a character device
 *
 * @example
 * ```typescript
 * import { isCharacterDevice } from 'fsx.do'
 *
 * const stats = await fs.stat('/dev/tty')
 * if (isCharacterDevice(stats.mode)) {
 *   console.log('This is a character device')
 * }
 * ```
 */
export declare function isCharacterDevice(mode: number): boolean;
/**
 * Check if mode represents a FIFO (named pipe).
 *
 * @param mode - The file mode
 * @returns true if the mode indicates a FIFO
 *
 * @example
 * ```typescript
 * import { isFIFO } from 'fsx.do'
 *
 * const stats = await fs.stat('/tmp/mypipe')
 * if (isFIFO(stats.mode)) {
 *   console.log('This is a named pipe')
 * }
 * ```
 */
export declare function isFIFO(mode: number): boolean;
/**
 * Check if mode represents a socket.
 *
 * @param mode - The file mode
 * @returns true if the mode indicates a socket
 *
 * @example
 * ```typescript
 * import { isSocket } from 'fsx.do'
 *
 * const stats = await fs.stat('/var/run/docker.sock')
 * if (isSocket(stats.mode)) {
 *   console.log('This is a Unix socket')
 * }
 * ```
 */
export declare function isSocket(mode: number): boolean;
/**
 * Check if mode has read permission for the specified entity.
 *
 * @param mode - The file mode
 * @param who - The entity to check: 'user', 'group', or 'other'
 * @returns true if read permission is set
 *
 * @example
 * ```typescript
 * import { hasReadPermission } from 'fsx.do'
 *
 * const stats = await fs.stat('/path/to/file')
 * if (hasReadPermission(stats.mode, 'group')) {
 *   console.log('Group can read this file')
 * }
 * ```
 */
export declare function hasReadPermission(mode: number, who: Who): boolean;
/**
 * Check if mode has write permission for the specified entity.
 *
 * @param mode - The file mode
 * @param who - The entity to check: 'user', 'group', or 'other'
 * @returns true if write permission is set
 *
 * @example
 * ```typescript
 * import { hasWritePermission } from 'fsx.do'
 *
 * const stats = await fs.stat('/path/to/file')
 * if (hasWritePermission(stats.mode, 'other')) {
 *   console.log('Warning: world-writable file!')
 * }
 * ```
 */
export declare function hasWritePermission(mode: number, who: Who): boolean;
/**
 * Check if mode has execute permission for the specified entity.
 *
 * @param mode - The file mode
 * @param who - The entity to check: 'user', 'group', or 'other'
 * @returns true if execute permission is set
 *
 * @example
 * ```typescript
 * import { hasExecutePermission } from 'fsx.do'
 *
 * const stats = await fs.stat('/usr/bin/node')
 * if (hasExecutePermission(stats.mode, 'user')) {
 *   console.log('User can execute this file')
 * }
 * ```
 */
export declare function hasExecutePermission(mode: number, who: Who): boolean;
/**
 * Convert a mode number to a symbolic permission string (e.g., "rwxr-xr-x").
 *
 * @param mode - The file mode (permission bits only, file type ignored)
 * @returns A 9-character permission string
 *
 * @example
 * ```typescript
 * import { modeToString } from 'fsx.do'
 *
 * console.log(modeToString(0o755)) // "rwxr-xr-x"
 * console.log(modeToString(0o644)) // "rw-r--r--"
 * console.log(modeToString(0o700)) // "rwx------"
 * ```
 */
export declare function modeToString(mode: number): string;
/**
 * Get the file type character for ls-style output.
 *
 * @param mode - The file mode
 * @returns A single character representing the file type
 *
 * @example
 * ```typescript
 * import { getFileTypeChar } from 'fsx.do'
 *
 * console.log(getFileTypeChar(0o100644)) // "-" (regular file)
 * console.log(getFileTypeChar(0o040755)) // "d" (directory)
 * console.log(getFileTypeChar(0o120777)) // "l" (symlink)
 * ```
 */
export declare function getFileTypeChar(mode: number): string;
/**
 * Get full ls-style mode string including file type.
 *
 * @param mode - The complete file mode (type + permissions)
 * @returns A 10-character mode string (e.g., "-rwxr-xr-x")
 *
 * @example
 * ```typescript
 * import { getFullModeString, S_IFREG, S_IFDIR } from 'fsx.do'
 *
 * console.log(getFullModeString(S_IFREG | 0o755)) // "-rwxr-xr-x"
 * console.log(getFullModeString(S_IFDIR | 0o755)) // "drwxr-xr-x"
 * ```
 */
export declare function getFullModeString(mode: number): string;
//# sourceMappingURL=constants.d.ts.map