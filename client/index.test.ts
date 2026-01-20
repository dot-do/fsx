/**
 * Tests for FsxClient SDK
 *
 * Tests the SDK client for remote fsx.do service access.
 * Uses mock fetch to simulate API responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  FsxClient,
  FsxError,
  FsxNotFoundError,
  FsxExistsError,
  FsxPermissionError,
  FsxAuthError,
  FsxNetworkError,
  type FsxClientOptions,
  type Stats,
  type Dirent,
} from './index'

// =============================================================================
// Test Utilities
// =============================================================================

/**
 * Create a mock fetch function that returns the specified response.
 */
function createMockFetch(response: unknown, options?: { ok?: boolean; status?: number }) {
  return vi.fn().mockResolvedValue({
    ok: options?.ok ?? true,
    status: options?.status ?? 200,
    json: () => Promise.resolve(response),
  })
}

/**
 * Create a successful API response.
 */
function successResponse<T>(data: T) {
  return { success: true, data }
}

/**
 * Create an error API response.
 */
function errorResponse(code: string, message: string, path?: string) {
  return { success: false, error: { code, message, path } }
}

/**
 * Default client options for tests.
 */
function createClientOptions(fetchFn: typeof fetch): FsxClientOptions {
  return {
    baseUrl: 'https://fsx.do',
    apiKey: 'test-api-key',
    fetch: fetchFn,
  }
}

// =============================================================================
// Helper Functions Tests
// =============================================================================

describe('FsxClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>
  let client: FsxClient

  beforeEach(() => {
    mockFetch = createMockFetch({})
    client = new FsxClient(createClientOptions(mockFetch as typeof fetch))
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ===========================================================================
  // Constructor Tests
  // ===========================================================================

  describe('constructor', () => {
    it('should create client with required options', () => {
      const client = new FsxClient({
        baseUrl: 'https://fsx.do',
        fetch: mockFetch as typeof fetch,
      })
      expect(client).toBeInstanceOf(FsxClient)
    })

    it('should throw if baseUrl is not provided', () => {
      expect(() => new FsxClient({} as FsxClientOptions)).toThrow('FsxClient requires a baseUrl')
    })

    it('should strip trailing slash from baseUrl', () => {
      const client = new FsxClient({
        baseUrl: 'https://fsx.do/',
        fetch: mockFetch as typeof fetch,
      })
      expect(client.getBaseUrl()).toBe('https://fsx.do')
    })

    it('should accept API key authentication', () => {
      mockFetch = createMockFetch(successResponse({ content: '', encoding: 'base64' }))
      const client = new FsxClient({
        baseUrl: 'https://fsx.do',
        apiKey: 'sk_live_test',
        fetch: mockFetch as typeof fetch,
      })

      client.readFile('/test.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer sk_live_test',
          }),
        })
      )
    })

    it('should accept JWT authentication', () => {
      mockFetch = createMockFetch(successResponse({ content: '', encoding: 'base64' }))
      const client = new FsxClient({
        baseUrl: 'https://fsx.do',
        jwt: 'eyJhbGciOiJIUzI1NiJ9.test',
        fetch: mockFetch as typeof fetch,
      })

      client.readFile('/test.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.test',
          }),
        })
      )
    })

    it('should accept custom authorization header', () => {
      mockFetch = createMockFetch(successResponse({ content: '', encoding: 'base64' }))
      const client = new FsxClient({
        baseUrl: 'https://fsx.do',
        authorization: 'Custom my-token',
        fetch: mockFetch as typeof fetch,
      })

      client.readFile('/test.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Custom my-token',
          }),
        })
      )
    })

    it('should include namespace header when set', () => {
      mockFetch = createMockFetch(successResponse({ content: '', encoding: 'base64' }))
      const client = new FsxClient({
        baseUrl: 'https://fsx.do',
        namespace: 'my-namespace',
        fetch: mockFetch as typeof fetch,
      })

      client.readFile('/test.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Fsx-Namespace': 'my-namespace',
          }),
        })
      )
    })

    it('should include custom headers', () => {
      mockFetch = createMockFetch(successResponse({ content: '', encoding: 'base64' }))
      const client = new FsxClient({
        baseUrl: 'https://fsx.do',
        headers: { 'X-Custom-Header': 'custom-value' },
        fetch: mockFetch as typeof fetch,
      })

      client.readFile('/test.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Custom-Header': 'custom-value',
          }),
        })
      )
    })
  })

  // ===========================================================================
  // File Operations Tests
  // ===========================================================================

  describe('readFile', () => {
    it('should read file as string with encoding', async () => {
      const content = 'Hello, World!'
      const base64Content = Buffer.from(content).toString('base64')
      mockFetch = createMockFetch(successResponse({ content: base64Content, encoding: 'base64' }))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const result = await client.readFile('/hello.txt', 'utf-8')

      expect(result).toBe(content)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/read',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ path: '/hello.txt' }),
        })
      )
    })

    it('should read file as Uint8Array without encoding', async () => {
      const bytes = new Uint8Array([1, 2, 3, 4, 5])
      const base64Content = Buffer.from(bytes).toString('base64')
      mockFetch = createMockFetch(successResponse({ content: base64Content, encoding: 'base64' }))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const result = await client.readFile('/data.bin')

      expect(result).toBeInstanceOf(Uint8Array)
      expect(Array.from(result as Uint8Array)).toEqual([1, 2, 3, 4, 5])
    })

    it('should support range reads', async () => {
      mockFetch = createMockFetch(successResponse({ content: '', encoding: 'base64' }))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.readFile('/large.bin', { start: 100, end: 200 })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ path: '/large.bin', start: 100, end: 200 }),
        })
      )
    })

    it('should throw FsxNotFoundError for missing files', async () => {
      mockFetch = createMockFetch(
        errorResponse('ENOENT', 'no such file or directory', '/missing.txt'),
        { ok: false, status: 404 }
      )
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await expect(client.readFile('/missing.txt')).rejects.toThrow(FsxNotFoundError)
    })
  })

  describe('writeFile', () => {
    it('should write string content', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.writeFile('/hello.txt', 'Hello, World!')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/write',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"path":"/hello.txt"'),
        })
      )
    })

    it('should write binary content', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.writeFile('/data.bin', new Uint8Array([1, 2, 3]))

      expect(mockFetch).toHaveBeenCalled()
    })

    it('should pass mode option', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.writeFile('/script.sh', '#!/bin/bash', { mode: 0o755 })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"mode":493'), // 0o755 = 493
        })
      )
    })

    it('should pass tier option', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.writeFile('/data.json', '{}', { tier: 'hot' })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"tier":"hot"'),
        })
      )
    })
  })

  describe('appendFile', () => {
    it('should call writeFile with append flag', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.appendFile('/log.txt', 'New entry\n')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"flag":"a"'),
        })
      )
    })
  })

  describe('unlink', () => {
    it('should delete a file', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.unlink('/old-file.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/unlink',
        expect.objectContaining({
          body: JSON.stringify({ path: '/old-file.txt' }),
        })
      )
    })
  })

  describe('rename', () => {
    it('should rename a file', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.rename('/old.txt', '/new.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/rename',
        expect.objectContaining({
          body: expect.stringContaining('"oldPath":"/old.txt"'),
        })
      )
    })

    it('should pass overwrite option', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.rename('/old.txt', '/new.txt', { overwrite: true })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"overwrite":true'),
        })
      )
    })
  })

  describe('copyFile', () => {
    it('should copy a file', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.copyFile('/src.txt', '/dest.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/copy',
        expect.objectContaining({
          body: expect.stringContaining('"src":"/src.txt"'),
        })
      )
    })
  })

  describe('truncate', () => {
    it('should truncate a file', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.truncate('/large.txt', 100)

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/truncate',
        expect.objectContaining({
          body: JSON.stringify({ path: '/large.txt', length: 100 }),
        })
      )
    })

    it('should truncate to 0 by default', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.truncate('/file.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ path: '/file.txt', length: 0 }),
        })
      )
    })
  })

  // ===========================================================================
  // Directory Operations Tests
  // ===========================================================================

  describe('mkdir', () => {
    it('should create a directory', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.mkdir('/mydir')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/mkdir',
        expect.objectContaining({
          body: expect.stringContaining('"path":"/mydir"'),
        })
      )
    })

    it('should pass recursive option', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.mkdir('/a/b/c', { recursive: true })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"recursive":true'),
        })
      )
    })
  })

  describe('rmdir', () => {
    it('should remove a directory', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.rmdir('/mydir')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/rmdir',
        expect.objectContaining({
          body: expect.stringContaining('"path":"/mydir"'),
        })
      )
    })
  })

  describe('rm', () => {
    it('should remove a file or directory', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.rm('/file.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/rm',
        expect.objectContaining({
          body: expect.stringContaining('"path":"/file.txt"'),
        })
      )
    })

    it('should pass recursive and force options', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.rm('/dir', { recursive: true, force: true })

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('"recursive":true'),
        })
      )
    })
  })

  describe('readdir', () => {
    it('should list directory contents as strings', async () => {
      mockFetch = createMockFetch(successResponse({ entries: ['file1.txt', 'file2.txt', 'subdir'] }))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const result = await client.readdir('/mydir')

      expect(result).toEqual(['file1.txt', 'file2.txt', 'subdir'])
    })

    it('should list directory contents as Dirent objects', async () => {
      mockFetch = createMockFetch(
        successResponse({
          entries: [
            { name: 'file1.txt', parentPath: '/mydir', path: '/mydir/file1.txt', type: 'file' },
            { name: 'subdir', parentPath: '/mydir', path: '/mydir/subdir', type: 'directory' },
          ],
        })
      )
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const result = await client.readdir('/mydir', { withFileTypes: true })

      expect(result).toHaveLength(2)
      expect((result[0] as Dirent).name).toBe('file1.txt')
      expect((result[0] as Dirent).isFile()).toBe(true)
      expect((result[1] as Dirent).name).toBe('subdir')
      expect((result[1] as Dirent).isDirectory()).toBe(true)
    })
  })

  describe('list', () => {
    it('should be an alias for readdir', async () => {
      mockFetch = createMockFetch(successResponse({ entries: ['file.txt'] }))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const result = await client.list('/mydir')

      expect(result).toEqual(['file.txt'])
    })
  })

  // ===========================================================================
  // Metadata Operations Tests
  // ===========================================================================

  describe('stat', () => {
    it('should return stats for a file', async () => {
      mockFetch = createMockFetch(
        successResponse({
          dev: 0,
          ino: 1,
          mode: 0o100644,
          nlink: 1,
          uid: 0,
          gid: 0,
          rdev: 0,
          size: 1024,
          blksize: 4096,
          blocks: 8,
          atimeMs: 1704067200000,
          mtimeMs: 1704067200000,
          ctimeMs: 1704067200000,
          birthtimeMs: 1704067200000,
          type: 'file',
        })
      )
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const stats = await client.stat('/file.txt')

      expect(stats.size).toBe(1024)
      expect(stats.isFile()).toBe(true)
      expect(stats.isDirectory()).toBe(false)
    })

    it('should return stats for a directory', async () => {
      mockFetch = createMockFetch(
        successResponse({
          dev: 0,
          ino: 1,
          mode: 0o040755,
          nlink: 2,
          uid: 0,
          gid: 0,
          rdev: 0,
          size: 0,
          blksize: 4096,
          blocks: 0,
          atimeMs: 1704067200000,
          mtimeMs: 1704067200000,
          ctimeMs: 1704067200000,
          birthtimeMs: 1704067200000,
          type: 'directory',
        })
      )
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const stats = await client.stat('/mydir')

      expect(stats.isDirectory()).toBe(true)
      expect(stats.isFile()).toBe(false)
    })
  })

  describe('lstat', () => {
    it('should return stats without following symlinks', async () => {
      mockFetch = createMockFetch(
        successResponse({
          dev: 0,
          ino: 1,
          mode: 0o120777,
          nlink: 1,
          uid: 0,
          gid: 0,
          rdev: 0,
          size: 10,
          blksize: 4096,
          blocks: 0,
          atimeMs: 1704067200000,
          mtimeMs: 1704067200000,
          ctimeMs: 1704067200000,
          birthtimeMs: 1704067200000,
          type: 'symlink',
        })
      )
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const stats = await client.lstat('/link')

      expect(stats.isSymbolicLink()).toBe(true)
    })
  })

  describe('exists', () => {
    it('should return true if path exists', async () => {
      mockFetch = createMockFetch(
        successResponse({
          dev: 0,
          ino: 1,
          mode: 0o100644,
          nlink: 1,
          uid: 0,
          gid: 0,
          rdev: 0,
          size: 0,
          blksize: 4096,
          blocks: 0,
          atimeMs: 1704067200000,
          mtimeMs: 1704067200000,
          ctimeMs: 1704067200000,
          birthtimeMs: 1704067200000,
        })
      )
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const result = await client.exists('/file.txt')

      expect(result).toBe(true)
    })

    it('should return false if path does not exist', async () => {
      mockFetch = createMockFetch(
        errorResponse('ENOENT', 'no such file or directory'),
        { ok: false, status: 404 }
      )
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const result = await client.exists('/missing.txt')

      expect(result).toBe(false)
    })
  })

  describe('access', () => {
    it('should not throw for accessible files', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await expect(client.access('/file.txt')).resolves.toBeUndefined()
    })

    it('should throw for inaccessible files', async () => {
      mockFetch = createMockFetch(
        errorResponse('EACCES', 'permission denied', '/secret.txt'),
        { ok: false, status: 403 }
      )
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await expect(client.access('/secret.txt')).rejects.toThrow(FsxPermissionError)
    })
  })

  describe('chmod', () => {
    it('should change file permissions', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.chmod('/script.sh', 0o755)

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/chmod',
        expect.objectContaining({
          body: JSON.stringify({ path: '/script.sh', mode: 0o755 }),
        })
      )
    })
  })

  describe('chown', () => {
    it('should change file ownership', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.chown('/file.txt', 1000, 1000)

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/chown',
        expect.objectContaining({
          body: JSON.stringify({ path: '/file.txt', uid: 1000, gid: 1000 }),
        })
      )
    })
  })

  describe('utimes', () => {
    it('should update file timestamps with Date objects', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const now = new Date()
      await client.utimes('/file.txt', now, now)

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/utimes',
        expect.objectContaining({
          body: JSON.stringify({ path: '/file.txt', atime: now.getTime(), mtime: now.getTime() }),
        })
      )
    })

    it('should update file timestamps with numbers', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.utimes('/file.txt', 1704067200000, 1704067200000)

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/utimes',
        expect.objectContaining({
          body: JSON.stringify({ path: '/file.txt', atime: 1704067200000, mtime: 1704067200000 }),
        })
      )
    })
  })

  // ===========================================================================
  // Symbolic Links Tests
  // ===========================================================================

  describe('symlink', () => {
    it('should create a symbolic link', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.symlink('/target.txt', '/link')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/symlink',
        expect.objectContaining({
          body: JSON.stringify({ target: '/target.txt', path: '/link' }),
        })
      )
    })
  })

  describe('link', () => {
    it('should create a hard link', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.link('/original.txt', '/hardlink.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/link',
        expect.objectContaining({
          body: JSON.stringify({ existingPath: '/original.txt', newPath: '/hardlink.txt' }),
        })
      )
    })
  })

  describe('readlink', () => {
    it('should read symlink target', async () => {
      mockFetch = createMockFetch(successResponse({ target: '/actual/file.txt' }))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const target = await client.readlink('/link')

      expect(target).toBe('/actual/file.txt')
    })
  })

  describe('realpath', () => {
    it('should resolve path following symlinks', async () => {
      mockFetch = createMockFetch(successResponse({ path: '/data/actual-file.txt' }))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const resolved = await client.realpath('/app/../data/./link')

      expect(resolved).toBe('/data/actual-file.txt')
    })
  })

  // ===========================================================================
  // Tiered Storage Tests
  // ===========================================================================

  describe('promote', () => {
    it('should promote file to hot tier', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.promote('/data.json', 'hot')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/promote',
        expect.objectContaining({
          body: JSON.stringify({ path: '/data.json', tier: 'hot' }),
        })
      )
    })
  })

  describe('demote', () => {
    it('should demote file to cold tier', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      await client.demote('/archive.json', 'cold')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/demote',
        expect.objectContaining({
          body: JSON.stringify({ path: '/archive.json', tier: 'cold' }),
        })
      )
    })
  })

  describe('getTier', () => {
    it('should get file storage tier', async () => {
      mockFetch = createMockFetch(successResponse({ tier: 'warm' }))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const tier = await client.getTier('/data.json')

      expect(tier).toBe('warm')
    })
  })

  // ===========================================================================
  // Utility Methods Tests
  // ===========================================================================

  describe('setAuth', () => {
    it('should update API key', async () => {
      mockFetch = createMockFetch(successResponse({ content: '', encoding: 'base64' }))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      client.setAuth({ apiKey: 'new-api-key' })
      await client.readFile('/test.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer new-api-key',
          }),
        })
      )
    })

    it('should update JWT', async () => {
      mockFetch = createMockFetch(successResponse({ content: '', encoding: 'base64' }))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      client.setAuth({ jwt: 'new-jwt' })
      await client.readFile('/test.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer new-jwt',
          }),
        })
      )
    })
  })

  describe('setHeaders', () => {
    it('should add custom headers', async () => {
      mockFetch = createMockFetch(successResponse({ content: '', encoding: 'base64' }))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      client.setHeaders({ 'X-Request-Id': '12345' })
      await client.readFile('/test.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Request-Id': '12345',
          }),
        })
      )
    })
  })

  describe('setNamespace', () => {
    it('should update namespace', async () => {
      mockFetch = createMockFetch(successResponse({ content: '', encoding: 'base64' }))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      client.setNamespace('new-namespace')
      await client.readFile('/test.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Fsx-Namespace': 'new-namespace',
          }),
        })
      )
    })
  })

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('error handling', () => {
    it('should throw FsxNotFoundError for ENOENT', async () => {
      mockFetch = createMockFetch(
        errorResponse('ENOENT', 'no such file or directory', '/missing.txt'),
        { ok: false, status: 404 }
      )
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const error = await client.readFile('/missing.txt').catch((e) => e)

      expect(error).toBeInstanceOf(FsxNotFoundError)
      expect(error.code).toBe('ENOENT')
      expect(error.path).toBe('/missing.txt')
    })

    it('should throw FsxExistsError for EEXIST', async () => {
      mockFetch = createMockFetch(
        errorResponse('EEXIST', 'file already exists', '/existing.txt'),
        { ok: false, status: 409 }
      )
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const error = await client.writeFile('/existing.txt', 'data', { flag: 'wx' }).catch((e) => e)

      expect(error).toBeInstanceOf(FsxExistsError)
      expect(error.code).toBe('EEXIST')
    })

    it('should throw FsxPermissionError for EACCES', async () => {
      mockFetch = createMockFetch(
        errorResponse('EACCES', 'permission denied', '/secret.txt'),
        { ok: false, status: 403 }
      )
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const error = await client.readFile('/secret.txt').catch((e) => e)

      expect(error).toBeInstanceOf(FsxPermissionError)
      expect(error.code).toBe('EACCES')
    })

    it('should throw FsxAuthError for EAUTH', async () => {
      mockFetch = createMockFetch(
        errorResponse('EAUTH', 'authentication failed'),
        { ok: false, status: 401 }
      )
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const error = await client.readFile('/file.txt').catch((e) => e)

      expect(error).toBeInstanceOf(FsxAuthError)
      expect(error.code).toBe('EAUTH')
    })

    it('should throw FsxError for unknown errors', async () => {
      mockFetch = createMockFetch(
        errorResponse('UNKNOWN', 'something went wrong'),
        { ok: false, status: 500 }
      )
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const error = await client.readFile('/file.txt').catch((e) => e)

      expect(error).toBeInstanceOf(FsxError)
      expect(error.code).toBe('UNKNOWN')
    })

    it('should throw FsxNetworkError for fetch failures', async () => {
      mockFetch = vi.fn().mockRejectedValue(new Error('Network error'))
      client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

      const error = await client.readFile('/file.txt').catch((e) => e)

      expect(error).toBeInstanceOf(FsxNetworkError)
    })
  })
})

// =============================================================================
// Stats Type Checking Tests
// =============================================================================

describe('Stats type checking methods', () => {
  it('should correctly identify file types by mode', async () => {
    const mockFetch = createMockFetch(
      successResponse({
        dev: 0,
        ino: 1,
        mode: 0o100644, // Regular file
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size: 0,
        blksize: 4096,
        blocks: 0,
        atimeMs: 0,
        mtimeMs: 0,
        ctimeMs: 0,
        birthtimeMs: 0,
      })
    )
    const client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

    const stats = await client.stat('/file.txt')

    expect(stats.isFile()).toBe(true)
    expect(stats.isDirectory()).toBe(false)
    expect(stats.isSymbolicLink()).toBe(false)
    expect(stats.isBlockDevice()).toBe(false)
    expect(stats.isCharacterDevice()).toBe(false)
    expect(stats.isFIFO()).toBe(false)
    expect(stats.isSocket()).toBe(false)
  })
})

// =============================================================================
// Dirent Type Checking Tests
// =============================================================================

describe('Dirent type checking methods', () => {
  it('should correctly identify entry types', async () => {
    const mockFetch = createMockFetch(
      successResponse({
        entries: [
          { name: 'file.txt', parentPath: '/', path: '/file.txt', type: 'file' },
          { name: 'dir', parentPath: '/', path: '/dir', type: 'directory' },
          { name: 'link', parentPath: '/', path: '/link', type: 'symlink' },
        ],
      })
    )
    const client = new FsxClient(createClientOptions(mockFetch as typeof fetch))

    const entries = await client.readdir('/', { withFileTypes: true })

    expect(entries[0]!.isFile()).toBe(true)
    expect(entries[0]!.isDirectory()).toBe(false)

    expect(entries[1]!.isFile()).toBe(false)
    expect(entries[1]!.isDirectory()).toBe(true)

    expect(entries[2]!.isFile()).toBe(false)
    expect(entries[2]!.isSymbolicLink()).toBe(true)
  })
})
