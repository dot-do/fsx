/**
 * Tests for RemoteFsClient - FsCapability Implementation
 *
 * Tests the remote filesystem client that implements the FsCapability interface.
 * Uses mock fetch to simulate API responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  RemoteFsClient,
  createRemoteFs,
  type RemoteFsClientOptions,
} from './remote-client.js'
import { ENOENT, EEXIST, EISDIR, FSError } from '../core/errors.js'
import type { Dirent } from '../core/types.js'

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
function errorResponse(code: string, message: string, path?: string, syscall?: string) {
  return { success: false, error: { code, message, path, syscall } }
}

/**
 * Convert string to base64 (browser-compatible).
 */
function stringToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

/**
 * Default client options for tests.
 */
function createClientOptions(fetchFn: typeof fetch): RemoteFsClientOptions {
  return {
    auth: 'test-api-key',
    fetch: fetchFn,
  }
}

// =============================================================================
// RemoteFsClient Tests
// =============================================================================

describe('RemoteFsClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>
  let client: RemoteFsClient

  beforeEach(() => {
    mockFetch = createMockFetch({})
    client = new RemoteFsClient('https://fsx.do', createClientOptions(mockFetch as typeof fetch))
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // ===========================================================================
  // Constructor Tests
  // ===========================================================================

  describe('constructor', () => {
    it('should create client with baseUrl', () => {
      const client = new RemoteFsClient('https://fsx.do')
      expect(client).toBeInstanceOf(RemoteFsClient)
      expect(client.getBaseUrl()).toBe('https://fsx.do')
    })

    it('should throw if baseUrl is not provided', () => {
      expect(() => new RemoteFsClient('')).toThrow('RemoteFsClient requires a baseUrl')
    })

    it('should strip trailing slash from baseUrl', () => {
      const client = new RemoteFsClient('https://fsx.do/')
      expect(client.getBaseUrl()).toBe('https://fsx.do')
    })

    it('should accept auth option', () => {
      mockFetch = createMockFetch(successResponse({ content: stringToBase64(''), encoding: 'base64' }))
      const client = new RemoteFsClient('https://fsx.do', {
        auth: 'my-api-key',
        fetch: mockFetch as typeof fetch,
      })

      client.read('/test.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer my-api-key',
          }),
        })
      )
    })

    it('should accept custom authorization header', () => {
      mockFetch = createMockFetch(successResponse({ content: stringToBase64(''), encoding: 'base64' }))
      const client = new RemoteFsClient('https://fsx.do', {
        authorization: 'Custom my-token',
        fetch: mockFetch as typeof fetch,
      })

      client.read('/test.txt')

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
      mockFetch = createMockFetch(successResponse({ content: stringToBase64(''), encoding: 'base64' }))
      const client = new RemoteFsClient('https://fsx.do', {
        namespace: 'my-namespace',
        fetch: mockFetch as typeof fetch,
      })

      client.read('/test.txt')

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
      mockFetch = createMockFetch(successResponse({ content: stringToBase64(''), encoding: 'base64' }))
      const client = new RemoteFsClient('https://fsx.do', {
        headers: { 'X-Custom-Header': 'custom-value' },
        fetch: mockFetch as typeof fetch,
      })

      client.read('/test.txt')

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
  // Factory Function Tests
  // ===========================================================================

  describe('createRemoteFs', () => {
    it('should create a RemoteFsClient instance', () => {
      const client = createRemoteFs('https://fsx.do')
      expect(client).toBeInstanceOf(RemoteFsClient)
    })

    it('should pass options to the client', () => {
      mockFetch = createMockFetch(successResponse({ content: stringToBase64(''), encoding: 'base64' }))
      const client = createRemoteFs('https://fsx.do', {
        auth: 'test-key',
        fetch: mockFetch as typeof fetch,
      })

      client.read('/test.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-key',
          }),
        })
      )
    })
  })

  // ===========================================================================
  // File Read Operations
  // ===========================================================================

  describe('read', () => {
    it('should read file content as Uint8Array by default', async () => {
      const content = 'Hello, World!'
      mockFetch = createMockFetch(successResponse({ content: stringToBase64(content), encoding: 'base64' }))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      const result = await client.read('/hello.txt')

      expect(result).toBeInstanceOf(Uint8Array)
      expect(new TextDecoder().decode(result as Uint8Array)).toBe(content)
    })

    it('should read file content as string with encoding', async () => {
      const content = 'Hello, World!'
      mockFetch = createMockFetch(successResponse({ content: stringToBase64(content), encoding: 'base64' }))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      const result = await client.read('/hello.txt', { encoding: 'utf-8' })

      expect(typeof result).toBe('string')
      expect(result).toBe(content)
    })

    it('should support range reads', async () => {
      mockFetch = createMockFetch(successResponse({ content: stringToBase64('llo'), encoding: 'base64' }))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.read('/hello.txt', { start: 2, end: 4 })

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/read',
        expect.objectContaining({
          body: JSON.stringify({ path: '/hello.txt', start: 2, end: 4 }),
        })
      )
    })

    it('should throw ENOENT for non-existent file', async () => {
      mockFetch = createMockFetch(
        errorResponse('ENOENT', 'no such file or directory', '/missing.txt', 'open'),
        { ok: false, status: 404 }
      )
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await expect(client.read('/missing.txt')).rejects.toThrow(ENOENT)
    })
  })

  // ===========================================================================
  // File Write Operations
  // ===========================================================================

  describe('write', () => {
    it('should write string content', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.write('/hello.txt', 'Hello, World!')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/write',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining(stringToBase64('Hello, World!')),
        })
      )
    })

    it('should write Uint8Array content', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      const bytes = new Uint8Array([1, 2, 3, 4, 5])
      await client.write('/data.bin', bytes)

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/write',
        expect.objectContaining({
          method: 'POST',
        })
      )
    })

    it('should include write options', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.write('/hello.txt', 'content', {
        mode: 0o600,
        flag: 'wx',
        tier: 'hot',
      })

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.mode).toBe(0o600)
      expect(body.flag).toBe('wx')
      expect(body.tier).toBe('hot')
    })
  })

  // ===========================================================================
  // Append Operations
  // ===========================================================================

  describe('append', () => {
    it('should append data with flag "a"', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.append('/log.txt', 'New line\n')

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.flag).toBe('a')
    })
  })

  // ===========================================================================
  // Directory Operations
  // ===========================================================================

  describe('mkdir', () => {
    it('should create a directory', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.mkdir('/mydir')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/mkdir',
        expect.objectContaining({
          body: JSON.stringify({ path: '/mydir' }),
        })
      )
    })

    it('should support recursive option', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.mkdir('/a/b/c', { recursive: true })

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.recursive).toBe(true)
    })

    it('should support mode option', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.mkdir('/private', { mode: 0o700 })

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.mode).toBe(0o700)
    })

    it('should throw EEXIST if directory exists', async () => {
      mockFetch = createMockFetch(
        errorResponse('EEXIST', 'file already exists', '/existing', 'mkdir'),
        { ok: false, status: 409 }
      )
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await expect(client.mkdir('/existing')).rejects.toThrow(EEXIST)
    })
  })

  describe('readdir', () => {
    it('should return array of filenames', async () => {
      mockFetch = createMockFetch(successResponse({
        entries: ['file1.txt', 'file2.txt', 'subdir'],
      }))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      const entries = await client.readdir('/mydir')

      expect(entries).toEqual(['file1.txt', 'file2.txt', 'subdir'])
    })

    it('should return Dirent objects with withFileTypes', async () => {
      mockFetch = createMockFetch(successResponse({
        entries: [
          { name: 'file.txt', parentPath: '/mydir', path: '/mydir/file.txt', type: 'file' },
          { name: 'subdir', parentPath: '/mydir', path: '/mydir/subdir', type: 'directory' },
        ],
      }))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      const entries = await client.readdir('/mydir', { withFileTypes: true }) as Dirent[]

      expect(entries).toHaveLength(2)
      expect(entries[0]!.name).toBe('file.txt')
      expect(entries[0]!.isFile()).toBe(true)
      expect(entries[0]!.isDirectory()).toBe(false)
      expect(entries[1]!.name).toBe('subdir')
      expect(entries[1]!.isDirectory()).toBe(true)
    })

    it('should support recursive option', async () => {
      mockFetch = createMockFetch(successResponse({ entries: [] }))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.readdir('/mydir', { recursive: true })

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.recursive).toBe(true)
    })
  })

  describe('rmdir', () => {
    it('should remove a directory', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.rmdir('/empty-dir')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/rmdir',
        expect.objectContaining({
          body: JSON.stringify({ path: '/empty-dir' }),
        })
      )
    })

    it('should support recursive option', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.rmdir('/non-empty', { recursive: true })

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.recursive).toBe(true)
    })
  })

  // ===========================================================================
  // Stat Operations
  // ===========================================================================

  describe('stat', () => {
    it('should return Stats object', async () => {
      const now = Date.now()
      mockFetch = createMockFetch(successResponse({
        dev: 1,
        ino: 12345,
        mode: 0o100644,
        nlink: 1,
        uid: 1000,
        gid: 1000,
        rdev: 0,
        size: 1024,
        blksize: 4096,
        blocks: 8,
        atimeMs: now,
        mtimeMs: now,
        ctimeMs: now,
        birthtimeMs: now,
        tier: 'hot',
      }))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      const stats = await client.stat('/hello.txt')

      expect(stats.size).toBe(1024)
      expect(stats.mode).toBe(0o100644)
      expect(stats.isFile()).toBe(true)
      expect(stats.isDirectory()).toBe(false)
      expect(stats.tier).toBe('hot')
    })

    it('should correctly identify directory', async () => {
      const now = Date.now()
      mockFetch = createMockFetch(successResponse({
        dev: 1,
        ino: 12346,
        mode: 0o040755,
        nlink: 2,
        uid: 1000,
        gid: 1000,
        rdev: 0,
        size: 4096,
        blksize: 4096,
        blocks: 8,
        atimeMs: now,
        mtimeMs: now,
        ctimeMs: now,
        birthtimeMs: now,
      }))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      const stats = await client.stat('/mydir')

      expect(stats.isDirectory()).toBe(true)
      expect(stats.isFile()).toBe(false)
    })

    it('should throw ENOENT for non-existent path', async () => {
      mockFetch = createMockFetch(
        errorResponse('ENOENT', 'no such file or directory', '/missing', 'stat'),
        { ok: false, status: 404 }
      )
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await expect(client.stat('/missing')).rejects.toThrow(ENOENT)
    })
  })

  describe('exists', () => {
    it('should return true for existing path', async () => {
      mockFetch = createMockFetch(successResponse({
        dev: 1, ino: 1, mode: 0o100644, nlink: 1, uid: 1000, gid: 1000,
        rdev: 0, size: 0, blksize: 4096, blocks: 0,
        atimeMs: Date.now(), mtimeMs: Date.now(), ctimeMs: Date.now(), birthtimeMs: Date.now(),
      }))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      const exists = await client.exists('/hello.txt')

      expect(exists).toBe(true)
    })

    it('should return false for non-existent path', async () => {
      mockFetch = createMockFetch(
        errorResponse('ENOENT', 'no such file or directory', '/missing', 'stat'),
        { ok: false, status: 404 }
      )
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      const exists = await client.exists('/missing')

      expect(exists).toBe(false)
    })
  })

  // ===========================================================================
  // Unlink and Remove Operations
  // ===========================================================================

  describe('unlink', () => {
    it('should delete a file', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.unlink('/old-file.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/unlink',
        expect.objectContaining({
          body: JSON.stringify({ path: '/old-file.txt' }),
        })
      )
    })
  })

  describe('rm', () => {
    it('should remove a file or directory', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.rm('/some-path')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/rm',
        expect.any(Object)
      )
    })

    it('should support force and recursive options', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.rm('/dir', { recursive: true, force: true })

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.recursive).toBe(true)
      expect(body.force).toBe(true)
    })
  })

  // ===========================================================================
  // Rename and Copy Operations
  // ===========================================================================

  describe('rename', () => {
    it('should rename a file', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.rename('/old.txt', '/new.txt')

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.oldPath).toBe('/old.txt')
      expect(body.newPath).toBe('/new.txt')
    })

    it('should support overwrite option', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.rename('/src.txt', '/dest.txt', { overwrite: true })

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.overwrite).toBe(true)
    })
  })

  describe('copyFile', () => {
    it('should copy a file', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.copyFile('/original.txt', '/backup.txt')

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.src).toBe('/original.txt')
      expect(body.dest).toBe('/backup.txt')
    })

    it('should support copy options', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.copyFile('/src', '/dest', { overwrite: true, recursive: true })

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.overwrite).toBe(true)
      expect(body.recursive).toBe(true)
    })
  })

  // ===========================================================================
  // Permission Operations
  // ===========================================================================

  describe('chmod', () => {
    it('should change file permissions', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.chmod('/script.sh', 0o755)

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.path).toBe('/script.sh')
      expect(body.mode).toBe(0o755)
    })
  })

  describe('chown', () => {
    it('should change file ownership', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.chown('/file.txt', 1000, 1000)

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.path).toBe('/file.txt')
      expect(body.uid).toBe(1000)
      expect(body.gid).toBe(1000)
    })
  })

  // ===========================================================================
  // Symbolic Link Operations
  // ===========================================================================

  describe('symlink', () => {
    it('should create a symbolic link', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.symlink('/actual/file.txt', '/link-to-file.txt')

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.target).toBe('/actual/file.txt')
      expect(body.path).toBe('/link-to-file.txt')
    })
  })

  describe('readlink', () => {
    it('should read symbolic link target', async () => {
      mockFetch = createMockFetch(successResponse({ target: '/actual/file.txt' }))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      const target = await client.readlink('/link')

      expect(target).toBe('/actual/file.txt')
    })
  })

  describe('realpath', () => {
    it('should resolve path', async () => {
      mockFetch = createMockFetch(successResponse({ path: '/resolved/path' }))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      const resolved = await client.realpath('/some/../path/./here')

      expect(resolved).toBe('/resolved/path')
    })
  })

  // ===========================================================================
  // Tiered Storage Operations
  // ===========================================================================

  describe('promote', () => {
    it('should promote file to higher tier', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.promote('/data.json', 'hot')

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.path).toBe('/data.json')
      expect(body.tier).toBe('hot')
    })
  })

  describe('demote', () => {
    it('should demote file to lower tier', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await client.demote('/archive.json', 'cold')

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.path).toBe('/archive.json')
      expect(body.tier).toBe('cold')
    })
  })

  describe('getTier', () => {
    it('should return current tier', async () => {
      mockFetch = createMockFetch(successResponse({ tier: 'warm' }))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      const tier = await client.getTier('/data.json')

      expect(tier).toBe('warm')
    })
  })

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  describe('setAuth', () => {
    it('should update authentication', async () => {
      mockFetch = createMockFetch(successResponse({ content: stringToBase64(''), encoding: 'base64' }))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      client.setAuth('new-token')
      await client.read('/test.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer new-token',
          }),
        })
      )
    })

    it('should remove authentication when undefined', async () => {
      mockFetch = createMockFetch(successResponse({ content: stringToBase64(''), encoding: 'base64' }))
      client = new RemoteFsClient('https://fsx.do', {
        auth: 'old-token',
        fetch: mockFetch as typeof fetch,
      })

      client.setAuth(undefined)
      await client.read('/test.txt')

      const headers = (mockFetch.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
      expect(headers.Authorization).toBeUndefined()
    })
  })

  describe('setNamespace', () => {
    it('should update namespace', async () => {
      mockFetch = createMockFetch(successResponse({ content: stringToBase64(''), encoding: 'base64' }))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      client.setNamespace('new-namespace')
      await client.read('/test.txt')

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

  describe('setHeaders', () => {
    it('should merge with existing headers', async () => {
      mockFetch = createMockFetch(successResponse({ content: stringToBase64(''), encoding: 'base64' }))
      client = new RemoteFsClient('https://fsx.do', {
        headers: { 'X-Existing': 'value' },
        fetch: mockFetch as typeof fetch,
      })

      client.setHeaders({ 'X-New': 'new-value' })
      await client.read('/test.txt')

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Existing': 'value',
            'X-New': 'new-value',
          }),
        })
      )
    })
  })

  // ===========================================================================
  // Base Path Tests
  // ===========================================================================

  describe('basePath option', () => {
    it('should prepend basePath to all paths', async () => {
      mockFetch = createMockFetch(successResponse({ content: stringToBase64(''), encoding: 'base64' }))
      client = new RemoteFsClient('https://fsx.do', {
        basePath: '/mount',
        fetch: mockFetch as typeof fetch,
      })

      await client.read('/hello.txt')

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.path).toBe('/mount/hello.txt')
    })

    it('should not double-prepend if path already has basePath', async () => {
      mockFetch = createMockFetch(successResponse({ content: stringToBase64(''), encoding: 'base64' }))
      client = new RemoteFsClient('https://fsx.do', {
        basePath: '/mount',
        fetch: mockFetch as typeof fetch,
      })

      await client.read('/mount/hello.txt')

      const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.path).toBe('/mount/hello.txt')
    })
  })

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('error handling', () => {
    it('should convert ENOENT errors', async () => {
      mockFetch = createMockFetch(
        errorResponse('ENOENT', 'no such file or directory', '/missing'),
        { ok: false, status: 404 }
      )
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await expect(client.read('/missing')).rejects.toThrow(ENOENT)
    })

    it('should convert EEXIST errors', async () => {
      mockFetch = createMockFetch(
        errorResponse('EEXIST', 'file already exists', '/existing'),
        { ok: false, status: 409 }
      )
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await expect(client.mkdir('/existing')).rejects.toThrow(EEXIST)
    })

    it('should convert EISDIR errors', async () => {
      mockFetch = createMockFetch(
        errorResponse('EISDIR', 'illegal operation on a directory', '/mydir'),
        { ok: false, status: 400 }
      )
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await expect(client.read('/mydir')).rejects.toThrow(EISDIR)
    })

    it('should handle unknown error codes', async () => {
      mockFetch = createMockFetch(
        errorResponse('UNKNOWN', 'some error'),
        { ok: false, status: 500 }
      )
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await expect(client.read('/test')).rejects.toThrow(FSError)
    })

    it('should handle network errors', async () => {
      const error = new Error('Network failure')
      mockFetch = vi.fn().mockRejectedValue(error)
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      await expect(client.read('/test')).rejects.toThrow()
    })
  })

  // ===========================================================================
  // Streaming Tests
  // ===========================================================================

  describe('createReadStream', () => {
    it('should create a readable stream', async () => {
      const content = 'Hello, World!'
      mockFetch = createMockFetch(successResponse({ content: stringToBase64(content) }))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      const stream = await client.createReadStream('/hello.txt')
      const reader = stream.getReader()

      const chunks: Uint8Array[] = []
      let result = await reader.read()
      while (!result.done) {
        chunks.push(result.value)
        result = await reader.read()
      }

      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const combined = new Uint8Array(totalLength)
      let offset = 0
      for (const chunk of chunks) {
        combined.set(chunk, offset)
        offset += chunk.length
      }

      expect(new TextDecoder().decode(combined)).toBe(content)
    })
  })

  describe('createWriteStream', () => {
    it('should create a writable stream', async () => {
      mockFetch = createMockFetch(successResponse(undefined))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      const stream = await client.createWriteStream('/output.txt')
      const writer = stream.getWriter()

      await writer.write(new TextEncoder().encode('Hello'))
      await writer.write(new TextEncoder().encode(', World!'))
      await writer.close()

      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/write',
        expect.any(Object)
      )
    })
  })

  // ===========================================================================
  // List Alias Test
  // ===========================================================================

  describe('list', () => {
    it('should be an alias for readdir', async () => {
      mockFetch = createMockFetch(successResponse({ entries: ['file.txt'] }))
      client = new RemoteFsClient('https://fsx.do', { fetch: mockFetch as typeof fetch })

      const entries = await client.list('/mydir')

      expect(entries).toEqual(['file.txt'])
      expect(mockFetch).toHaveBeenCalledWith(
        'https://fsx.do/api/fs/readdir',
        expect.any(Object)
      )
    })
  })
})
