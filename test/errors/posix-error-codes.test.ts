/**
 * @fileoverview Comprehensive POSIX error code verification tests
 *
 * This test file validates that all filesystem operations return the correct
 * POSIX error codes consistently. It serves as the authoritative source for
 * error code behavior across the fsx.do filesystem.
 *
 * POSIX Error Codes Tested:
 * - ENOENT (-2): No such file or directory
 * - EEXIST (-17): File already exists
 * - ENOTDIR (-20): Not a directory
 * - EISDIR (-21): Illegal operation on a directory
 * - EACCES (-13): Permission denied
 *
 * Each error class is tested for:
 * 1. Correct error code string (e.g., 'ENOENT')
 * 2. Correct errno value (negative integer)
 * 3. Correct error message format
 * 4. Correct syscall attribution
 * 5. Correct path/dest properties
 * 6. instanceof chain (Error -> FSError -> specific class)
 * 7. Type guard functionality
 */

import { describe, it, expect } from 'vitest'
import {
  FSError,
  ENOENT,
  EEXIST,
  ENOTDIR,
  EISDIR,
  EACCES,
  EPERM,
  ENOTEMPTY,
  EBADF,
  EINVAL,
  ELOOP,
  ENAMETOOLONG,
  ENOSPC,
  EROFS,
  EBUSY,
  EMFILE,
  ENFILE,
  EXDEV,
  // Type guards
  isFSError,
  isEnoent,
  isEexist,
  isEnotdir,
  isEisdir,
  isEacces,
  isEperm,
  isEnotempty,
  isEbadf,
  isEinval,
  isEloop,
  isEnametoolong,
  isEnospc,
  isErofs,
  isEbusy,
  isEmfile,
  isEnfile,
  isExdev,
  // Helpers
  hasErrorCode,
  getErrorCode,
  createError,
  ALL_ERROR_CODES,
  type ErrorCode,
} from '../../core/errors'

// ============================================================================
// POSIX Error Code Constants
// ============================================================================

/**
 * Expected errno values for each POSIX error code.
 * These values are based on Linux/POSIX standards and Node.js conventions.
 */
const EXPECTED_ERRNO = {
  ENOENT: -2,
  EEXIST: -17,
  EISDIR: -21,
  ENOTDIR: -20,
  EACCES: -13,
  EPERM: -1,
  ENOTEMPTY: -39,
  EBADF: -9,
  EINVAL: -22,
  ELOOP: -40,
  ENAMETOOLONG: -36,
  ENOSPC: -28,
  EROFS: -30,
  EBUSY: -16,
  EMFILE: -24,
  ENFILE: -23,
  EXDEV: -18,
} as const

/**
 * Expected human-readable messages for each error code.
 */
const EXPECTED_MESSAGES = {
  ENOENT: 'no such file or directory',
  EEXIST: 'file already exists',
  EISDIR: 'illegal operation on a directory',
  ENOTDIR: 'not a directory',
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  ENOTEMPTY: 'directory not empty',
  EBADF: 'bad file descriptor',
  EINVAL: 'invalid argument',
  ELOOP: 'too many levels of symbolic links',
  ENAMETOOLONG: 'file name too long',
  ENOSPC: 'no space left on device',
  EROFS: 'read-only file system',
  EBUSY: 'resource busy or locked',
  EMFILE: 'too many open files',
  ENFILE: 'file table overflow',
  EXDEV: 'cross-device link not permitted',
} as const

// ============================================================================
// ENOENT - No such file or directory
// ============================================================================

describe('ENOENT - No such file or directory', () => {
  describe('error code and errno verification', () => {
    it('should have code "ENOENT"', () => {
      const error = new ENOENT()
      expect(error.code).toBe('ENOENT')
    })

    it('should have errno -2', () => {
      const error = new ENOENT()
      expect(error.errno).toBe(EXPECTED_ERRNO.ENOENT)
      expect(error.errno).toBe(-2)
    })

    it('should have correct name property', () => {
      const error = new ENOENT()
      expect(error.name).toBe('ENOENT')
    })
  })

  describe('error message format', () => {
    it('should format message without syscall or path', () => {
      const error = new ENOENT()
      expect(error.message).toBe('ENOENT: no such file or directory')
    })

    it('should format message with syscall only', () => {
      const error = new ENOENT('open')
      expect(error.message).toBe('ENOENT: no such file or directory, open')
    })

    it('should format message with syscall and path', () => {
      const error = new ENOENT('open', '/path/to/file.txt')
      expect(error.message).toBe("ENOENT: no such file or directory, open '/path/to/file.txt'")
    })

    it('should include path in quotes', () => {
      const error = new ENOENT('stat', '/some/path')
      expect(error.message).toContain("'/some/path'")
    })
  })

  describe('syscall scenarios', () => {
    const syscalls = ['open', 'stat', 'lstat', 'readdir', 'rmdir', 'unlink', 'rename', 'access']

    syscalls.forEach((syscall) => {
      it(`should work with syscall: ${syscall}`, () => {
        const error = new ENOENT(syscall, '/test/path')
        expect(error.syscall).toBe(syscall)
        expect(error.message).toContain(syscall)
      })
    })
  })

  describe('inheritance chain', () => {
    it('should be instanceof Error', () => {
      const error = new ENOENT()
      expect(error).toBeInstanceOf(Error)
    })

    it('should be instanceof FSError', () => {
      const error = new ENOENT()
      expect(error).toBeInstanceOf(FSError)
    })

    it('should be instanceof ENOENT', () => {
      const error = new ENOENT()
      expect(error).toBeInstanceOf(ENOENT)
    })
  })

  describe('type guard: isEnoent', () => {
    it('should return true for ENOENT instances', () => {
      expect(isEnoent(new ENOENT())).toBe(true)
      expect(isEnoent(new ENOENT('open', '/file'))).toBe(true)
    })

    it('should return false for other error types', () => {
      expect(isEnoent(new EEXIST())).toBe(false)
      expect(isEnoent(new EISDIR())).toBe(false)
      expect(isEnoent(new Error('ENOENT'))).toBe(false)
    })

    it('should return false for non-error values', () => {
      expect(isEnoent(null)).toBe(false)
      expect(isEnoent(undefined)).toBe(false)
      expect(isEnoent('ENOENT')).toBe(false)
      expect(isEnoent({ code: 'ENOENT' })).toBe(false)
    })
  })
})

// ============================================================================
// EEXIST - File already exists
// ============================================================================

describe('EEXIST - File already exists', () => {
  describe('error code and errno verification', () => {
    it('should have code "EEXIST"', () => {
      const error = new EEXIST()
      expect(error.code).toBe('EEXIST')
    })

    it('should have errno -17', () => {
      const error = new EEXIST()
      expect(error.errno).toBe(EXPECTED_ERRNO.EEXIST)
      expect(error.errno).toBe(-17)
    })

    it('should have correct name property', () => {
      const error = new EEXIST()
      expect(error.name).toBe('EEXIST')
    })
  })

  describe('error message format', () => {
    it('should format message without syscall or path', () => {
      const error = new EEXIST()
      expect(error.message).toBe('EEXIST: file already exists')
    })

    it('should format message with syscall and path', () => {
      const error = new EEXIST('mkdir', '/existing/dir')
      expect(error.message).toBe("EEXIST: file already exists, mkdir '/existing/dir'")
    })

    it('should work with symlink syscall', () => {
      const error = new EEXIST('symlink', '/link/path')
      expect(error.message).toBe("EEXIST: file already exists, symlink '/link/path'")
    })
  })

  describe('syscall scenarios', () => {
    const syscalls = ['mkdir', 'symlink', 'link', 'open', 'rename']

    syscalls.forEach((syscall) => {
      it(`should work with syscall: ${syscall}`, () => {
        const error = new EEXIST(syscall, '/test/path')
        expect(error.syscall).toBe(syscall)
        expect(error.message).toContain(syscall)
      })
    })
  })

  describe('inheritance chain', () => {
    it('should be instanceof Error', () => {
      expect(new EEXIST()).toBeInstanceOf(Error)
    })

    it('should be instanceof FSError', () => {
      expect(new EEXIST()).toBeInstanceOf(FSError)
    })

    it('should be instanceof EEXIST', () => {
      expect(new EEXIST()).toBeInstanceOf(EEXIST)
    })
  })

  describe('type guard: isEexist', () => {
    it('should return true for EEXIST instances', () => {
      expect(isEexist(new EEXIST())).toBe(true)
    })

    it('should return false for other error types', () => {
      expect(isEexist(new ENOENT())).toBe(false)
      expect(isEexist(new EISDIR())).toBe(false)
    })
  })
})

// ============================================================================
// ENOTDIR - Not a directory
// ============================================================================

describe('ENOTDIR - Not a directory', () => {
  describe('error code and errno verification', () => {
    it('should have code "ENOTDIR"', () => {
      const error = new ENOTDIR()
      expect(error.code).toBe('ENOTDIR')
    })

    it('should have errno -20', () => {
      const error = new ENOTDIR()
      expect(error.errno).toBe(EXPECTED_ERRNO.ENOTDIR)
      expect(error.errno).toBe(-20)
    })

    it('should have correct name property', () => {
      const error = new ENOTDIR()
      expect(error.name).toBe('ENOTDIR')
    })
  })

  describe('error message format', () => {
    it('should format message without syscall or path', () => {
      const error = new ENOTDIR()
      expect(error.message).toBe('ENOTDIR: not a directory')
    })

    it('should format message with syscall and path', () => {
      const error = new ENOTDIR('scandir', '/path/to/file.txt')
      expect(error.message).toBe("ENOTDIR: not a directory, scandir '/path/to/file.txt'")
    })

    it('should work with readdir syscall', () => {
      const error = new ENOTDIR('readdir', '/file.txt')
      expect(error.message).toBe("ENOTDIR: not a directory, readdir '/file.txt'")
    })
  })

  describe('syscall scenarios', () => {
    const syscalls = ['scandir', 'readdir', 'rmdir', 'mkdir', 'opendir']

    syscalls.forEach((syscall) => {
      it(`should work with syscall: ${syscall}`, () => {
        const error = new ENOTDIR(syscall, '/test/path')
        expect(error.syscall).toBe(syscall)
        expect(error.message).toContain(syscall)
      })
    })
  })

  describe('inheritance chain', () => {
    it('should be instanceof Error', () => {
      expect(new ENOTDIR()).toBeInstanceOf(Error)
    })

    it('should be instanceof FSError', () => {
      expect(new ENOTDIR()).toBeInstanceOf(FSError)
    })

    it('should be instanceof ENOTDIR', () => {
      expect(new ENOTDIR()).toBeInstanceOf(ENOTDIR)
    })
  })

  describe('type guard: isEnotdir', () => {
    it('should return true for ENOTDIR instances', () => {
      expect(isEnotdir(new ENOTDIR())).toBe(true)
    })

    it('should return false for other error types', () => {
      expect(isEnotdir(new ENOENT())).toBe(false)
      expect(isEnotdir(new EISDIR())).toBe(false)
    })
  })
})

// ============================================================================
// EISDIR - Is a directory
// ============================================================================

describe('EISDIR - Is a directory', () => {
  describe('error code and errno verification', () => {
    it('should have code "EISDIR"', () => {
      const error = new EISDIR()
      expect(error.code).toBe('EISDIR')
    })

    it('should have errno -21', () => {
      const error = new EISDIR()
      expect(error.errno).toBe(EXPECTED_ERRNO.EISDIR)
      expect(error.errno).toBe(-21)
    })

    it('should have correct name property', () => {
      const error = new EISDIR()
      expect(error.name).toBe('EISDIR')
    })
  })

  describe('error message format', () => {
    it('should format message without syscall or path', () => {
      const error = new EISDIR()
      expect(error.message).toBe('EISDIR: illegal operation on a directory')
    })

    it('should format message with syscall and path', () => {
      const error = new EISDIR('read', '/some/directory')
      expect(error.message).toBe("EISDIR: illegal operation on a directory, read '/some/directory'")
    })

    it('should work with unlink syscall', () => {
      const error = new EISDIR('unlink', '/dir')
      expect(error.message).toBe("EISDIR: illegal operation on a directory, unlink '/dir'")
    })
  })

  describe('syscall scenarios', () => {
    const syscalls = ['read', 'open', 'unlink', 'write', 'truncate']

    syscalls.forEach((syscall) => {
      it(`should work with syscall: ${syscall}`, () => {
        const error = new EISDIR(syscall, '/test/dir')
        expect(error.syscall).toBe(syscall)
        expect(error.message).toContain(syscall)
      })
    })
  })

  describe('inheritance chain', () => {
    it('should be instanceof Error', () => {
      expect(new EISDIR()).toBeInstanceOf(Error)
    })

    it('should be instanceof FSError', () => {
      expect(new EISDIR()).toBeInstanceOf(FSError)
    })

    it('should be instanceof EISDIR', () => {
      expect(new EISDIR()).toBeInstanceOf(EISDIR)
    })
  })

  describe('type guard: isEisdir', () => {
    it('should return true for EISDIR instances', () => {
      expect(isEisdir(new EISDIR())).toBe(true)
    })

    it('should return false for other error types', () => {
      expect(isEisdir(new ENOENT())).toBe(false)
      expect(isEisdir(new ENOTDIR())).toBe(false)
    })
  })
})

// ============================================================================
// EACCES - Permission denied
// ============================================================================

describe('EACCES - Permission denied', () => {
  describe('error code and errno verification', () => {
    it('should have code "EACCES"', () => {
      const error = new EACCES()
      expect(error.code).toBe('EACCES')
    })

    it('should have errno -13', () => {
      const error = new EACCES()
      expect(error.errno).toBe(EXPECTED_ERRNO.EACCES)
      expect(error.errno).toBe(-13)
    })

    it('should have correct name property', () => {
      const error = new EACCES()
      expect(error.name).toBe('EACCES')
    })
  })

  describe('error message format', () => {
    it('should format message without syscall or path', () => {
      const error = new EACCES()
      expect(error.message).toBe('EACCES: permission denied')
    })

    it('should format message with syscall and path', () => {
      const error = new EACCES('open', '/protected/file.txt')
      expect(error.message).toBe("EACCES: permission denied, open '/protected/file.txt'")
    })

    it('should work with access syscall', () => {
      const error = new EACCES('access', '/restricted')
      expect(error.message).toBe("EACCES: permission denied, access '/restricted'")
    })
  })

  describe('syscall scenarios', () => {
    const syscalls = ['open', 'read', 'write', 'access', 'unlink', 'mkdir', 'rmdir', 'chmod']

    syscalls.forEach((syscall) => {
      it(`should work with syscall: ${syscall}`, () => {
        const error = new EACCES(syscall, '/test/path')
        expect(error.syscall).toBe(syscall)
        expect(error.message).toContain(syscall)
      })
    })
  })

  describe('inheritance chain', () => {
    it('should be instanceof Error', () => {
      expect(new EACCES()).toBeInstanceOf(Error)
    })

    it('should be instanceof FSError', () => {
      expect(new EACCES()).toBeInstanceOf(FSError)
    })

    it('should be instanceof EACCES', () => {
      expect(new EACCES()).toBeInstanceOf(EACCES)
    })
  })

  describe('type guard: isEacces', () => {
    it('should return true for EACCES instances', () => {
      expect(isEacces(new EACCES())).toBe(true)
    })

    it('should return false for other error types', () => {
      expect(isEacces(new ENOENT())).toBe(false)
      expect(isEacces(new EPERM())).toBe(false)
    })
  })

  describe('EACCES vs EPERM distinction', () => {
    it('should use EACCES for permission-based denial', () => {
      // EACCES is for when permission bits don't allow the operation
      const error = new EACCES('open', '/no-read-permission.txt')
      expect(error.code).toBe('EACCES')
      expect(error.errno).toBe(-13)
    })

    it('should use EPERM for capability-based denial', () => {
      // EPERM is for when operation is not permitted regardless of permissions
      const error = new EPERM('chown', '/system-file')
      expect(error.code).toBe('EPERM')
      expect(error.errno).toBe(-1)
    })
  })
})

// ============================================================================
// Additional Error Codes for Completeness
// ============================================================================

describe('ENOTEMPTY - Directory not empty', () => {
  it('should have correct code and errno', () => {
    const error = new ENOTEMPTY()
    expect(error.code).toBe('ENOTEMPTY')
    expect(error.errno).toBe(-39)
  })

  it('should format message correctly', () => {
    const error = new ENOTEMPTY('rmdir', '/non/empty/dir')
    expect(error.message).toBe("ENOTEMPTY: directory not empty, rmdir '/non/empty/dir'")
  })

  it('should pass type guard', () => {
    expect(isEnotempty(new ENOTEMPTY())).toBe(true)
    expect(isEnotempty(new ENOENT())).toBe(false)
  })
})

describe('EBADF - Bad file descriptor', () => {
  it('should have correct code and errno', () => {
    const error = new EBADF()
    expect(error.code).toBe('EBADF')
    expect(error.errno).toBe(-9)
  })

  it('should format message correctly', () => {
    const error = new EBADF('read')
    expect(error.message).toBe('EBADF: bad file descriptor, read')
  })

  it('should pass type guard', () => {
    expect(isEbadf(new EBADF())).toBe(true)
    expect(isEbadf(new EINVAL())).toBe(false)
  })
})

describe('EINVAL - Invalid argument', () => {
  it('should have correct code and errno', () => {
    const error = new EINVAL()
    expect(error.code).toBe('EINVAL')
    expect(error.errno).toBe(-22)
  })

  it('should format message correctly', () => {
    const error = new EINVAL('open', '/file')
    expect(error.message).toBe("EINVAL: invalid argument, open '/file'")
  })

  it('should pass type guard', () => {
    expect(isEinval(new EINVAL())).toBe(true)
    expect(isEinval(new EBADF())).toBe(false)
  })
})

describe('EXDEV - Cross-device link', () => {
  it('should have correct code and errno', () => {
    const error = new EXDEV()
    expect(error.code).toBe('EXDEV')
    expect(error.errno).toBe(-18)
  })

  it('should format message with source and destination', () => {
    const error = new EXDEV('rename', '/vol1/file.txt', '/vol2/file.txt')
    expect(error.message).toBe("EXDEV: cross-device link not permitted, rename '/vol1/file.txt' -> '/vol2/file.txt'")
    expect(error.path).toBe('/vol1/file.txt')
    expect(error.dest).toBe('/vol2/file.txt')
  })

  it('should pass type guard', () => {
    expect(isExdev(new EXDEV())).toBe(true)
    expect(isExdev(new ENOENT())).toBe(false)
  })
})

// ============================================================================
// Comprehensive Error Code Table Verification
// ============================================================================

describe('Error Code Table Verification', () => {
  const errorTable: Array<{
    ErrorClass: new (syscall?: string, path?: string, dest?: string) => FSError
    code: ErrorCode
    errno: number
    message: string
    typeGuard: (error: unknown) => boolean
  }> = [
    { ErrorClass: ENOENT, code: 'ENOENT', errno: -2, message: 'no such file or directory', typeGuard: isEnoent },
    { ErrorClass: EEXIST, code: 'EEXIST', errno: -17, message: 'file already exists', typeGuard: isEexist },
    { ErrorClass: EISDIR, code: 'EISDIR', errno: -21, message: 'illegal operation on a directory', typeGuard: isEisdir },
    { ErrorClass: ENOTDIR, code: 'ENOTDIR', errno: -20, message: 'not a directory', typeGuard: isEnotdir },
    { ErrorClass: EACCES, code: 'EACCES', errno: -13, message: 'permission denied', typeGuard: isEacces },
    { ErrorClass: EPERM, code: 'EPERM', errno: -1, message: 'operation not permitted', typeGuard: isEperm },
    { ErrorClass: ENOTEMPTY, code: 'ENOTEMPTY', errno: -39, message: 'directory not empty', typeGuard: isEnotempty },
    { ErrorClass: EBADF, code: 'EBADF', errno: -9, message: 'bad file descriptor', typeGuard: isEbadf },
    { ErrorClass: EINVAL, code: 'EINVAL', errno: -22, message: 'invalid argument', typeGuard: isEinval },
    { ErrorClass: ELOOP, code: 'ELOOP', errno: -40, message: 'too many levels of symbolic links', typeGuard: isEloop },
    { ErrorClass: ENAMETOOLONG, code: 'ENAMETOOLONG', errno: -36, message: 'file name too long', typeGuard: isEnametoolong },
    { ErrorClass: ENOSPC, code: 'ENOSPC', errno: -28, message: 'no space left on device', typeGuard: isEnospc },
    { ErrorClass: EROFS, code: 'EROFS', errno: -30, message: 'read-only file system', typeGuard: isErofs },
    { ErrorClass: EBUSY, code: 'EBUSY', errno: -16, message: 'resource busy or locked', typeGuard: isEbusy },
    { ErrorClass: EMFILE, code: 'EMFILE', errno: -24, message: 'too many open files', typeGuard: isEmfile },
    { ErrorClass: ENFILE, code: 'ENFILE', errno: -23, message: 'file table overflow', typeGuard: isEnfile },
    { ErrorClass: EXDEV, code: 'EXDEV', errno: -18, message: 'cross-device link not permitted', typeGuard: isExdev },
  ]

  errorTable.forEach(({ ErrorClass, code, errno, message, typeGuard }) => {
    describe(`${code}`, () => {
      it(`should have code "${code}"`, () => {
        const error = new ErrorClass()
        expect(error.code).toBe(code)
      })

      it(`should have errno ${errno}`, () => {
        const error = new ErrorClass()
        expect(error.errno).toBe(errno)
      })

      it(`should have message containing "${message}"`, () => {
        const error = new ErrorClass()
        expect(error.message).toContain(message)
      })

      it('should have name matching code', () => {
        const error = new ErrorClass()
        expect(error.name).toBe(code)
      })

      it('should be instanceof FSError', () => {
        const error = new ErrorClass()
        expect(error).toBeInstanceOf(FSError)
      })

      it('should pass its own type guard', () => {
        const error = new ErrorClass()
        expect(typeGuard(error)).toBe(true)
      })

      it('should fail other type guards', () => {
        const error = new ErrorClass()
        errorTable.forEach((other) => {
          if (other.code !== code) {
            expect(other.typeGuard(error)).toBe(false)
          }
        })
      })
    })
  })
})

// ============================================================================
// Error Message Consistency Tests
// ============================================================================

describe('Error Message Consistency', () => {
  describe('message format pattern', () => {
    it('should follow pattern: CODE: message', () => {
      const error = new ENOENT()
      expect(error.message).toMatch(/^ENOENT: .+$/)
    })

    it('should follow pattern: CODE: message, syscall', () => {
      const error = new ENOENT('open')
      expect(error.message).toMatch(/^ENOENT: .+, open$/)
    })

    it("should follow pattern: CODE: message, syscall 'path'", () => {
      const error = new ENOENT('open', '/file.txt')
      expect(error.message).toMatch(/^ENOENT: .+, open '\/file\.txt'$/)
    })

    it("should follow pattern: CODE: message, syscall 'path' -> 'dest'", () => {
      const error = new EXDEV('rename', '/src', '/dest')
      expect(error.message).toMatch(/^EXDEV: .+, rename '\/src' -> '\/dest'$/)
    })
  })

  describe('path quoting consistency', () => {
    it('should quote paths with single quotes', () => {
      const paths = ['/simple.txt', '/path/with/slashes', '/path with spaces', "/path'with'quotes"]

      paths.forEach((path) => {
        const error = new ENOENT('open', path)
        expect(error.message).toContain(`'${path}'`)
      })
    })

    it('should handle special characters in paths', () => {
      const specialPaths = [
        '/file[1].txt',
        '/file(1).txt',
        '/file$var.txt',
        '/file@host.txt',
        '/file#hash.txt',
      ]

      specialPaths.forEach((path) => {
        const error = new ENOENT('stat', path)
        expect(error.path).toBe(path)
        expect(error.message).toContain(path)
      })
    })

    it('should handle unicode paths', () => {
      const unicodePaths = ['/fichier.txt', '/archivo.txt', '/file.txt']

      unicodePaths.forEach((path) => {
        const error = new ENOENT('open', path)
        expect(error.path).toBe(path)
      })
    })
  })

  describe('syscall naming consistency', () => {
    const standardSyscalls = [
      'open',
      'close',
      'read',
      'write',
      'stat',
      'lstat',
      'fstat',
      'mkdir',
      'rmdir',
      'readdir',
      'scandir',
      'unlink',
      'rename',
      'link',
      'symlink',
      'readlink',
      'realpath',
      'chmod',
      'chown',
      'utimes',
      'access',
      'truncate',
      'ftruncate',
      'copyfile',
    ]

    standardSyscalls.forEach((syscall) => {
      it(`should correctly include syscall: ${syscall}`, () => {
        const error = new ENOENT(syscall, '/test')
        expect(error.syscall).toBe(syscall)
        expect(error.message).toContain(`, ${syscall}`)
      })
    })
  })
})

// ============================================================================
// Helper Function Tests
// ============================================================================

describe('Helper Functions', () => {
  describe('createError', () => {
    it('should create correct error type from code string', () => {
      const codes: ErrorCode[] = ['ENOENT', 'EEXIST', 'EISDIR', 'ENOTDIR', 'EACCES']

      codes.forEach((code) => {
        const error = createError(code, 'test', '/path')
        expect(error.code).toBe(code)
        expect(error.syscall).toBe('test')
        expect(error.path).toBe('/path')
      })
    })

    it('should create error with dest for EXDEV', () => {
      const error = createError('EXDEV', 'rename', '/src', '/dest')
      expect(error.dest).toBe('/dest')
    })
  })

  describe('hasErrorCode', () => {
    it('should return true for matching code', () => {
      expect(hasErrorCode(new ENOENT(), 'ENOENT')).toBe(true)
      expect(hasErrorCode(new EEXIST(), 'EEXIST')).toBe(true)
    })

    it('should return false for non-matching code', () => {
      expect(hasErrorCode(new ENOENT(), 'EEXIST')).toBe(false)
    })

    it('should return false for non-FSError', () => {
      expect(hasErrorCode(new Error('test'), 'ENOENT')).toBe(false)
      expect(hasErrorCode({ code: 'ENOENT' }, 'ENOENT')).toBe(false)
    })
  })

  describe('getErrorCode', () => {
    it('should return code for FSError', () => {
      expect(getErrorCode(new ENOENT())).toBe('ENOENT')
      expect(getErrorCode(new EEXIST())).toBe('EEXIST')
    })

    it('should return undefined for non-FSError', () => {
      expect(getErrorCode(new Error('test'))).toBeUndefined()
      expect(getErrorCode(null)).toBeUndefined()
    })
  })

  describe('isFSError', () => {
    it('should return true for all FSError subclasses', () => {
      expect(isFSError(new ENOENT())).toBe(true)
      expect(isFSError(new EEXIST())).toBe(true)
      expect(isFSError(new EISDIR())).toBe(true)
      expect(isFSError(new ENOTDIR())).toBe(true)
      expect(isFSError(new EACCES())).toBe(true)
    })

    it('should return false for plain Error', () => {
      expect(isFSError(new Error('test'))).toBe(false)
    })

    it('should return false for error-like objects', () => {
      expect(isFSError({ code: 'ENOENT', errno: -2, message: 'test' })).toBe(false)
    })
  })

  describe('ALL_ERROR_CODES', () => {
    it('should contain all 17 error codes', () => {
      expect(ALL_ERROR_CODES.length).toBe(17)
    })

    it('should include all primary error codes', () => {
      expect(ALL_ERROR_CODES).toContain('ENOENT')
      expect(ALL_ERROR_CODES).toContain('EEXIST')
      expect(ALL_ERROR_CODES).toContain('ENOTDIR')
      expect(ALL_ERROR_CODES).toContain('EISDIR')
      expect(ALL_ERROR_CODES).toContain('EACCES')
    })
  })
})

// ============================================================================
// Node.js Compatibility Tests
// ============================================================================

describe('Node.js fs Error Compatibility', () => {
  describe('error object shape', () => {
    it('should have all Node.js error properties', () => {
      const error = new ENOENT('open', '/file.txt')

      // Required properties from Node.js fs errors
      expect(error).toHaveProperty('code')
      expect(error).toHaveProperty('errno')
      expect(error).toHaveProperty('syscall')
      expect(error).toHaveProperty('path')
      expect(error).toHaveProperty('message')
      expect(error).toHaveProperty('name')
    })

    it('should have stack trace', () => {
      const error = new ENOENT('open', '/file.txt')
      expect(error.stack).toBeDefined()
      expect(error.stack).toContain('ENOENT')
    })
  })

  describe('error code values match Node.js', () => {
    // These errno values match Node.js on Linux/macOS
    it('should match Node.js errno for ENOENT', () => {
      expect(new ENOENT().errno).toBe(-2)
    })

    it('should match Node.js errno for EEXIST', () => {
      expect(new EEXIST().errno).toBe(-17)
    })

    it('should match Node.js errno for EACCES', () => {
      expect(new EACCES().errno).toBe(-13)
    })

    it('should match Node.js errno for EISDIR', () => {
      expect(new EISDIR().errno).toBe(-21)
    })

    it('should match Node.js errno for ENOTDIR', () => {
      expect(new ENOTDIR().errno).toBe(-20)
    })
  })
})
