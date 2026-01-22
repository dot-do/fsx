/**
 * @fileoverview POSIX-compatible filesystem error classes for fsx.do
 *
 * Provides Node.js-compatible error classes for filesystem operations.
 * Each error class mirrors the POSIX errno codes and follows the Node.js
 * error message formatting convention.
 *
 * @example
 * ```typescript
 * import { ENOENT, isEnoent } from 'fsx/errors'
 *
 * // Create an error
 * throw new ENOENT('open', '/path/to/file.txt')
 * // Error: ENOENT: no such file or directory, open '/path/to/file.txt'
 *
 * // Type guard usage
 * try {
 *   await fs.readFile('/missing.txt')
 * } catch (err) {
 *   if (isEnoent(err)) {
 *     console.log('File not found:', err.path)
 *   }
 * }
 * ```
 *
 * @module fsx/errors
 */
/**
 * Error code configuration for filesystem errors.
 * Maps POSIX error codes to their numeric errno values and human-readable messages.
 */
declare const ERROR_CODES: {
    readonly ENOENT: {
        readonly errno: -2;
        readonly message: "no such file or directory";
    };
    readonly EEXIST: {
        readonly errno: -17;
        readonly message: "file already exists";
    };
    readonly EISDIR: {
        readonly errno: -21;
        readonly message: "illegal operation on a directory";
    };
    readonly ENOTDIR: {
        readonly errno: -20;
        readonly message: "not a directory";
    };
    readonly EACCES: {
        readonly errno: -13;
        readonly message: "permission denied";
    };
    readonly EPERM: {
        readonly errno: -1;
        readonly message: "operation not permitted";
    };
    readonly ENOTEMPTY: {
        readonly errno: -39;
        readonly message: "directory not empty";
    };
    readonly EBADF: {
        readonly errno: -9;
        readonly message: "bad file descriptor";
    };
    readonly EINVAL: {
        readonly errno: -22;
        readonly message: "invalid argument";
    };
    readonly ELOOP: {
        readonly errno: -40;
        readonly message: "too many levels of symbolic links";
    };
    readonly ENAMETOOLONG: {
        readonly errno: -36;
        readonly message: "file name too long";
    };
    readonly ENOSPC: {
        readonly errno: -28;
        readonly message: "no space left on device";
    };
    readonly EROFS: {
        readonly errno: -30;
        readonly message: "read-only file system";
    };
    readonly EBUSY: {
        readonly errno: -16;
        readonly message: "resource busy or locked";
    };
    readonly EMFILE: {
        readonly errno: -24;
        readonly message: "too many open files";
    };
    readonly ENFILE: {
        readonly errno: -23;
        readonly message: "file table overflow";
    };
    readonly EXDEV: {
        readonly errno: -18;
        readonly message: "cross-device link not permitted";
    };
};
/**
 * Union type of all supported POSIX error codes.
 * Useful for type-safe error handling and switch statements.
 *
 * @example
 * ```typescript
 * function handleError(code: ErrorCode) {
 *   switch (code) {
 *     case 'ENOENT': return 'File not found'
 *     case 'EACCES': return 'Permission denied'
 *     // ...
 *   }
 * }
 * ```
 */
export type ErrorCode = keyof typeof ERROR_CODES;
/**
 * Numeric errno values corresponding to POSIX error codes.
 */
export type Errno = (typeof ERROR_CODES)[ErrorCode]['errno'];
/**
 * Base class for all filesystem errors.
 *
 * Extends the native Error class with POSIX-compatible properties.
 * Error messages follow the Node.js fs module formatting convention:
 * `CODE: message, syscall 'path' -> 'dest'`
 *
 * @example
 * ```typescript
 * const error = new FSError('ENOENT', -2, 'no such file or directory', 'open', '/file.txt')
 * console.log(error.message)  // "ENOENT: no such file or directory, open '/file.txt'"
 * console.log(error.code)     // "ENOENT"
 * console.log(error.errno)    // -2
 * console.log(error.syscall)  // "open"
 * console.log(error.path)     // "/file.txt"
 * ```
 */
export declare class FSError extends Error {
    /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
    code: string;
    /** Numeric errno value (negative, following Node.js convention) */
    errno: number;
    /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
    syscall?: string;
    /** Source path involved in the operation */
    path?: string;
    /** Destination path for operations like rename or copy */
    dest?: string;
    /**
     * Creates a new filesystem error.
     *
     * @param code - POSIX error code string (e.g., 'ENOENT')
     * @param errno - Numeric errno value (negative)
     * @param message - Human-readable error description
     * @param syscall - Optional system call name
     * @param path - Optional source path
     * @param dest - Optional destination path (for rename/copy operations)
     */
    constructor(code: string, errno: number, message: string, syscall?: string, path?: string, dest?: string);
}
declare const ENOENT_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * ENOENT - No such file or directory.
 *
 * Thrown when a file or directory is expected to exist but does not.
 * Common scenarios:
 * - `readFile()` on a non-existent file
 * - `stat()` on a missing path
 * - `readdir()` on a non-existent directory
 *
 * @example
 * ```typescript
 * throw new ENOENT('open', '/missing/file.txt')
 * // ENOENT: no such file or directory, open '/missing/file.txt'
 * ```
 */
export declare class ENOENT extends ENOENT_base {
}
declare const EEXIST_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * EEXIST - File exists.
 *
 * Thrown when creating a file/directory that already exists
 * and exclusive creation was requested.
 * Common scenarios:
 * - `mkdir()` on an existing directory (without recursive option)
 * - `writeFile()` with exclusive flag on existing file
 * - `symlink()` where target already exists
 *
 * @example
 * ```typescript
 * throw new EEXIST('mkdir', '/existing/directory')
 * // EEXIST: file already exists, mkdir '/existing/directory'
 * ```
 */
export declare class EEXIST extends EEXIST_base {
}
declare const EISDIR_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * EISDIR - Is a directory.
 *
 * Thrown when an operation expected a file but encountered a directory.
 * Common scenarios:
 * - `readFile()` on a directory
 * - `unlink()` on a directory (use rmdir instead)
 * - `open()` for writing on a directory
 *
 * @example
 * ```typescript
 * throw new EISDIR('read', '/some/directory')
 * // EISDIR: illegal operation on a directory, read '/some/directory'
 * ```
 */
export declare class EISDIR extends EISDIR_base {
}
declare const ENOTDIR_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * ENOTDIR - Not a directory.
 *
 * Thrown when an operation expected a directory but encountered a file.
 * Common scenarios:
 * - `readdir()` on a file
 * - Path contains a file component used as directory (e.g., `/file.txt/subdir`)
 * - `rmdir()` on a file
 *
 * @example
 * ```typescript
 * throw new ENOTDIR('scandir', '/path/to/file.txt')
 * // ENOTDIR: not a directory, scandir '/path/to/file.txt'
 * ```
 */
export declare class ENOTDIR extends ENOTDIR_base {
}
declare const EACCES_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * EACCES - Permission denied.
 *
 * Thrown when the operation lacks necessary permissions.
 * Common scenarios:
 * - Reading a file without read permission
 * - Writing to a file without write permission
 * - Accessing a file in a directory without execute permission
 *
 * @example
 * ```typescript
 * throw new EACCES('open', '/protected/file.txt')
 * // EACCES: permission denied, open '/protected/file.txt'
 * ```
 */
export declare class EACCES extends EACCES_base {
}
declare const EPERM_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * EPERM - Operation not permitted.
 *
 * Thrown when an operation is not allowed regardless of permissions.
 * Common scenarios:
 * - Changing ownership without appropriate privileges
 * - Modifying immutable files
 * - Operations requiring elevated privileges
 *
 * @example
 * ```typescript
 * throw new EPERM('chmod', '/system/file')
 * // EPERM: operation not permitted, chmod '/system/file'
 * ```
 */
export declare class EPERM extends EPERM_base {
}
declare const ENOTEMPTY_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * ENOTEMPTY - Directory not empty.
 *
 * Thrown when trying to remove a non-empty directory without recursive option.
 * Common scenarios:
 * - `rmdir()` on a directory containing files
 * - `rename()` over an existing non-empty directory
 *
 * @example
 * ```typescript
 * throw new ENOTEMPTY('rmdir', '/non/empty/dir')
 * // ENOTEMPTY: directory not empty, rmdir '/non/empty/dir'
 * ```
 */
export declare class ENOTEMPTY extends ENOTEMPTY_base {
}
declare const EBADF_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * EBADF - Bad file descriptor.
 *
 * Thrown when operating on an invalid or closed file descriptor.
 * Common scenarios:
 * - Reading from a closed file handle
 * - Writing to an invalid descriptor
 * - Operations on file descriptors that were never opened
 *
 * @example
 * ```typescript
 * throw new EBADF('read')
 * // EBADF: bad file descriptor, read
 * ```
 */
export declare class EBADF extends EBADF_base {
}
declare const EINVAL_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * EINVAL - Invalid argument.
 *
 * Thrown when an argument value is outside the acceptable range or format.
 * Common scenarios:
 * - Invalid flags passed to open()
 * - Invalid mode values
 * - Negative offset/length values where not allowed
 *
 * @example
 * ```typescript
 * throw new EINVAL('read', '/file.txt')
 * // EINVAL: invalid argument, read '/file.txt'
 * ```
 */
export declare class EINVAL extends EINVAL_base {
}
declare const ELOOP_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * ELOOP - Too many symbolic links.
 *
 * Thrown when symlink resolution exceeds the maximum depth (usually 40 levels).
 * Common scenarios:
 * - Circular symlink references
 * - Deeply nested symlink chains
 *
 * @example
 * ```typescript
 * throw new ELOOP('readlink', '/circular/link')
 * // ELOOP: too many levels of symbolic links, readlink '/circular/link'
 * ```
 */
export declare class ELOOP extends ELOOP_base {
}
declare const ENAMETOOLONG_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * ENAMETOOLONG - File name too long.
 *
 * Thrown when a path component or total path length exceeds system limits.
 * Common scenarios:
 * - Path component exceeds 255 bytes (typical limit)
 * - Total path exceeds PATH_MAX (typically 4096 bytes)
 *
 * @example
 * ```typescript
 * throw new ENAMETOOLONG('open', '/path/' + 'x'.repeat(300))
 * // ENAMETOOLONG: file name too long, open '/path/xxx...'
 * ```
 */
export declare class ENAMETOOLONG extends ENAMETOOLONG_base {
}
declare const ENOSPC_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * ENOSPC - No space left on device.
 *
 * Thrown when the filesystem is full and cannot allocate more space.
 * Common scenarios:
 * - Writing to a full disk
 * - Creating files when no inodes remain
 * - Extending a file beyond available space
 *
 * @example
 * ```typescript
 * throw new ENOSPC('write', '/large/file.bin')
 * // ENOSPC: no space left on device, write '/large/file.bin'
 * ```
 */
export declare class ENOSPC extends ENOSPC_base {
}
declare const EROFS_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * EROFS - Read-only file system.
 *
 * Thrown when attempting to modify a read-only filesystem.
 * Common scenarios:
 * - Writing to a mounted read-only volume
 * - Modifying files on read-only media
 *
 * @example
 * ```typescript
 * throw new EROFS('write', '/readonly/file.txt')
 * // EROFS: read-only file system, write '/readonly/file.txt'
 * ```
 */
export declare class EROFS extends EROFS_base {
}
declare const EBUSY_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * EBUSY - Resource busy.
 *
 * Thrown when a resource is in use and cannot be accessed exclusively.
 * Common scenarios:
 * - Deleting a file that is currently open
 * - Unmounting a filesystem with open files
 * - Locking a file that is already locked
 *
 * @example
 * ```typescript
 * throw new EBUSY('unlink', '/locked/file.txt')
 * // EBUSY: resource busy or locked, unlink '/locked/file.txt'
 * ```
 */
export declare class EBUSY extends EBUSY_base {
}
declare const EMFILE_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * EMFILE - Too many open files (process limit).
 *
 * Thrown when the process has exhausted its file descriptor limit.
 * Common scenarios:
 * - Opening many files without closing them
 * - Leaking file descriptors
 *
 * @example
 * ```typescript
 * throw new EMFILE('open')
 * // EMFILE: too many open files, open
 * ```
 */
export declare class EMFILE extends EMFILE_base {
}
declare const ENFILE_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * ENFILE - File table overflow (system limit).
 *
 * Thrown when the system-wide file descriptor limit is reached.
 * Less common than EMFILE; indicates system-wide exhaustion.
 *
 * @example
 * ```typescript
 * throw new ENFILE('open')
 * // ENFILE: file table overflow, open
 * ```
 */
export declare class ENFILE extends ENFILE_base {
}
declare const EXDEV_base: {
    new (syscall?: string, path?: string, dest?: string): {
        /** POSIX error code string (e.g., 'ENOENT', 'EACCES') */
        code: string;
        /** Numeric errno value (negative, following Node.js convention) */
        errno: number;
        /** System call that triggered the error (e.g., 'open', 'read', 'mkdir') */
        syscall?: string;
        /** Source path involved in the operation */
        path?: string;
        /** Destination path for operations like rename or copy */
        dest?: string;
        name: string;
        message: string;
        stack?: string;
        cause?: unknown;
    };
    isError(error: unknown): error is Error;
    captureStackTrace(targetObject: object, constructorOpt?: Function): void;
    prepareStackTrace(err: Error, stackTraces: NodeJS.CallSite[]): any;
    stackTraceLimit: number;
};
/**
 * EXDEV - Cross-device link.
 *
 * Thrown when attempting hard links or certain renames across filesystems.
 * Common scenarios:
 * - Hard linking across mount points
 * - Atomic rename across different volumes
 *
 * @example
 * ```typescript
 * throw new EXDEV('rename', '/vol1/file.txt', '/vol2/file.txt')
 * // EXDEV: cross-device link not permitted, rename '/vol1/file.txt' -> '/vol2/file.txt'
 * ```
 */
export declare class EXDEV extends EXDEV_base {
}
/**
 * Type guard to check if an error is any FSError instance.
 *
 * @param error - The error to check
 * @returns True if the error is an FSError instance
 *
 * @example
 * ```typescript
 * try {
 *   await fs.readFile('/missing.txt')
 * } catch (err) {
 *   if (isFSError(err)) {
 *     console.log(`FS Error: ${err.code} (errno: ${err.errno})`)
 *   }
 * }
 * ```
 */
export declare function isFSError(error: unknown): error is FSError;
/**
 * Type guard to check if an error is ENOENT (file not found).
 *
 * @param error - The error to check
 * @returns True if the error is an ENOENT instance
 *
 * @example
 * ```typescript
 * if (isEnoent(err)) {
 *   console.log('File not found:', err.path)
 * }
 * ```
 */
export declare function isEnoent(error: unknown): error is ENOENT;
/**
 * Type guard to check if an error is EEXIST (file exists).
 *
 * @param error - The error to check
 * @returns True if the error is an EEXIST instance
 */
export declare function isEexist(error: unknown): error is EEXIST;
/**
 * Type guard to check if an error is EISDIR (is a directory).
 *
 * @param error - The error to check
 * @returns True if the error is an EISDIR instance
 */
export declare function isEisdir(error: unknown): error is EISDIR;
/**
 * Type guard to check if an error is ENOTDIR (not a directory).
 *
 * @param error - The error to check
 * @returns True if the error is an ENOTDIR instance
 */
export declare function isEnotdir(error: unknown): error is ENOTDIR;
/**
 * Type guard to check if an error is EACCES (permission denied).
 *
 * @param error - The error to check
 * @returns True if the error is an EACCES instance
 */
export declare function isEacces(error: unknown): error is EACCES;
/**
 * Type guard to check if an error is EPERM (operation not permitted).
 *
 * @param error - The error to check
 * @returns True if the error is an EPERM instance
 */
export declare function isEperm(error: unknown): error is EPERM;
/**
 * Type guard to check if an error is ENOTEMPTY (directory not empty).
 *
 * @param error - The error to check
 * @returns True if the error is an ENOTEMPTY instance
 */
export declare function isEnotempty(error: unknown): error is ENOTEMPTY;
/**
 * Type guard to check if an error is EBADF (bad file descriptor).
 *
 * @param error - The error to check
 * @returns True if the error is an EBADF instance
 */
export declare function isEbadf(error: unknown): error is EBADF;
/**
 * Type guard to check if an error is EINVAL (invalid argument).
 *
 * @param error - The error to check
 * @returns True if the error is an EINVAL instance
 */
export declare function isEinval(error: unknown): error is EINVAL;
/**
 * Type guard to check if an error is ELOOP (too many symlinks).
 *
 * @param error - The error to check
 * @returns True if the error is an ELOOP instance
 */
export declare function isEloop(error: unknown): error is ELOOP;
/**
 * Type guard to check if an error is ENAMETOOLONG (name too long).
 *
 * @param error - The error to check
 * @returns True if the error is an ENAMETOOLONG instance
 */
export declare function isEnametoolong(error: unknown): error is ENAMETOOLONG;
/**
 * Type guard to check if an error is ENOSPC (no space left).
 *
 * @param error - The error to check
 * @returns True if the error is an ENOSPC instance
 */
export declare function isEnospc(error: unknown): error is ENOSPC;
/**
 * Type guard to check if an error is EROFS (read-only filesystem).
 *
 * @param error - The error to check
 * @returns True if the error is an EROFS instance
 */
export declare function isErofs(error: unknown): error is EROFS;
/**
 * Type guard to check if an error is EBUSY (resource busy).
 *
 * @param error - The error to check
 * @returns True if the error is an EBUSY instance
 */
export declare function isEbusy(error: unknown): error is EBUSY;
/**
 * Type guard to check if an error is EMFILE (too many open files).
 *
 * @param error - The error to check
 * @returns True if the error is an EMFILE instance
 */
export declare function isEmfile(error: unknown): error is EMFILE;
/**
 * Type guard to check if an error is ENFILE (file table overflow).
 *
 * @param error - The error to check
 * @returns True if the error is an ENFILE instance
 */
export declare function isEnfile(error: unknown): error is ENFILE;
/**
 * Type guard to check if an error is EXDEV (cross-device link).
 *
 * @param error - The error to check
 * @returns True if the error is an EXDEV instance
 */
export declare function isExdev(error: unknown): error is EXDEV;
/**
 * Checks if an error has a specific error code.
 * Works with any error object that has a `code` property.
 *
 * @param error - The error to check
 * @param code - The error code to match
 * @returns True if the error has the specified code
 *
 * @example
 * ```typescript
 * try {
 *   await fs.readFile('/missing.txt')
 * } catch (err) {
 *   if (hasErrorCode(err, 'ENOENT')) {
 *     // Handle file not found
 *   }
 * }
 * ```
 */
export declare function hasErrorCode(error: unknown, code: ErrorCode): boolean;
/**
 * Gets the error code from an error if it's an FSError.
 *
 * @param error - The error to extract the code from
 * @returns The error code or undefined if not an FSError
 *
 * @example
 * ```typescript
 * const code = getErrorCode(err)
 * if (code === 'ENOENT') {
 *   // Handle missing file
 * }
 * ```
 */
export declare function getErrorCode(error: unknown): ErrorCode | undefined;
/**
 * Creates a new error from just a code, syscall, and path.
 * Useful for programmatic error creation.
 *
 * @param code - The error code
 * @param syscall - Optional system call name
 * @param path - Optional path
 * @param dest - Optional destination path
 * @returns A new FSError instance of the appropriate type
 *
 * @example
 * ```typescript
 * throw createError('ENOENT', 'open', '/missing.txt')
 * ```
 */
export declare function createError(code: ErrorCode, syscall?: string, path?: string, dest?: string): FSError;
/**
 * All supported error codes as a constant array.
 * Useful for iteration or validation.
 */
export declare const ALL_ERROR_CODES: readonly ErrorCode[];
export default FSError;
//# sourceMappingURL=errors.d.ts.map