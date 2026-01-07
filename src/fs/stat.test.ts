/**
 * Tests for stat operation (RED phase - should fail)
 *
 * stat returns file/directory metadata, following symbolic links.
 * Unlike lstat, if the path is a symlink, stat returns info about the target.
 *
 * POSIX behavior:
 * - Returns Stats object with file metadata
 * - Follows symbolic links (use lstat for symlink itself)
 * - Returns ENOENT if path doesn't exist
 * - Returns ENOENT if symlink target doesn't exist (broken symlink)
 */

import { describe, it, expect } from 'vitest'
import { stat } from './stat'
import { Stats } from '../core/types'
import { ENOENT } from '../core/errors'
import { constants } from '../core/constants'

describe('stat', () => {
  describe('basic usage', () => {
    it('should return Stats object for a regular file', async () => {
      // Given: a file exists at /home/user/file.txt
      // When: calling stat on the file
      // Then: should return a Stats object

      const stats = await stat('/home/user/file.txt')

      expect(stats).toBeInstanceOf(Stats)
    })

    it('should return Stats object for a directory', async () => {
      // Given: a directory exists at /home/user/documents
      // When: calling stat on the directory
      // Then: should return a Stats object

      const stats = await stat('/home/user/documents')

      expect(stats).toBeInstanceOf(Stats)
    })

    it('should have all required properties on Stats object', async () => {
      // Given: a file exists at /home/user/file.txt
      // When: calling stat on the file
      // Then: Stats should have all required properties

      const stats = await stat('/home/user/file.txt')

      // Numeric properties
      expect(typeof stats.dev).toBe('number')
      expect(typeof stats.ino).toBe('number')
      expect(typeof stats.mode).toBe('number')
      expect(typeof stats.nlink).toBe('number')
      expect(typeof stats.uid).toBe('number')
      expect(typeof stats.gid).toBe('number')
      expect(typeof stats.rdev).toBe('number')
      expect(typeof stats.size).toBe('number')
      expect(typeof stats.blksize).toBe('number')
      expect(typeof stats.blocks).toBe('number')

      // Timestamp properties (in milliseconds)
      expect(typeof stats.atimeMs).toBe('number')
      expect(typeof stats.mtimeMs).toBe('number')
      expect(typeof stats.ctimeMs).toBe('number')
      expect(typeof stats.birthtimeMs).toBe('number')

      // Type checking methods
      expect(typeof stats.isFile).toBe('function')
      expect(typeof stats.isDirectory).toBe('function')
      expect(typeof stats.isSymbolicLink).toBe('function')
      expect(typeof stats.isBlockDevice).toBe('function')
      expect(typeof stats.isCharacterDevice).toBe('function')
      expect(typeof stats.isFIFO).toBe('function')
      expect(typeof stats.isSocket).toBe('function')
    })

    it('should have Date getters for timestamps', async () => {
      // Given: a file exists at /home/user/file.txt
      // When: calling stat on the file
      // Then: Stats should have Date getters

      const stats = await stat('/home/user/file.txt')

      // Date getters
      expect(stats.atime).toBeInstanceOf(Date)
      expect(stats.mtime).toBeInstanceOf(Date)
      expect(stats.ctime).toBeInstanceOf(Date)
      expect(stats.birthtime).toBeInstanceOf(Date)
    })
  })

  describe('type detection', () => {
    it('should return isFile() = true for regular files', async () => {
      // Given: a regular file exists at /data/file.txt
      // When: calling stat and checking isFile()
      // Then: should return true

      const stats = await stat('/data/file.txt')

      expect(stats.isFile()).toBe(true)
      expect(stats.isDirectory()).toBe(false)
    })

    it('should return isDirectory() = true for directories', async () => {
      // Given: a directory exists at /data/subdir
      // When: calling stat and checking isDirectory()
      // Then: should return true

      const stats = await stat('/data/subdir')

      expect(stats.isDirectory()).toBe(true)
      expect(stats.isFile()).toBe(false)
    })

    it('should return isSymbolicLink() = false for stat (stat follows links)', async () => {
      // Given: a symlink exists at /links/mylink pointing to a file
      // When: calling stat (not lstat) on the symlink
      // Then: isSymbolicLink() should return false because stat follows the link

      const stats = await stat('/links/mylink')

      // stat follows symlinks, so it should NOT report as symlink
      expect(stats.isSymbolicLink()).toBe(false)
    })

    it('should return isBlockDevice() = false for regular files', async () => {
      // Given: a regular file
      // When: checking isBlockDevice()
      // Then: should return false

      const stats = await stat('/data/file.txt')

      expect(stats.isBlockDevice()).toBe(false)
    })

    it('should return isCharacterDevice() = false for regular files', async () => {
      // Given: a regular file
      // When: checking isCharacterDevice()
      // Then: should return false

      const stats = await stat('/data/file.txt')

      expect(stats.isCharacterDevice()).toBe(false)
    })

    it('should return isFIFO() = false for regular files', async () => {
      // Given: a regular file
      // When: checking isFIFO()
      // Then: should return false

      const stats = await stat('/data/file.txt')

      expect(stats.isFIFO()).toBe(false)
    })

    it('should return isSocket() = false for regular files', async () => {
      // Given: a regular file
      // When: checking isSocket()
      // Then: should return false

      const stats = await stat('/data/file.txt')

      expect(stats.isSocket()).toBe(false)
    })
  })

  describe('file metadata', () => {
    it('should return size that matches file content length', async () => {
      // Given: a file with known content "Hello, World!" (13 bytes)
      // When: calling stat on the file
      // Then: size should be 13

      const stats = await stat('/data/hello.txt')

      expect(stats.size).toBe(13)
    })

    it('should return size = 0 for empty file', async () => {
      // Given: an empty file
      // When: calling stat on the file
      // Then: size should be 0

      const stats = await stat('/data/empty.txt')

      expect(stats.size).toBe(0)
    })

    it('should return mode with S_IFREG bit set for regular files', async () => {
      // Given: a regular file
      // When: calling stat
      // Then: mode should have S_IFREG bit set

      const stats = await stat('/data/file.txt')

      expect(stats.mode & constants.S_IFMT).toBe(constants.S_IFREG)
    })

    it('should return mode with S_IFDIR bit set for directories', async () => {
      // Given: a directory
      // When: calling stat
      // Then: mode should have S_IFDIR bit set

      const stats = await stat('/data/subdir')

      expect(stats.mode & constants.S_IFMT).toBe(constants.S_IFDIR)
    })

    it('should return mode with permission bits', async () => {
      // Given: a file with 0o644 permissions
      // When: calling stat
      // Then: mode should include permission bits

      const stats = await stat('/data/file.txt')

      // Extract permission bits (lower 12 bits)
      const permissions = stats.mode & 0o7777

      // Should have some permissions set
      expect(permissions).toBeGreaterThan(0)
    })

    it('should return nlink >= 1 for files', async () => {
      // Given: a file
      // When: calling stat
      // Then: nlink should be at least 1

      const stats = await stat('/data/file.txt')

      expect(stats.nlink).toBeGreaterThanOrEqual(1)
    })

    it('should return increased nlink for hard-linked files', async () => {
      // Given: a file with a hard link pointing to it
      // When: calling stat on the original file
      // Then: nlink should be >= 2

      const stats = await stat('/data/hardlinked-file.txt')

      expect(stats.nlink).toBeGreaterThanOrEqual(2)
    })

    it('should return nlink >= 2 for directories (. and parent)', async () => {
      // Given: a directory
      // When: calling stat
      // Then: nlink should be at least 2 (for . and parent's entry)

      const stats = await stat('/data/subdir')

      expect(stats.nlink).toBeGreaterThanOrEqual(2)
    })
  })

  describe('timestamps', () => {
    it('should return mtimeMs as a valid timestamp', async () => {
      // Given: a file
      // When: calling stat
      // Then: mtimeMs should be a reasonable timestamp

      const stats = await stat('/data/file.txt')

      // Should be a positive number
      expect(stats.mtimeMs).toBeGreaterThan(0)

      // Should be a reasonable timestamp (after 2020, before 2100)
      const year2020 = new Date('2020-01-01').getTime()
      const year2100 = new Date('2100-01-01').getTime()
      expect(stats.mtimeMs).toBeGreaterThan(year2020)
      expect(stats.mtimeMs).toBeLessThan(year2100)
    })

    it('should return birthtimeMs as a valid timestamp', async () => {
      // Given: a file
      // When: calling stat
      // Then: birthtimeMs should be a reasonable timestamp

      const stats = await stat('/data/file.txt')

      expect(stats.birthtimeMs).toBeGreaterThan(0)

      const year2020 = new Date('2020-01-01').getTime()
      const year2100 = new Date('2100-01-01').getTime()
      expect(stats.birthtimeMs).toBeGreaterThan(year2020)
      expect(stats.birthtimeMs).toBeLessThan(year2100)
    })

    it('should return atimeMs as a valid timestamp', async () => {
      // Given: a file
      // When: calling stat
      // Then: atimeMs should be a reasonable timestamp

      const stats = await stat('/data/file.txt')

      expect(stats.atimeMs).toBeGreaterThan(0)
    })

    it('should return ctimeMs as a valid timestamp', async () => {
      // Given: a file
      // When: calling stat
      // Then: ctimeMs should be a reasonable timestamp

      const stats = await stat('/data/file.txt')

      expect(stats.ctimeMs).toBeGreaterThan(0)
    })

    it('should have birthtimeMs <= mtimeMs (file created before modified)', async () => {
      // Given: a file
      // When: calling stat
      // Then: birthtime should be <= mtime

      const stats = await stat('/data/file.txt')

      expect(stats.birthtimeMs).toBeLessThanOrEqual(stats.mtimeMs)
    })

    it('should have birthtimeMs <= ctimeMs (file created before metadata changed)', async () => {
      // Given: a file
      // When: calling stat
      // Then: birthtime should be <= ctime

      const stats = await stat('/data/file.txt')

      expect(stats.birthtimeMs).toBeLessThanOrEqual(stats.ctimeMs)
    })

    it('should have Date getters that match Ms timestamps', async () => {
      // Given: a file
      // When: calling stat
      // Then: Date getters should match their Ms counterparts

      const stats = await stat('/data/file.txt')

      expect(stats.atime.getTime()).toBe(stats.atimeMs)
      expect(stats.mtime.getTime()).toBe(stats.mtimeMs)
      expect(stats.ctime.getTime()).toBe(stats.ctimeMs)
      expect(stats.birthtime.getTime()).toBe(stats.birthtimeMs)
    })
  })

  describe('symlink following', () => {
    it('should return target stats when stat is called on symlink', async () => {
      // Given: symlink at /links/file-link pointing to /data/file.txt
      // When: calling stat on the symlink
      // Then: should return stats of the target file, not the symlink

      const targetStats = await stat('/data/file.txt')
      const linkStats = await stat('/links/file-link')

      // The stats should match the target file
      expect(linkStats.size).toBe(targetStats.size)
      expect(linkStats.ino).toBe(targetStats.ino)
    })

    it('should return isFile() = true when symlink points to file', async () => {
      // Given: symlink pointing to a regular file
      // When: calling stat on the symlink
      // Then: isFile() should return true (following the link)

      const stats = await stat('/links/file-link')

      expect(stats.isFile()).toBe(true)
      expect(stats.isSymbolicLink()).toBe(false)
    })

    it('should return isDirectory() = true when symlink points to directory', async () => {
      // Given: symlink pointing to a directory
      // When: calling stat on the symlink
      // Then: isDirectory() should return true (following the link)

      const stats = await stat('/links/dir-link')

      expect(stats.isDirectory()).toBe(true)
      expect(stats.isSymbolicLink()).toBe(false)
    })

    it('should follow chain of symlinks', async () => {
      // Given: link1 -> link2 -> file.txt
      // When: calling stat on link1
      // Then: should return stats of file.txt

      const fileStats = await stat('/data/file.txt')
      const link1Stats = await stat('/links/link1')

      expect(link1Stats.ino).toBe(fileStats.ino)
      expect(link1Stats.isFile()).toBe(true)
    })

    it('should throw ENOENT for broken symlink', async () => {
      // Given: symlink pointing to non-existent target
      // When: calling stat on the broken symlink
      // Then: should throw ENOENT

      await expect(stat('/links/broken-link')).rejects.toThrow(ENOENT)
    })

    it('should include path in error for broken symlink', async () => {
      // Given: broken symlink
      // When: stat throws ENOENT
      // Then: error should include the original symlink path

      try {
        await stat('/links/broken-link')
        expect.fail('Should have thrown ENOENT')
      } catch (error) {
        expect(error).toBeInstanceOf(ENOENT)
        expect((error as ENOENT).path).toBe('/links/broken-link')
      }
    })
  })

  describe('error handling', () => {
    it('should throw ENOENT when path does not exist', async () => {
      // Given: path that does not exist
      // When: calling stat
      // Then: should throw ENOENT

      await expect(stat('/nonexistent/path')).rejects.toThrow(ENOENT)
    })

    it('should throw ENOENT when parent directory does not exist', async () => {
      // Given: path where parent directory doesn't exist
      // When: calling stat
      // Then: should throw ENOENT

      await expect(stat('/nonexistent/parent/file.txt')).rejects.toThrow(ENOENT)
    })

    it('should include syscall = "stat" in ENOENT error', async () => {
      // Given: non-existent path
      // When: stat throws ENOENT
      // Then: error.syscall should be 'stat'

      try {
        await stat('/nonexistent/file.txt')
        expect.fail('Should have thrown ENOENT')
      } catch (error) {
        expect(error).toBeInstanceOf(ENOENT)
        expect((error as ENOENT).syscall).toBe('stat')
      }
    })

    it('should include correct path in ENOENT error', async () => {
      // Given: non-existent path
      // When: stat throws ENOENT
      // Then: error.path should be the requested path

      try {
        await stat('/some/missing/file.txt')
        expect.fail('Should have thrown ENOENT')
      } catch (error) {
        expect(error).toBeInstanceOf(ENOENT)
        expect((error as ENOENT).path).toBe('/some/missing/file.txt')
      }
    })

    it('should include errno in ENOENT error', async () => {
      // Given: non-existent path
      // When: stat throws ENOENT
      // Then: error.errno should be -2 (ENOENT)

      try {
        await stat('/nonexistent')
        expect.fail('Should have thrown ENOENT')
      } catch (error) {
        expect(error).toBeInstanceOf(ENOENT)
        expect((error as ENOENT).errno).toBe(-2)
      }
    })
  })

  describe('path handling', () => {
    it('should handle absolute paths', async () => {
      // Given: an absolute path to an existing file
      // When: calling stat
      // Then: should return stats

      const stats = await stat('/data/file.txt')

      expect(stats).toBeInstanceOf(Stats)
    })

    it('should normalize paths with double slashes', async () => {
      // Given: path with double slashes /data//file.txt
      // When: calling stat
      // Then: should normalize and return stats

      const stats = await stat('/data//file.txt')

      expect(stats).toBeInstanceOf(Stats)
    })

    it('should normalize paths with dot segments', async () => {
      // Given: path with ./ like /data/./file.txt
      // When: calling stat
      // Then: should normalize and return stats

      const stats = await stat('/data/./file.txt')

      expect(stats).toBeInstanceOf(Stats)
    })

    it('should normalize paths with parent directory segments', async () => {
      // Given: path with ../ like /data/subdir/../file.txt
      // When: calling stat
      // Then: should normalize and return stats for /data/file.txt

      const stats = await stat('/data/subdir/../file.txt')

      expect(stats).toBeInstanceOf(Stats)
    })

    it('should handle trailing slashes for directories', async () => {
      // Given: directory path with trailing slash /data/subdir/
      // When: calling stat
      // Then: should return directory stats

      const stats = await stat('/data/subdir/')

      expect(stats.isDirectory()).toBe(true)
    })

    it('should handle trailing slashes for files', async () => {
      // Given: file path with trailing slash /data/file.txt/
      // When: calling stat
      // Then: behavior may vary, but should not crash
      // Note: POSIX typically allows trailing slash on directories only

      // This test documents expected behavior
      // Some systems throw ENOTDIR, others ignore trailing slash
      const result = stat('/data/file.txt/')

      // Should either succeed or throw an appropriate error
      await expect(result).rejects.toThrow()
    })

    it('should handle root path', async () => {
      // Given: root path /
      // When: calling stat
      // Then: should return directory stats

      const stats = await stat('/')

      expect(stats.isDirectory()).toBe(true)
    })

    it('should handle deeply nested paths', async () => {
      // Given: deeply nested path
      // When: calling stat
      // Then: should return stats

      const stats = await stat('/a/b/c/d/e/file.txt')

      expect(stats).toBeInstanceOf(Stats)
    })
  })

  describe('edge cases', () => {
    it('should return correct inode number (unique per file)', async () => {
      // Given: two different files
      // When: calling stat on each
      // Then: they should have different inode numbers

      const stats1 = await stat('/data/file1.txt')
      const stats2 = await stat('/data/file2.txt')

      expect(stats1.ino).not.toBe(stats2.ino)
    })

    it('should return same inode for same file via different paths', async () => {
      // Given: same file accessed via different paths (with ../)
      // When: calling stat
      // Then: should return same inode

      const stats1 = await stat('/data/file.txt')
      const stats2 = await stat('/data/subdir/../file.txt')

      expect(stats1.ino).toBe(stats2.ino)
    })

    it('should return consistent dev for files on same filesystem', async () => {
      // Given: two files on the same filesystem
      // When: calling stat
      // Then: they should have the same dev value

      const stats1 = await stat('/data/file1.txt')
      const stats2 = await stat('/data/file2.txt')

      expect(stats1.dev).toBe(stats2.dev)
    })

    it('should handle files with spaces in name', async () => {
      // Given: file with spaces in name
      // When: calling stat
      // Then: should return stats

      const stats = await stat('/data/file with spaces.txt')

      expect(stats).toBeInstanceOf(Stats)
    })

    it('should handle files with unicode characters', async () => {
      // Given: file with unicode name
      // When: calling stat
      // Then: should return stats

      const stats = await stat('/data/unicode-file.txt')

      expect(stats).toBeInstanceOf(Stats)
    })

    it('should return blksize > 0', async () => {
      // Given: a file
      // When: calling stat
      // Then: blksize should be positive

      const stats = await stat('/data/file.txt')

      expect(stats.blksize).toBeGreaterThan(0)
    })

    it('should return blocks >= 0', async () => {
      // Given: a file
      // When: calling stat
      // Then: blocks should be non-negative

      const stats = await stat('/data/file.txt')

      expect(stats.blocks).toBeGreaterThanOrEqual(0)
    })

    it('should return uid and gid as numbers', async () => {
      // Given: a file
      // When: calling stat
      // Then: uid and gid should be non-negative numbers

      const stats = await stat('/data/file.txt')

      expect(stats.uid).toBeGreaterThanOrEqual(0)
      expect(stats.gid).toBeGreaterThanOrEqual(0)
    })
  })

  describe('concurrent access', () => {
    it('should handle concurrent stat calls on same file', async () => {
      // Given: a file
      // When: calling stat concurrently multiple times
      // Then: all calls should succeed with same result

      const promises = [
        stat('/data/file.txt'),
        stat('/data/file.txt'),
        stat('/data/file.txt'),
      ]

      const results = await Promise.all(promises)

      // All should succeed
      expect(results).toHaveLength(3)
      expect(results[0].ino).toBe(results[1].ino)
      expect(results[1].ino).toBe(results[2].ino)
    })

    it('should handle concurrent stat calls on different files', async () => {
      // Given: multiple files
      // When: calling stat concurrently on different files
      // Then: all calls should succeed

      const promises = [
        stat('/data/file1.txt'),
        stat('/data/file2.txt'),
        stat('/data/file3.txt'),
      ]

      const results = await Promise.all(promises)

      expect(results).toHaveLength(3)
      results.forEach(stats => {
        expect(stats).toBeInstanceOf(Stats)
      })
    })
  })
})
