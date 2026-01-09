/**
 * Tests for FsModule - Filesystem capability module with lazy initialization
 *
 * This test file covers:
 * - Lazy initialization (schema creation only on first use)
 * - Root directory auto-creation
 * - File CRUD operations
 * - Directory operations
 * - Tiered storage selection
 * - Error handling for POSIX errors
 *
 * @module durable-object/module.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FsModule, type FsModuleConfig } from './module.js'

// ============================================================================
// Mock SqlStorage Implementation
// ============================================================================

/**
 * Mock SQL result interface
 */
interface MockSqlResult<T> {
  one: () => T | null
  toArray: () => T[]
}

/**
 * Internal file entry for mock storage
 */
interface MockFileEntry {
  id: number
  path: string
  name: string
  parent_id: number | null
  type: 'file' | 'directory' | 'symlink'
  mode: number
  uid: number
  gid: number
  size: number
  blob_id: string | null
  link_target: string | null
  tier: 'hot' | 'warm' | 'cold'
  atime: number
  mtime: number
  ctime: number
  birthtime: number
  nlink: number
}

/**
 * Mock blob entry for mock storage
 */
interface MockBlobEntry {
  id: string
  data: ArrayBuffer | null
  size: number
  tier: 'hot' | 'warm' | 'cold'
  created_at: number
}

/**
 * Mock SQLite storage that simulates Cloudflare DO SQLite behavior
 */
class MockSqlStorage {
  private files: Map<string, MockFileEntry> = new Map()
  private blobs: Map<string, MockBlobEntry> = new Map()
  private nextFileId = 1
  public execCalls: { sql: string; params: unknown[] }[] = []
  public schemaCreated = false

  exec<T = unknown>(sql: string, ...params: unknown[]): MockSqlResult<T> {
    this.execCalls.push({ sql, params })
    const normalizedSql = sql.trim().toLowerCase()

    // Handle CREATE TABLE
    if (normalizedSql.includes('create table')) {
      this.schemaCreated = true
      return this.emptyResult<T>()
    }

    // Handle CREATE INDEX
    if (normalizedSql.includes('create index')) {
      return this.emptyResult<T>()
    }

    // Handle INSERT into files
    if (normalizedSql.includes('insert into files') || normalizedSql.includes('insert or replace into files')) {
      const entry: MockFileEntry = {
        id: this.nextFileId++,
        path: params[0] as string,
        name: params[1] as string,
        parent_id: params[2] as number | null,
        type: params[3] as 'file' | 'directory' | 'symlink',
        mode: params[4] as number,
        uid: params[5] as number,
        gid: params[6] as number,
        size: params[7] as number,
        blob_id: params[8] as string | null,
        tier: params[9] as 'hot' | 'warm' | 'cold',
        atime: params[10] as number,
        mtime: params[11] as number,
        ctime: params[12] as number,
        birthtime: params[13] as number,
        nlink: params[14] as number,
      }
      this.files.set(entry.path, entry)
      return this.emptyResult<T>()
    }

    // Handle INSERT into blobs
    if (normalizedSql.includes('insert') && normalizedSql.includes('blobs')) {
      const entry: MockBlobEntry = {
        id: params[0] as string,
        data: params[1] as ArrayBuffer | null,
        size: params[2] as number,
        tier: params[3] as 'hot' | 'warm' | 'cold',
        created_at: params[4] as number,
      }
      this.blobs.set(entry.id, entry)
      return this.emptyResult<T>()
    }

    // Handle SELECT from files WHERE path = ?
    if (normalizedSql.includes('select') && normalizedSql.includes('from files') && normalizedSql.includes('where path')) {
      const path = params[0] as string
      const file = this.files.get(path)
      return {
        one: () => (file as T) || null,
        toArray: () => (file ? [file as T] : []),
      }
    }

    // Handle SELECT from files WHERE parent_id = ?
    if (normalizedSql.includes('select') && normalizedSql.includes('from files') && normalizedSql.includes('where parent_id')) {
      const parentId = params[0] as number
      const children: MockFileEntry[] = []
      for (const file of this.files.values()) {
        if (file.parent_id === parentId) {
          children.push(file)
        }
      }
      return {
        one: () => (children[0] as T) || null,
        toArray: () => children as T[],
      }
    }

    // Handle SELECT from blobs WHERE id = ?
    if (normalizedSql.includes('select') && normalizedSql.includes('from blobs') && normalizedSql.includes('where id')) {
      const id = params[0] as string
      const blob = this.blobs.get(id)
      return {
        one: () => (blob ? ({ data: blob.data } as T) : null),
        toArray: () => (blob ? [{ data: blob.data } as T] : []),
      }
    }

    // Handle UPDATE files
    if (normalizedSql.includes('update files')) {
      const id = params[params.length - 1] as number
      for (const file of this.files.values()) {
        if (file.id === id) {
          // Parse SET clause and update fields based on the SQL pattern
          if (normalizedSql.includes('set blob_id')) {
            // UPDATE files SET blob_id = ?, size = ?, tier = ?, mtime = ?, ctime = ? WHERE id = ?
            file.blob_id = params[0] as string
            file.size = params[1] as number
            file.tier = params[2] as 'hot' | 'warm' | 'cold'
            file.mtime = params[3] as number
            file.ctime = params[4] as number
          } else if (normalizedSql.includes('set atime')) {
            file.atime = params[0] as number
          } else if (normalizedSql.includes('set mode')) {
            file.mode = params[0] as number
            file.ctime = params[1] as number
          } else if (normalizedSql.includes('set uid')) {
            file.uid = params[0] as number
            file.gid = params[1] as number
            file.ctime = params[2] as number
          }
          break
        }
      }
      return this.emptyResult<T>()
    }

    // Handle DELETE from files
    if (normalizedSql.includes('delete from files')) {
      const id = params[0] as number
      for (const [path, file] of this.files.entries()) {
        if (file.id === id) {
          this.files.delete(path)
          break
        }
      }
      return this.emptyResult<T>()
    }

    // Handle DELETE from blobs
    if (normalizedSql.includes('delete from blobs')) {
      const id = params[0] as string
      this.blobs.delete(id)
      return this.emptyResult<T>()
    }

    return this.emptyResult<T>()
  }

  private emptyResult<T>(): MockSqlResult<T> {
    return {
      one: () => null,
      toArray: () => [],
    }
  }

  // Test helpers
  getFile(path: string): MockFileEntry | undefined {
    return this.files.get(path)
  }

  getBlob(id: string): MockBlobEntry | undefined {
    return this.blobs.get(id)
  }

  getFileCount(): number {
    return this.files.size
  }

  getBlobCount(): number {
    return this.blobs.size
  }

  clear(): void {
    this.files.clear()
    this.blobs.clear()
    this.execCalls = []
    this.schemaCreated = false
    this.nextFileId = 1
  }
}

/**
 * Mock R2 bucket for testing tiered storage
 */
class MockR2Bucket {
  private objects: Map<string, Uint8Array> = new Map()

  async put(key: string, value: Uint8Array | ArrayBuffer | string): Promise<void> {
    if (typeof value === 'string') {
      this.objects.set(key, new TextEncoder().encode(value))
    } else if (value instanceof ArrayBuffer) {
      this.objects.set(key, new Uint8Array(value))
    } else {
      this.objects.set(key, value)
    }
  }

  async get(key: string): Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null> {
    const data = this.objects.get(key)
    if (!data) return null
    return {
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    }
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  has(key: string): boolean {
    return this.objects.has(key)
  }

  clear(): void {
    this.objects.clear()
  }
}

// ============================================================================
// Test Suites
// ============================================================================

describe('FsModule', () => {
  let mockSql: MockSqlStorage
  let mockR2: MockR2Bucket
  let fsModule: FsModule

  beforeEach(() => {
    mockSql = new MockSqlStorage()
    mockR2 = new MockR2Bucket()
    fsModule = new FsModule({
      sql: mockSql as unknown as SqlStorage,
      r2: mockR2 as unknown as R2Bucket,
    })
  })

  // ==========================================================================
  // Lazy Initialization Tests
  // ==========================================================================

  describe('lazy initialization', () => {
    it('should not execute any SQL until first operation', () => {
      // Just creating the module should not trigger any SQL
      const freshModule = new FsModule({
        sql: mockSql as unknown as SqlStorage,
      })

      expect(mockSql.execCalls.length).toBe(0)
      expect(mockSql.schemaCreated).toBe(false)
    })

    it('should create schema on first read operation', async () => {
      expect(mockSql.schemaCreated).toBe(false)

      // This will fail with ENOENT, but should still initialize
      try {
        await fsModule.read('/nonexistent.txt')
      } catch {
        // Expected ENOENT error
      }

      expect(mockSql.schemaCreated).toBe(true)
    })

    it('should create schema on first write operation', async () => {
      expect(mockSql.schemaCreated).toBe(false)

      await fsModule.write('/test.txt', 'Hello, World!')

      expect(mockSql.schemaCreated).toBe(true)
    })

    it('should create schema on first mkdir operation', async () => {
      expect(mockSql.schemaCreated).toBe(false)

      await fsModule.mkdir('/newdir')

      expect(mockSql.schemaCreated).toBe(true)
    })

    it('should create schema on first stat operation', async () => {
      expect(mockSql.schemaCreated).toBe(false)

      try {
        await fsModule.stat('/nonexistent')
      } catch {
        // Expected ENOENT error
      }

      expect(mockSql.schemaCreated).toBe(true)
    })

    it('should create schema on first exists check', async () => {
      expect(mockSql.schemaCreated).toBe(false)

      await fsModule.exists('/anything')

      expect(mockSql.schemaCreated).toBe(true)
    })

    it('should only create schema once across multiple operations', async () => {
      const initialCalls = mockSql.execCalls.length

      // Multiple operations
      await fsModule.exists('/test1')
      await fsModule.exists('/test2')
      await fsModule.mkdir('/dir1')

      // Count CREATE TABLE statements
      const createTableCalls = mockSql.execCalls.filter((c) => c.sql.toLowerCase().includes('create table'))

      // Should only have one schema creation (files + blobs = 2 tables, but in single statement)
      expect(createTableCalls.length).toBeLessThanOrEqual(1)
    })

    it('should create root directory on first initialization', async () => {
      await fsModule.exists('/')

      const root = mockSql.getFile('/')
      expect(root).toBeDefined()
      expect(root?.type).toBe('directory')
      expect(root?.path).toBe('/')
    })

    it('should not recreate root directory on subsequent operations', async () => {
      await fsModule.exists('/')
      const rootId1 = mockSql.getFile('/')?.id

      await fsModule.exists('/')
      const rootId2 = mockSql.getFile('/')?.id

      expect(rootId1).toBe(rootId2)
    })
  })

  // ==========================================================================
  // File Operations Tests
  // ==========================================================================

  describe('file operations', () => {
    beforeEach(async () => {
      // Initialize the module first
      await fsModule.exists('/')
    })

    describe('write', () => {
      it('should write string content as UTF-8', async () => {
        await fsModule.write('/test.txt', 'Hello, World!')

        const file = mockSql.getFile('/test.txt')
        expect(file).toBeDefined()
        expect(file?.type).toBe('file')
        expect(file?.size).toBe(13) // "Hello, World!" is 13 bytes in UTF-8
      })

      it('should write binary content', async () => {
        const data = new Uint8Array([0x00, 0x01, 0x02, 0xff])
        await fsModule.write('/binary.bin', data)

        const file = mockSql.getFile('/binary.bin')
        expect(file).toBeDefined()
        expect(file?.size).toBe(4)
      })

      it('should create blob for file content', async () => {
        await fsModule.write('/test.txt', 'Content')

        const file = mockSql.getFile('/test.txt')
        expect(file?.blob_id).toBeDefined()

        const blob = mockSql.getBlob(file!.blob_id!)
        expect(blob).toBeDefined()
        expect(blob?.size).toBe(7)
      })

      it('should select hot tier for small files', async () => {
        await fsModule.write('/small.txt', 'Small content')

        const file = mockSql.getFile('/small.txt')
        expect(file?.tier).toBe('hot')
      })

      it('should update existing file', async () => {
        await fsModule.write('/test.txt', 'Original')
        const file1 = mockSql.getFile('/test.txt')
        const blobId1 = file1?.blob_id

        await fsModule.write('/test.txt', 'Updated content')
        const file2 = mockSql.getFile('/test.txt')

        expect(file2?.blob_id).not.toBe(blobId1)
        expect(file2?.size).toBe(15)
      })

      it('should throw ENOENT when parent directory does not exist', async () => {
        await expect(fsModule.write('/nonexistent/test.txt', 'Content')).rejects.toThrow()
      })

      it('should support exclusive write flag', async () => {
        await fsModule.write('/existing.txt', 'First')

        // Should throw when trying to exclusively create existing file
        await expect(fsModule.write('/existing.txt', 'Second', { flag: 'wx' })).rejects.toThrow()
      })
    })

    describe('read', () => {
      it('should read file content as Uint8Array by default', async () => {
        await fsModule.write('/test.txt', 'Hello')
        const content = await fsModule.read('/test.txt')

        expect(content).toBeInstanceOf(Uint8Array)
      })

      it('should read file content as string with encoding option', async () => {
        await fsModule.write('/test.txt', 'Hello')
        const content = await fsModule.read('/test.txt', { encoding: 'utf-8' })

        expect(typeof content).toBe('string')
        expect(content).toBe('Hello')
      })

      it('should throw ENOENT for non-existent file', async () => {
        await expect(fsModule.read('/nonexistent.txt')).rejects.toThrow()
      })

      it('should throw EISDIR when reading a directory', async () => {
        await fsModule.mkdir('/testdir')

        await expect(fsModule.read('/testdir')).rejects.toThrow()
      })

      it('should return empty content for empty file', async () => {
        await fsModule.write('/empty.txt', '')
        const content = await fsModule.read('/empty.txt', { encoding: 'utf-8' })

        expect(content).toBe('')
      })
    })

    describe('unlink', () => {
      it('should delete a file', async () => {
        await fsModule.write('/test.txt', 'Content')
        expect(mockSql.getFile('/test.txt')).toBeDefined()

        await fsModule.unlink('/test.txt')
        expect(mockSql.getFile('/test.txt')).toBeUndefined()
      })

      it('should throw ENOENT for non-existent file', async () => {
        await expect(fsModule.unlink('/nonexistent.txt')).rejects.toThrow()
      })

      it('should throw EISDIR when trying to unlink a directory', async () => {
        await fsModule.mkdir('/testdir')

        await expect(fsModule.unlink('/testdir')).rejects.toThrow()
      })
    })

    describe('append', () => {
      it('should append to existing file', async () => {
        await fsModule.write('/log.txt', 'Line 1\n')
        await fsModule.append('/log.txt', 'Line 2\n')

        const content = await fsModule.read('/log.txt', { encoding: 'utf-8' })
        expect(content).toBe('Line 1\nLine 2\n')
      })

      it('should create file if it does not exist', async () => {
        await fsModule.append('/new.txt', 'Content')

        const file = mockSql.getFile('/new.txt')
        expect(file).toBeDefined()
      })
    })
  })

  // ==========================================================================
  // Directory Operations Tests
  // ==========================================================================

  describe('directory operations', () => {
    beforeEach(async () => {
      await fsModule.exists('/')
    })

    describe('mkdir', () => {
      it('should create a directory', async () => {
        await fsModule.mkdir('/newdir')

        const dir = mockSql.getFile('/newdir')
        expect(dir).toBeDefined()
        expect(dir?.type).toBe('directory')
      })

      it('should create nested directories with recursive option', async () => {
        await fsModule.mkdir('/a/b/c', { recursive: true })

        expect(mockSql.getFile('/a')).toBeDefined()
        expect(mockSql.getFile('/a/b')).toBeDefined()
        expect(mockSql.getFile('/a/b/c')).toBeDefined()
      })

      it('should throw ENOENT without recursive option when parent missing', async () => {
        await expect(fsModule.mkdir('/missing/child')).rejects.toThrow()
      })

      it('should throw EEXIST when directory already exists', async () => {
        await fsModule.mkdir('/existing')

        await expect(fsModule.mkdir('/existing')).rejects.toThrow()
      })

      it('should apply custom mode', async () => {
        await fsModule.mkdir('/private', { mode: 0o700 })

        const dir = mockSql.getFile('/private')
        expect(dir?.mode).toBe(0o700)
      })
    })

    describe('rmdir', () => {
      it('should remove an empty directory', async () => {
        await fsModule.mkdir('/emptydir')
        await fsModule.rmdir('/emptydir')

        expect(mockSql.getFile('/emptydir')).toBeUndefined()
      })

      it('should throw ENOENT for non-existent directory', async () => {
        await expect(fsModule.rmdir('/nonexistent')).rejects.toThrow()
      })

      it('should throw ENOTDIR when path is a file', async () => {
        await fsModule.write('/file.txt', 'content')

        await expect(fsModule.rmdir('/file.txt')).rejects.toThrow()
      })
    })

    describe('readdir', () => {
      it('should list directory contents', async () => {
        await fsModule.mkdir('/dir')
        await fsModule.write('/dir/file1.txt', 'content1')
        await fsModule.write('/dir/file2.txt', 'content2')

        const entries = await fsModule.readdir('/dir')

        expect(entries).toHaveLength(2)
        expect(entries).toContain('file1.txt')
        expect(entries).toContain('file2.txt')
      })

      it('should return Dirent objects with withFileTypes option', async () => {
        await fsModule.mkdir('/dir')
        await fsModule.write('/dir/file.txt', 'content')
        await fsModule.mkdir('/dir/subdir')

        const entries = (await fsModule.readdir('/dir', { withFileTypes: true })) as Array<{
          name: string
          isFile: () => boolean
          isDirectory: () => boolean
        }>

        expect(entries).toHaveLength(2)

        const file = entries.find((e) => e.name === 'file.txt')
        const subdir = entries.find((e) => e.name === 'subdir')

        expect(file?.isFile()).toBe(true)
        expect(subdir?.isDirectory()).toBe(true)
      })

      it('should throw ENOENT for non-existent directory', async () => {
        await expect(fsModule.readdir('/nonexistent')).rejects.toThrow()
      })

      it('should throw ENOTDIR when path is a file', async () => {
        await fsModule.write('/file.txt', 'content')

        await expect(fsModule.readdir('/file.txt')).rejects.toThrow()
      })
    })
  })

  // ==========================================================================
  // Metadata Operations Tests
  // ==========================================================================

  describe('metadata operations', () => {
    beforeEach(async () => {
      await fsModule.exists('/')
    })

    describe('stat', () => {
      it('should return stats for a file', async () => {
        await fsModule.write('/test.txt', 'Hello')

        const stats = await fsModule.stat('/test.txt')

        expect(stats.isFile()).toBe(true)
        expect(stats.isDirectory()).toBe(false)
        expect(stats.size).toBe(5)
      })

      it('should return stats for a directory', async () => {
        await fsModule.mkdir('/testdir')

        const stats = await fsModule.stat('/testdir')

        expect(stats.isFile()).toBe(false)
        expect(stats.isDirectory()).toBe(true)
      })

      it('should throw ENOENT for non-existent path', async () => {
        await expect(fsModule.stat('/nonexistent')).rejects.toThrow()
      })

      it('should include timestamps', async () => {
        await fsModule.write('/test.txt', 'content')

        const stats = await fsModule.stat('/test.txt')

        expect(stats.atime).toBeInstanceOf(Date)
        expect(stats.mtime).toBeInstanceOf(Date)
        expect(stats.ctime).toBeInstanceOf(Date)
        expect(stats.birthtime).toBeInstanceOf(Date)
      })
    })

    describe('exists', () => {
      it('should return true for existing file', async () => {
        await fsModule.write('/test.txt', 'content')

        expect(await fsModule.exists('/test.txt')).toBe(true)
      })

      it('should return true for existing directory', async () => {
        await fsModule.mkdir('/testdir')

        expect(await fsModule.exists('/testdir')).toBe(true)
      })

      it('should return false for non-existent path', async () => {
        expect(await fsModule.exists('/nonexistent')).toBe(false)
      })

      it('should return true for root directory', async () => {
        expect(await fsModule.exists('/')).toBe(true)
      })
    })

    describe('access', () => {
      it('should succeed for existing file', async () => {
        await fsModule.write('/test.txt', 'content')

        await expect(fsModule.access('/test.txt')).resolves.not.toThrow()
      })

      it('should throw ENOENT for non-existent file', async () => {
        await expect(fsModule.access('/nonexistent')).rejects.toThrow()
      })
    })

    describe('chmod', () => {
      it('should change file permissions', async () => {
        await fsModule.write('/test.txt', 'content')
        await fsModule.chmod('/test.txt', 0o755)

        const stats = await fsModule.stat('/test.txt')
        // Mode includes file type bits, so we need to mask them
        expect(stats.mode & 0o777).toBe(0o755)
      })

      it('should throw ENOENT for non-existent file', async () => {
        await expect(fsModule.chmod('/nonexistent', 0o644)).rejects.toThrow()
      })
    })
  })

  // ==========================================================================
  // Path Normalization Tests
  // ==========================================================================

  describe('path normalization', () => {
    beforeEach(async () => {
      await fsModule.exists('/')
    })

    it('should handle relative paths', async () => {
      await fsModule.write('test.txt', 'content')

      expect(await fsModule.exists('/test.txt')).toBe(true)
    })

    it('should handle trailing slashes', async () => {
      await fsModule.mkdir('/testdir')

      expect(await fsModule.exists('/testdir/')).toBe(true)
    })

    it('should handle double slashes', async () => {
      await fsModule.mkdir('/testdir')

      expect(await fsModule.exists('//testdir')).toBe(true)
    })

    it('should resolve dot segments', async () => {
      await fsModule.mkdir('/a')
      await fsModule.mkdir('/a/b')

      expect(await fsModule.exists('/a/./b')).toBe(true)
    })

    it('should resolve double dot segments', async () => {
      await fsModule.mkdir('/a')
      await fsModule.mkdir('/a/b')

      expect(await fsModule.exists('/a/b/../b')).toBe(true)
    })
  })

  // ==========================================================================
  // Tiered Storage Tests
  // ==========================================================================

  describe('tiered storage', () => {
    it('should use hot tier for files under threshold', async () => {
      const smallContent = 'Small file content'
      await fsModule.write('/small.txt', smallContent)

      const file = mockSql.getFile('/small.txt')
      expect(file?.tier).toBe('hot')
    })

    it('should store blob data in SQLite for hot tier', async () => {
      await fsModule.write('/hot.txt', 'Hot tier content')

      const file = mockSql.getFile('/hot.txt')
      const blob = mockSql.getBlob(file!.blob_id!)

      expect(blob?.data).toBeDefined()
    })

    it('should allow explicit tier selection', async () => {
      await fsModule.write('/warm.txt', 'Content', { tier: 'warm' })

      const file = mockSql.getFile('/warm.txt')
      expect(file?.tier).toBe('warm')
    })
  })

  // ==========================================================================
  // Module Configuration Tests
  // ==========================================================================

  describe('module configuration', () => {
    it('should accept custom hot tier max size', async () => {
      const customModule = new FsModule({
        sql: mockSql as unknown as SqlStorage,
        hotMaxSize: 100, // 100 bytes
      })

      // Large content that exceeds threshold
      const largeContent = 'x'.repeat(200)
      await customModule.write('/large.txt', largeContent)

      const file = mockSql.getFile('/large.txt')
      // Without R2, should still use hot tier
      expect(file?.tier).toBe('hot')
    })

    it('should accept custom default file mode', async () => {
      const customModule = new FsModule({
        sql: mockSql as unknown as SqlStorage,
        defaultMode: 0o600,
      })

      await customModule.write('/private.txt', 'secret')

      const file = mockSql.getFile('/private.txt')
      expect(file?.mode).toBe(0o600)
    })

    it('should accept custom default directory mode', async () => {
      const customModule = new FsModule({
        sql: mockSql as unknown as SqlStorage,
        defaultDirMode: 0o700,
      })

      await customModule.mkdir('/private')

      const dir = mockSql.getFile('/private')
      expect(dir?.mode).toBe(0o700)
    })

    it('should accept custom base path', async () => {
      const customModule = new FsModule({
        sql: mockSql as unknown as SqlStorage,
        basePath: '/app',
      })

      // Initialize to create root and /app
      await customModule.mkdir('/app', { recursive: true })
      await customModule.write('test.txt', 'content')

      // File should be at /app/test.txt
      expect(mockSql.getFile('/app/test.txt')).toBeDefined()
    })
  })

  // ==========================================================================
  // Dispose Tests
  // ==========================================================================

  describe('dispose', () => {
    it('should complete without error', async () => {
      await fsModule.exists('/') // Initialize first

      await expect(fsModule.dispose()).resolves.not.toThrow()
    })
  })
})
