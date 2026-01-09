/**
 * Tests for fs_write MCP tool
 *
 * RED phase - These tests define the expected behavior of the fs_write MCP tool.
 * Tests will fail until the implementation is complete.
 *
 * The fs_write tool should:
 * - Write content to a new file
 * - Overwrite existing files
 * - Create parent directories if needed (when recursive option is set)
 * - Handle permission denied errors gracefully
 * - Support different encodings (utf-8, base64)
 * - Handle empty content
 * - Return proper MCP tool result format
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { invokeTool, fsTools, type McpToolResult } from './index'
import type { FSx } from '../core/fsx'

/**
 * Mock FSx implementation for testing MCP tools
 */
function createMockFSx(): FSx & {
  _files: Map<string, { content: Uint8Array; mode: number }>
  _directories: Set<string>
  _permissionDenied: Set<string>
} {
  const files = new Map<string, { content: Uint8Array; mode: number }>()
  const directories = new Set<string>(['/', '/test', '/home', '/home/user'])
  const permissionDenied = new Set<string>()

  const getParentPath = (path: string): string => {
    const lastSlash = path.lastIndexOf('/')
    if (lastSlash <= 0) return '/'
    return path.substring(0, lastSlash)
  }

  const mockFSx = {
    _files: files,
    _directories: directories,
    _permissionDenied: permissionDenied,

    async writeFile(
      path: string,
      data: string | Uint8Array,
      options?: { encoding?: string; mode?: number; flag?: string }
    ): Promise<void> {
      // Check for permission denied
      if (permissionDenied.has(path)) {
        const error = new Error(`EACCES: permission denied, open '${path}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'EACCES'
        error.syscall = 'open'
        error.path = path
        throw error
      }

      // Check if parent directory exists
      const parentPath = getParentPath(path)
      if (parentPath !== '/' && !directories.has(parentPath) && !files.has(parentPath)) {
        const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'ENOENT'
        error.syscall = 'open'
        error.path = parentPath
        throw error
      }

      // Check if path is a directory
      if (directories.has(path)) {
        const error = new Error(`EISDIR: illegal operation on a directory, open '${path}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'EISDIR'
        error.syscall = 'open'
        error.path = path
        throw error
      }

      // Convert data to Uint8Array based on encoding
      let content: Uint8Array
      if (typeof data === 'string') {
        content = new TextEncoder().encode(data)
      } else {
        content = data
      }

      // Write the file (overwriting if exists)
      files.set(path, { content, mode: options?.mode ?? 0o666 })
    },

    async appendFile(
      path: string,
      data: string | Uint8Array,
      options?: { encoding?: string; mode?: number; flag?: string }
    ): Promise<void> {
      const newContent = typeof data === 'string' ? new TextEncoder().encode(data) : data
      const existing = files.get(path)
      if (existing) {
        const combined = new Uint8Array(existing.content.length + newContent.length)
        combined.set(existing.content)
        combined.set(newContent, existing.content.length)
        files.set(path, { content: combined, mode: existing.mode })
      } else {
        files.set(path, { content: newContent, mode: options?.mode ?? 0o666 })
      }
    },

    async readFile(path: string, encoding?: string): Promise<string | Uint8Array> {
      const file = files.get(path)
      if (!file) {
        const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & {
          code: string
        }
        error.code = 'ENOENT'
        throw error
      }
      if (encoding === 'utf-8' || encoding === 'utf8') {
        return new TextDecoder().decode(file.content)
      }
      return file.content
    },

    async stat(path: string): Promise<{
      isDirectory: () => boolean
      isSymbolicLink: () => boolean
      isFile: () => boolean
      size: number
      mode: number
      mtime: Date
      birthtime: Date
    }> {
      if (directories.has(path)) {
        return {
          isDirectory: () => true,
          isSymbolicLink: () => false,
          isFile: () => false,
          size: 0,
          mode: 0o755,
          mtime: new Date(),
          birthtime: new Date(),
        }
      }
      const file = files.get(path)
      if (!file) {
        const error = new Error(`ENOENT: no such file or directory, stat '${path}'`) as Error & {
          code: string
        }
        error.code = 'ENOENT'
        throw error
      }
      return {
        isDirectory: () => false,
        isSymbolicLink: () => false,
        isFile: () => true,
        size: file.content.length,
        mode: file.mode,
        mtime: new Date(),
        birthtime: new Date(),
      }
    },

    async exists(path: string): Promise<boolean> {
      return files.has(path) || directories.has(path)
    },

    async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
      if (options?.recursive) {
        // Create all parent directories
        const parts = path.split('/').filter(Boolean)
        let currentPath = ''
        for (const part of parts) {
          currentPath += '/' + part
          directories.add(currentPath)
        }
      } else {
        directories.add(path)
      }
    },

    async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      files.delete(path)
      directories.delete(path)
    },

    async rename(oldPath: string, newPath: string): Promise<void> {
      const file = files.get(oldPath)
      if (file) {
        files.delete(oldPath)
        files.set(newPath, file)
      }
    },

    async copyFile(src: string, dest: string): Promise<void> {
      const file = files.get(src)
      if (file) {
        files.set(dest, { ...file })
      }
    },

    async readdir(
      path: string,
      options?: { withFileTypes?: boolean; recursive?: boolean }
    ): Promise<string[] | { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean; path: string }[]> {
      return []
    },
  } as unknown as FSx & {
    _files: Map<string, { content: Uint8Array; mode: number }>
    _directories: Set<string>
    _permissionDenied: Set<string>
  }

  return mockFSx
}

describe('fs_write MCP tool', () => {
  describe('tool definition', () => {
    it('should be registered in fsTools', () => {
      const writeTool = fsTools.find((t) => t.name === 'fs_write')
      expect(writeTool).toBeDefined()
    })

    it('should have correct description', () => {
      const writeTool = fsTools.find((t) => t.name === 'fs_write')
      expect(writeTool?.description).toBe('Write content to a file (creates or overwrites)')
    })

    it('should require path and content parameters', () => {
      const writeTool = fsTools.find((t) => t.name === 'fs_write')
      expect(writeTool?.inputSchema.required).toContain('path')
      expect(writeTool?.inputSchema.required).toContain('content')
    })

    it('should define path as string type', () => {
      const writeTool = fsTools.find((t) => t.name === 'fs_write')
      expect(writeTool?.inputSchema.properties.path.type).toBe('string')
    })

    it('should define content as string type', () => {
      const writeTool = fsTools.find((t) => t.name === 'fs_write')
      expect(writeTool?.inputSchema.properties.content.type).toBe('string')
    })

    it('should define encoding as optional string with enum values', () => {
      const writeTool = fsTools.find((t) => t.name === 'fs_write')
      expect(writeTool?.inputSchema.properties.encoding.type).toBe('string')
      expect(writeTool?.inputSchema.properties.encoding.enum).toContain('utf-8')
      expect(writeTool?.inputSchema.properties.encoding.enum).toContain('base64')
    })
  })

  describe('write new file', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should create a new file with content', async () => {
      const result = await invokeTool('fs_write', { path: '/test/newfile.txt', content: 'Hello, World!' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Successfully wrote to /test/newfile.txt',
      })

      // Verify file was created
      expect(mockFs._files.has('/test/newfile.txt')).toBe(true)
      const fileContent = mockFs._files.get('/test/newfile.txt')
      expect(new TextDecoder().decode(fileContent?.content)).toBe('Hello, World!')
    })

    it('should write multiline content', async () => {
      const content = 'Line 1\nLine 2\nLine 3'
      const result = await invokeTool('fs_write', { path: '/test/multiline.txt', content }, mockFs)

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get('/test/multiline.txt')
      expect(new TextDecoder().decode(fileContent?.content)).toBe(content)
    })

    it('should write unicode content', async () => {
      const content = 'Hello, World! Emoji: test Special chars: e'
      const result = await invokeTool('fs_write', { path: '/test/unicode.txt', content }, mockFs)

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get('/test/unicode.txt')
      expect(new TextDecoder().decode(fileContent?.content)).toBe(content)
    })

    it('should write file at root directory', async () => {
      const result = await invokeTool('fs_write', { path: '/rootfile.txt', content: 'Root content' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has('/rootfile.txt')).toBe(true)
    })

    it('should write file with special characters in name', async () => {
      const path = '/test/file-with_special.chars.txt'
      const result = await invokeTool('fs_write', { path, content: 'content' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has(path)).toBe(true)
    })
  })

  describe('overwrite existing file', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should overwrite existing file with new content', async () => {
      // Create initial file
      mockFs._files.set('/test/existing.txt', {
        content: new TextEncoder().encode('Original content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_write', { path: '/test/existing.txt', content: 'New content' }, mockFs)

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get('/test/existing.txt')
      expect(new TextDecoder().decode(fileContent?.content)).toBe('New content')
    })

    it('should replace larger file with smaller content', async () => {
      const largeContent = 'A'.repeat(10000)
      mockFs._files.set('/test/large.txt', {
        content: new TextEncoder().encode(largeContent),
        mode: 0o666,
      })

      const result = await invokeTool('fs_write', { path: '/test/large.txt', content: 'Small' }, mockFs)

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get('/test/large.txt')
      expect(fileContent?.content.length).toBe(5)
      expect(new TextDecoder().decode(fileContent?.content)).toBe('Small')
    })

    it('should replace smaller file with larger content', async () => {
      mockFs._files.set('/test/small.txt', {
        content: new TextEncoder().encode('Small'),
        mode: 0o666,
      })

      const largeContent = 'A'.repeat(10000)
      const result = await invokeTool('fs_write', { path: '/test/small.txt', content: largeContent }, mockFs)

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get('/test/small.txt')
      expect(fileContent?.content.length).toBe(10000)
    })

    it('should completely replace file content (not append)', async () => {
      mockFs._files.set('/test/replace.txt', {
        content: new TextEncoder().encode('Original'),
        mode: 0o666,
      })

      await invokeTool('fs_write', { path: '/test/replace.txt', content: 'Replaced' }, mockFs)

      const fileContent = mockFs._files.get('/test/replace.txt')
      const decoded = new TextDecoder().decode(fileContent?.content)
      expect(decoded).toBe('Replaced')
      expect(decoded).not.toContain('Original')
    })
  })

  describe('create parent directories if needed', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should fail when parent directory does not exist', async () => {
      const result = await invokeTool(
        'fs_write',
        { path: '/nonexistent/parent/file.txt', content: 'content' },
        mockFs
      )

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText).toContain('Error')
    })

    it('should fail for deeply nested nonexistent path', async () => {
      const result = await invokeTool(
        'fs_write',
        { path: '/a/b/c/d/e/file.txt', content: 'content' },
        mockFs
      )

      expect(result.isError).toBe(true)
    })

    it('should include ENOENT error indicator in message', async () => {
      const result = await invokeTool(
        'fs_write',
        { path: '/missing/dir/file.txt', content: 'content' },
        mockFs
      )

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText.toLowerCase()).toMatch(/no such file|enoent|directory/)
    })
  })

  describe('handle permission denied error', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should return error when permission denied on new file', async () => {
      const path = '/test/nopermission.txt'
      mockFs._permissionDenied.add(path)

      const result = await invokeTool('fs_write', { path, content: 'content' }, mockFs)

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText).toContain('Error')
    })

    it('should return error when permission denied on existing file', async () => {
      const path = '/test/readonly.txt'
      mockFs._files.set(path, {
        content: new TextEncoder().encode('existing'),
        mode: 0o444,
      })
      mockFs._permissionDenied.add(path)

      const result = await invokeTool('fs_write', { path, content: 'new content' }, mockFs)

      expect(result.isError).toBe(true)
    })

    it('should include permission denied indicator in error message', async () => {
      const path = '/test/denied.txt'
      mockFs._permissionDenied.add(path)

      const result = await invokeTool('fs_write', { path, content: 'content' }, mockFs)

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText.toLowerCase()).toMatch(/permission|eacces|denied/)
    })

    it('should not modify file when permission denied', async () => {
      const path = '/test/protected.txt'
      const originalContent = 'Original protected content'
      mockFs._files.set(path, {
        content: new TextEncoder().encode(originalContent),
        mode: 0o666,
      })
      mockFs._permissionDenied.add(path)

      await invokeTool('fs_write', { path, content: 'New content' }, mockFs)

      // File should remain unchanged
      const fileContent = mockFs._files.get(path)
      expect(new TextDecoder().decode(fileContent?.content)).toBe(originalContent)
    })
  })

  describe('write with different encodings', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should write with utf-8 encoding by default', async () => {
      const content = 'Hello, World!'
      const result = await invokeTool('fs_write', { path: '/test/utf8.txt', content }, mockFs)

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get('/test/utf8.txt')
      expect(new TextDecoder().decode(fileContent?.content)).toBe(content)
    })

    it('should write with explicit utf-8 encoding', async () => {
      const content = 'Hello, UTF-8!'
      const result = await invokeTool(
        'fs_write',
        { path: '/test/explicit-utf8.txt', content, encoding: 'utf-8' },
        mockFs
      )

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get('/test/explicit-utf8.txt')
      expect(new TextDecoder().decode(fileContent?.content)).toBe(content)
    })

    it('should write base64 encoded content and decode it', async () => {
      // "Hello" in base64 is "SGVsbG8="
      const base64Content = 'SGVsbG8='
      const result = await invokeTool(
        'fs_write',
        { path: '/test/base64.txt', content: base64Content, encoding: 'base64' },
        mockFs
      )

      expect(result.isError).toBeFalsy()

      // The file should contain the DECODED content "Hello", not the base64 string
      const fileContent = mockFs._files.get('/test/base64.txt')
      expect(fileContent).toBeDefined()
      // This test verifies the MCP tool decodes base64 before writing
      expect(new TextDecoder().decode(fileContent?.content)).toBe('Hello')
    })

    it('should write binary data via base64 encoding and decode to bytes', async () => {
      // Binary data [0x00, 0x01, 0xFF] encoded as base64: "AAH/"
      const base64Content = 'AAH/'
      const result = await invokeTool(
        'fs_write',
        { path: '/test/binary.bin', content: base64Content, encoding: 'base64' },
        mockFs
      )

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has('/test/binary.bin')).toBe(true)

      // The file should contain the decoded binary bytes [0x00, 0x01, 0xFF]
      const fileContent = mockFs._files.get('/test/binary.bin')
      expect(fileContent?.content.length).toBe(3)
      expect(fileContent?.content[0]).toBe(0x00)
      expect(fileContent?.content[1]).toBe(0x01)
      expect(fileContent?.content[2]).toBe(0xff)
    })

    it('should handle unicode content with utf-8 encoding', async () => {
      const unicodeContent = 'Japanese: Nihongo Chinese: Zhongwen Korean: Hangugeo'
      const result = await invokeTool(
        'fs_write',
        { path: '/test/unicode-encoded.txt', content: unicodeContent, encoding: 'utf-8' },
        mockFs
      )

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get('/test/unicode-encoded.txt')
      expect(new TextDecoder().decode(fileContent?.content)).toBe(unicodeContent)
    })

    it('should decode base64 PNG image header correctly', async () => {
      // PNG file header in base64 (first 8 bytes of a PNG file)
      // 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A = "\x89PNG\r\n\x1a\n"
      const pngHeaderBase64 = 'iVBORw0KGgo='
      const result = await invokeTool(
        'fs_write',
        { path: '/test/image.png', content: pngHeaderBase64, encoding: 'base64' },
        mockFs
      )

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get('/test/image.png')
      expect(fileContent).toBeDefined()
      // Verify PNG magic bytes (first 4 bytes: 0x89, P, N, G)
      expect(fileContent?.content[0]).toBe(0x89)
      expect(fileContent?.content[1]).toBe(0x50) // 'P'
      expect(fileContent?.content[2]).toBe(0x4e) // 'N'
      expect(fileContent?.content[3]).toBe(0x47) // 'G'
    })

    it('should write large base64 encoded content correctly', async () => {
      // Create a base64 string of 1000 'A' characters
      const originalBytes = new Uint8Array(1000).fill(65) // 1000 'A's
      let binary = ''
      for (const byte of originalBytes) {
        binary += String.fromCharCode(byte)
      }
      const base64Content = btoa(binary)

      const result = await invokeTool(
        'fs_write',
        { path: '/test/large-base64.bin', content: base64Content, encoding: 'base64' },
        mockFs
      )

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get('/test/large-base64.bin')
      expect(fileContent).toBeDefined()
      // After decoding, should have 1000 bytes, not the longer base64 string
      expect(fileContent?.content.length).toBe(1000)
      // All bytes should be 65 ('A')
      expect(fileContent?.content[0]).toBe(65)
      expect(fileContent?.content[999]).toBe(65)
    })
  })

  describe('write empty content', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should create empty file with empty string content', async () => {
      const result = await invokeTool('fs_write', { path: '/test/empty.txt', content: '' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has('/test/empty.txt')).toBe(true)

      const fileContent = mockFs._files.get('/test/empty.txt')
      expect(fileContent?.content.length).toBe(0)
    })

    it('should overwrite existing file with empty content', async () => {
      mockFs._files.set('/test/notempty.txt', {
        content: new TextEncoder().encode('Some content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_write', { path: '/test/notempty.txt', content: '' }, mockFs)

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get('/test/notempty.txt')
      expect(fileContent?.content.length).toBe(0)
    })

    it('should return success message for empty content write', async () => {
      const result = await invokeTool('fs_write', { path: '/test/empty-success.txt', content: '' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Successfully wrote to /test/empty-success.txt',
      })
    })
  })

  describe('error handling - directory path', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should return error when trying to write to a directory', async () => {
      const result = await invokeTool('fs_write', { path: '/test', content: 'content' }, mockFs)

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText).toContain('Error')
    })

    it('should return EISDIR error for directory path', async () => {
      const result = await invokeTool('fs_write', { path: '/home', content: 'content' }, mockFs)

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText.toLowerCase()).toMatch(/directory|eisdir/)
    })

    it('should return error for root directory', async () => {
      const result = await invokeTool('fs_write', { path: '/', content: 'content' }, mockFs)

      expect(result.isError).toBe(true)
    })
  })

  describe('MCP result format', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should return properly formatted success result', async () => {
      const result = await invokeTool('fs_write', { path: '/test/format.txt', content: 'content' }, mockFs)

      expect(result).toHaveProperty('content')
      expect(Array.isArray(result.content)).toBe(true)
      expect(result.content.length).toBeGreaterThan(0)
      expect(result.content[0]).toHaveProperty('type')
      expect(result.content[0]).toHaveProperty('text')
    })

    it('should return properly formatted error result', async () => {
      mockFs._permissionDenied.add('/test/error-format.txt')

      const result = await invokeTool('fs_write', { path: '/test/error-format.txt', content: 'content' }, mockFs)

      expect(result).toHaveProperty('content')
      expect(result).toHaveProperty('isError')
      expect(result.isError).toBe(true)
      expect(Array.isArray(result.content)).toBe(true)
      expect(result.content[0]).toHaveProperty('type', 'text')
    })

    it('should include file path in success message', async () => {
      const path = '/test/path-in-message.txt'
      const result = await invokeTool('fs_write', { path, content: 'content' }, mockFs)

      expect(result.isError).toBeFalsy()
      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain(path)
    })

    it('should have text type in content array', async () => {
      const result = await invokeTool('fs_write', { path: '/test/type.txt', content: 'content' }, mockFs)

      expect(result.content[0].type).toBe('text')
    })
  })

  describe('edge cases', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should handle very long file paths', async () => {
      // Create parent directory for the long path
      const longDir = '/test/' + 'a'.repeat(100)
      mockFs._directories.add(longDir)
      const longPath = longDir + '/file.txt'

      const result = await invokeTool('fs_write', { path: longPath, content: 'content' }, mockFs)

      // Should either succeed or fail gracefully
      expect(result.content).toBeDefined()
      expect(result.content[0].type).toBe('text')
    })

    it('should handle special characters in content', async () => {
      const path = '/test/special.txt'
      const specialContent = 'Tab:\tNewline:\nCarriage return:\rBackslash:\\'

      const result = await invokeTool('fs_write', { path, content: specialContent }, mockFs)

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get(path)
      expect(new TextDecoder().decode(fileContent?.content)).toBe(specialContent)
    })

    it('should handle large content write', async () => {
      const path = '/test/large.txt'
      const largeContent = 'A'.repeat(1024 * 1024) // 1MB of 'A's

      const result = await invokeTool('fs_write', { path, content: largeContent }, mockFs)

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get(path)
      expect(fileContent?.content.length).toBe(1024 * 1024)
    })

    it('should handle JSON content', async () => {
      const path = '/test/data.json'
      const jsonContent = JSON.stringify({ key: 'value', nested: { a: 1, b: 2 } }, null, 2)

      const result = await invokeTool('fs_write', { path, content: jsonContent }, mockFs)

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get(path)
      const decoded = new TextDecoder().decode(fileContent?.content)
      expect(JSON.parse(decoded)).toEqual({ key: 'value', nested: { a: 1, b: 2 } })
    })

    it('should handle null bytes in string content', async () => {
      const path = '/test/nullbytes.txt'
      const content = 'before\x00after'

      const result = await invokeTool('fs_write', { path, content }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has(path)).toBe(true)
    })

    it('should handle paths with double slashes', async () => {
      const result = await invokeTool('fs_write', { path: '/test//file.txt', content: 'content' }, mockFs)

      // Should either normalize path and succeed, or fail gracefully
      expect(result.content).toBeDefined()
    })

    it('should handle paths with dot segments', async () => {
      // Path like /test/./file.txt should be normalized
      const result = await invokeTool('fs_write', { path: '/test/./file.txt', content: 'content' }, mockFs)

      expect(result.content).toBeDefined()
    })
  })

  describe('concurrent operations', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should handle multiple writes to different files', async () => {
      const results = await Promise.all([
        invokeTool('fs_write', { path: '/test/file1.txt', content: 'content1' }, mockFs),
        invokeTool('fs_write', { path: '/test/file2.txt', content: 'content2' }, mockFs),
        invokeTool('fs_write', { path: '/test/file3.txt', content: 'content3' }, mockFs),
      ])

      for (const result of results) {
        expect(result.isError).toBeFalsy()
      }

      expect(mockFs._files.has('/test/file1.txt')).toBe(true)
      expect(mockFs._files.has('/test/file2.txt')).toBe(true)
      expect(mockFs._files.has('/test/file3.txt')).toBe(true)
    })

    it('should handle sequential writes to same file', async () => {
      await invokeTool('fs_write', { path: '/test/same.txt', content: 'first' }, mockFs)
      await invokeTool('fs_write', { path: '/test/same.txt', content: 'second' }, mockFs)
      await invokeTool('fs_write', { path: '/test/same.txt', content: 'third' }, mockFs)

      const fileContent = mockFs._files.get('/test/same.txt')
      expect(new TextDecoder().decode(fileContent?.content)).toBe('third')
    })
  })
})
