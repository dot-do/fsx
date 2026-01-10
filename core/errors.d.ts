/**
 * Filesystem errors (POSIX-compatible)
 */
/**
 * Base filesystem error
 */
export declare class FSError extends Error {
    code: string;
    errno: number;
    syscall?: string;
    path?: string;
    dest?: string;
    constructor(code: string, errno: number, message: string, syscall?: string, path?: string, dest?: string);
}
/**
 * ENOENT - No such file or directory
 */
export declare class ENOENT extends FSError {
    constructor(syscall?: string, path?: string);
}
/**
 * EEXIST - File exists
 */
export declare class EEXIST extends FSError {
    constructor(syscall?: string, path?: string);
}
/**
 * EISDIR - Is a directory
 */
export declare class EISDIR extends FSError {
    constructor(syscall?: string, path?: string);
}
/**
 * ENOTDIR - Not a directory
 */
export declare class ENOTDIR extends FSError {
    constructor(syscall?: string, path?: string);
}
/**
 * EACCES - Permission denied
 */
export declare class EACCES extends FSError {
    constructor(syscall?: string, path?: string);
}
/**
 * EPERM - Operation not permitted
 */
export declare class EPERM extends FSError {
    constructor(syscall?: string, path?: string);
}
/**
 * ENOTEMPTY - Directory not empty
 */
export declare class ENOTEMPTY extends FSError {
    constructor(syscall?: string, path?: string);
}
/**
 * EBADF - Bad file descriptor
 */
export declare class EBADF extends FSError {
    constructor(syscall?: string, path?: string);
}
/**
 * EINVAL - Invalid argument
 */
export declare class EINVAL extends FSError {
    constructor(syscall?: string, path?: string);
}
/**
 * ELOOP - Too many symbolic links
 */
export declare class ELOOP extends FSError {
    constructor(syscall?: string, path?: string);
}
/**
 * ENAMETOOLONG - File name too long
 */
export declare class ENAMETOOLONG extends FSError {
    constructor(syscall?: string, path?: string);
}
/**
 * ENOSPC - No space left on device
 */
export declare class ENOSPC extends FSError {
    constructor(syscall?: string, path?: string);
}
/**
 * EROFS - Read-only file system
 */
export declare class EROFS extends FSError {
    constructor(syscall?: string, path?: string);
}
/**
 * EBUSY - Resource busy
 */
export declare class EBUSY extends FSError {
    constructor(syscall?: string, path?: string);
}
/**
 * EMFILE - Too many open files
 */
export declare class EMFILE extends FSError {
    constructor(syscall?: string, path?: string);
}
/**
 * ENFILE - File table overflow
 */
export declare class ENFILE extends FSError {
    constructor(syscall?: string, path?: string);
}
/**
 * EXDEV - Cross-device link
 */
export declare class EXDEV extends FSError {
    constructor(syscall?: string, path?: string, dest?: string);
}
//# sourceMappingURL=errors.d.ts.map