/**
 * @fileoverview Unit tests for PathValidator security module
 *
 * Tests comprehensive security validation including:
 * - Path traversal prevention (CWE-22)
 * - Null byte injection (CWE-626)
 * - Unicode attacks (bidirectional overrides, etc.)
 * - Control character filtering
 * - Path length limits (CWE-789)
 * - Windows ADS syntax handling
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { PathValidator, pathValidator, SecurityConstants } from './security'

describe('PathValidator', () => {
  let validator: PathValidator

  beforeEach(() => {
    validator = new PathValidator()
  })

  // ===========================================================================
  // PATH TRAVERSAL PREVENTION (CWE-22)
  // ===========================================================================

  describe('Path Traversal Prevention', () => {
    const root = '/app/data'

    describe('basic traversal attempts', () => {
      it('should block simple ../ traversal', () => {
        expect(() => validator.validatePath('../etc/passwd', root)).toThrow()
        expect(validator.isPathTraversal('../etc/passwd', root)).toBe(true)
      })

      it('should block multiple ../ sequences', () => {
        expect(() => validator.validatePath('../../etc/passwd', root)).toThrow()
        expect(() => validator.validatePath('../../../etc/passwd', root)).toThrow()
        expect(() => validator.validatePath('../../../../etc/passwd', root)).toThrow()
      })

      it('should block deep traversal to /etc/passwd', () => {
        const deepTraversal = '../'.repeat(20) + 'etc/passwd'
        expect(() => validator.validatePath(deepTraversal, root)).toThrow()
      })

      it('should block absolute paths outside root', () => {
        expect(() => validator.validatePath('/etc/passwd', root)).toThrow()
        expect(() => validator.validatePath('/etc/shadow', root)).toThrow()
        expect(() => validator.validatePath('/root/.ssh/id_rsa', root)).toThrow()
      })
    })

    describe('subtle traversal attempts', () => {
      it('should allow embedded ../ that stays within root', () => {
        // a/b/../../etc/passwd from /app/data resolves to /app/data/etc/passwd - within root
        const result = validator.validatePath('a/b/../../etc/passwd', root)
        expect(result).toBe('/app/data/etc/passwd')
      })

      it('should block embedded ../ that escapes root', () => {
        expect(() => validator.validatePath('subdir/../../../etc/passwd', root)).toThrow()
      })

      it('should block traversal with redundant slashes', () => {
        expect(() => validator.validatePath('..//etc/passwd', root)).toThrow()
        expect(() => validator.validatePath('.././../etc/passwd', root)).toThrow()
      })

      it('should block traversal at start and middle', () => {
        expect(() => validator.validatePath('../foo/../../../etc', root)).toThrow()
      })

      it('should block traversal that ends at root boundary', () => {
        // From /app/data, going up 2 levels would exit
        expect(() => validator.validatePath('../../other', root)).toThrow()
      })
    })

    describe('Windows-style path separators', () => {
      it('should block backslash traversal', () => {
        expect(() => validator.validatePath('..\\etc\\passwd', root)).toThrow()
        expect(() => validator.validatePath('..\\..\\etc\\passwd', root)).toThrow()
      })

      it('should block mixed separator traversal', () => {
        expect(() => validator.validatePath('../\\etc/passwd', root)).toThrow()
        expect(() => validator.validatePath('..\\/etc\\passwd', root)).toThrow()
      })
    })

    describe('valid paths within root', () => {
      it('should allow simple filenames', () => {
        const result = validator.validatePath('file.txt', root)
        expect(result).toBe('/app/data/file.txt')
      })

      it('should allow subdirectories', () => {
        const result = validator.validatePath('subdir/file.txt', root)
        expect(result).toBe('/app/data/subdir/file.txt')
      })

      it('should allow .. that stays within root', () => {
        const result = validator.validatePath('a/b/../c/file.txt', root)
        expect(result).toBe('/app/data/a/c/file.txt')
      })

      it('should allow absolute paths within root', () => {
        const result = validator.validatePath('/app/data/file.txt', root)
        expect(result).toBe('/app/data/file.txt')
      })

      it('should allow path equal to root', () => {
        const result = validator.validatePath('/app/data', root)
        expect(result).toBe('/app/data')
      })

      it('should handle deeply nested paths', () => {
        const result = validator.validatePath('a/b/c/d/e/file.txt', root)
        expect(result).toBe('/app/data/a/b/c/d/e/file.txt')
      })
    })

    describe('isPathTraversal helper', () => {
      it('should return true for traversal attempts', () => {
        expect(validator.isPathTraversal('../etc/passwd', root)).toBe(true)
        expect(validator.isPathTraversal('/etc/passwd', root)).toBe(true)
      })

      it('should return false for safe paths', () => {
        expect(validator.isPathTraversal('file.txt', root)).toBe(false)
        expect(validator.isPathTraversal('sub/file.txt', root)).toBe(false)
      })
    })
  })

  // ===========================================================================
  // NULL BYTE INJECTION (CWE-626)
  // ===========================================================================

  describe('Null Byte Injection', () => {
    it('should reject literal null bytes', () => {
      expect(() => validator.validateInput('file\x00.txt')).toThrow()
      expect(() => validator.validateInput('path/to\x00/file.txt')).toThrow()
    })

    it('should reject null byte at start', () => {
      expect(() => validator.validateInput('\x00file.txt')).toThrow()
    })

    it('should reject null byte at end', () => {
      expect(() => validator.validateInput('file.txt\x00')).toThrow()
    })

    it('should reject null bytes that could truncate path', () => {
      // Classic attack: "file.txt\x00.jpg" - .jpg is ignored in C, only .txt seen
      expect(() => validator.validateInput('image.txt\x00.jpg')).toThrow()
    })

    it('should reject URL-encoded null bytes (%00)', () => {
      expect(() => validator.validateInput('file%00.txt')).toThrow()
      expect(() => validator.validateInput('path%00/file.txt')).toThrow()
    })

    it('should reject Unicode null character (U+0000)', () => {
      expect(() => validator.validateInput('file\u0000.txt')).toThrow()
    })

    it('should reject multiple null bytes', () => {
      expect(() => validator.validateInput('a\x00b\x00c')).toThrow()
    })
  })

  // ===========================================================================
  // UNICODE ATTACKS
  // ===========================================================================

  describe('Unicode Attacks', () => {
    describe('bidirectional override attacks', () => {
      it('should reject RTL override character (U+202E)', () => {
        // This is used to disguise file extensions:
        // "file\u202Etxt.exe" displays as "fileexe.txt" but is actually file[RLO]txt.exe
        expect(() => validator.validateInput('file\u202Etxt.exe')).toThrow()
      })

      it('should reject RTL override anywhere in path', () => {
        expect(() => validator.validateInput('/path/\u202Efile.txt')).toThrow()
        expect(() => validator.validateInput('/path/file\u202E.txt')).toThrow()
      })
    })

    describe('line/paragraph separators', () => {
      it('should reject Unicode line separator (U+2028)', () => {
        expect(() => validator.validateInput('file\u2028name.txt')).toThrow()
      })

      it('should reject Unicode paragraph separator (U+2029)', () => {
        expect(() => validator.validateInput('file\u2029name.txt')).toThrow()
      })
    })

    describe('replacement character', () => {
      it('should reject Unicode replacement character (U+FFFD)', () => {
        // Indicates encoding errors - could be used to bypass validation
        expect(() => validator.validateInput('file\uFFFDname.txt')).toThrow()
      })
    })

    describe('valid Unicode paths', () => {
      it('should allow legitimate Unicode characters', () => {
        // Valid non-ASCII characters should be allowed
        validator.validateInput('/path/to/file.txt') // ASCII
      })

      it('should allow emoji in filenames', () => {
        // Emoji are valid Unicode and should be allowed
        validator.validateInput('/path/to/document.txt')
      })
    })
  })

  // ===========================================================================
  // CONTROL CHARACTER FILTERING
  // ===========================================================================

  describe('Control Character Filtering', () => {
    describe('ASCII control characters (0x01-0x1F)', () => {
      it('should reject bell character (0x07)', () => {
        expect(() => validator.validateInput('file\x07name.txt')).toThrow()
      })

      it('should reject backspace (0x08)', () => {
        expect(() => validator.validateInput('file\x08name.txt')).toThrow()
      })

      it('should reject tab (0x09)', () => {
        expect(() => validator.validateInput('file\tname.txt')).toThrow()
      })

      it('should reject newline (0x0A)', () => {
        expect(() => validator.validateInput('file\nname.txt')).toThrow()
      })

      it('should reject carriage return (0x0D)', () => {
        expect(() => validator.validateInput('file\rname.txt')).toThrow()
      })

      it('should reject escape character (0x1B)', () => {
        // Could enable terminal escape sequence injection
        expect(() => validator.validateInput('file\x1Bname.txt')).toThrow()
      })

      it('should reject all control characters 0x01-0x1F', () => {
        for (let i = 0x01; i <= 0x1F; i++) {
          const char = String.fromCharCode(i)
          expect(() => validator.validateInput(`file${char}name.txt`)).toThrow()
        }
      })
    })

    describe('DEL character (0x7F)', () => {
      it('should reject DEL character', () => {
        expect(() => validator.validateInput('file\x7Fname.txt')).toThrow()
      })
    })

    describe('escape sequence attacks', () => {
      it('should reject ANSI escape sequences', () => {
        // ANSI escape could enable log injection
        expect(() => validator.validateInput('file\x1B[31mred\x1B[0m.txt')).toThrow()
      })
    })
  })

  // ===========================================================================
  // PATH LENGTH LIMITS (CWE-789)
  // ===========================================================================

  describe('Path Length Limits', () => {
    describe('total path length (PATH_MAX)', () => {
      it('should accept paths within PATH_MAX (4096)', () => {
        const path = '/dir/' + 'a'.repeat(100)
        validator.validateInput(path)
      })

      it('should reject paths exceeding PATH_MAX (4096)', () => {
        const longPath = '/' + 'a'.repeat(4097)
        expect(() => validator.validateInput(longPath)).toThrow()
      })

      it('should reject paths at exactly PATH_MAX + 1', () => {
        const path = '/' + 'a'.repeat(SecurityConstants.MAX_PATH_LENGTH)
        expect(() => validator.validateInput(path)).toThrow()
      })

      it('should accept paths at exactly PATH_MAX', () => {
        const path = '/' + 'a'.repeat(SecurityConstants.MAX_PATH_LENGTH - 1)
        validator.validateInput(path)
      })
    })

    describe('component length (NAME_MAX)', () => {
      it('should accept components within NAME_MAX (255)', () => {
        const component = 'a'.repeat(255)
        const path = `/dir/${component}/file.txt`
        validator.validateInput(path)
      })

      it('should reject components exceeding NAME_MAX (255)', () => {
        const component = 'a'.repeat(256)
        const path = `/dir/${component}/file.txt`
        expect(() => validator.validateInput(path)).toThrow()
      })

      it('should check all path components', () => {
        const longComponent = 'a'.repeat(256)
        expect(() => validator.validateInput(`/short/${longComponent}/file.txt`)).toThrow()
        expect(() => validator.validateInput(`/first/${longComponent}/last`)).toThrow()
      })
    })
  })

  // ===========================================================================
  // WINDOWS ALTERNATE DATA STREAM (ADS) SYNTAX
  // ===========================================================================

  describe('Windows Alternate Data Stream Syntax', () => {
    it('should strip ADS syntax from path components', () => {
      const root = '/app/data'
      const result = validator.validatePath('file.txt:$DATA', root)
      expect(result).toBe('/app/data/file.txt')
    })

    it('should strip Zone.Identifier ADS', () => {
      const root = '/app/data'
      const result = validator.validatePath('file.txt:Zone.Identifier', root)
      expect(result).toBe('/app/data/file.txt')
    })

    it('should strip custom ADS names', () => {
      const root = '/app/data'
      const result = validator.validatePath('file.txt:hidden_stream', root)
      expect(result).toBe('/app/data/file.txt')
    })

    it('should handle ADS in subdirectories', () => {
      const root = '/app/data'
      const result = validator.validatePath('dir:stream/file.txt', root)
      expect(result).toBe('/app/data/dir/file.txt')
    })

    it('should strip content after colon for drive letter style paths', () => {
      // C:file.txt is treated as ADS syntax, stripping everything after colon
      // This leaves just "C" as the component
      const root = '/app'
      const result = validator.validatePath('C:file.txt', root)
      expect(result).toBe('/app/C')
    })
  })

  // ===========================================================================
  // INPUT VALIDATION EDGE CASES
  // ===========================================================================

  describe('Input Validation Edge Cases', () => {
    describe('empty and whitespace paths', () => {
      it('should reject empty string', () => {
        expect(() => validator.validateInput('')).toThrow()
      })

      it('should reject whitespace-only paths', () => {
        expect(() => validator.validateInput('   ')).toThrow()
        expect(() => validator.validateInput('\t\t')).toThrow()
      })

      it('should reject trailing whitespace', () => {
        expect(() => validator.validateInput('/path/to/file.txt ')).toThrow()
        expect(() => validator.validateInput('/path/to/file.txt  ')).toThrow()
      })

      it('should reject paths with leading whitespace after slash', () => {
        expect(() => validator.validateInput('/ leading.txt')).toThrow()
        expect(() => validator.validateInput('/path/ file.txt')).toThrow()
      })
    })

    describe('dot and double-dot paths', () => {
      it('should reject single dot path', () => {
        expect(() => validator.validateInput('.')).toThrow()
      })

      it('should reject double dot path', () => {
        expect(() => validator.validateInput('..')).toThrow()
      })
    })
  })

  // ===========================================================================
  // SYMLINK VALIDATION
  // ===========================================================================

  describe('Symlink Escape Detection', () => {
    const root = '/jail'

    it('should detect absolute target escaping jail', () => {
      expect(validator.isSymlinkEscape('/etc/passwd', '/jail/link', root)).toBe(true)
    })

    it('should detect relative target escaping jail', () => {
      expect(validator.isSymlinkEscape('../../etc/passwd', '/jail/user/link', root)).toBe(true)
    })

    it('should allow absolute target within jail', () => {
      expect(validator.isSymlinkEscape('/jail/other/file', '/jail/link', root)).toBe(false)
    })

    it('should allow relative target within jail', () => {
      expect(validator.isSymlinkEscape('../shared/file.txt', '/jail/user/link', root)).toBe(false)
    })

    it('should detect backslash traversal in symlink target', () => {
      expect(validator.isSymlinkEscape('..\\..\\etc\\passwd', '/jail/user/link', root)).toBe(true)
    })
  })

  // ===========================================================================
  // RESULT-BASED VALIDATION
  // ===========================================================================

  describe('Result-Based Validation', () => {
    it('should return success result for valid paths', () => {
      const result = validator.validatePathResult('file.txt', '/app')
      expect(result.valid).toBe(true)
      if (result.valid) {
        expect(result.normalizedPath).toBe('/app/file.txt')
      }
    })

    it('should return failure result for traversal', () => {
      const result = validator.validatePathResult('../etc/passwd', '/app')
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toBe('EACCES')
      }
    })

    it('should return failure result for invalid input', () => {
      const result = validator.validatePathResult('file\x00.txt', '/app')
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toBe('EINVAL')
      }
    })

    it('should return failure result for name too long', () => {
      const longPath = '/' + 'a'.repeat(5000)
      const result = validator.validatePathResult(longPath, '/app')
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(result.error).toBe('ENAMETOOLONG')
      }
    })
  })

  // ===========================================================================
  // SINGLETON INSTANCE
  // ===========================================================================

  describe('Singleton pathValidator', () => {
    it('should export a singleton instance', () => {
      expect(pathValidator).toBeInstanceOf(PathValidator)
    })

    it('should work the same as new instance', () => {
      const path = 'file.txt'
      const root = '/app'
      expect(pathValidator.validatePath(path, root)).toBe(validator.validatePath(path, root))
    })
  })

  // ===========================================================================
  // SECURITY CONSTANTS
  // ===========================================================================

  describe('SecurityConstants', () => {
    it('should have correct PATH_MAX value', () => {
      expect(SecurityConstants.MAX_PATH_LENGTH).toBe(4096)
    })

    it('should have correct NAME_MAX value', () => {
      expect(SecurityConstants.MAX_NAME_LENGTH).toBe(255)
    })

    it('should have correct null byte representations', () => {
      expect(SecurityConstants.NULL_BYTE).toBe('\x00')
      expect(SecurityConstants.URL_ENCODED_NULL).toBe('%00')
      expect(SecurityConstants.UNICODE_NULL).toBe('\u0000')
    })

    it('should have correct RTL override character', () => {
      expect(SecurityConstants.RTL_OVERRIDE).toBe('\u202E')
    })
  })
})
