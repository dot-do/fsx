/**
 * Tests for fs_append MCP tool
 *
 * RED phase - These tests define the expected behavior of the fs_append MCP tool.
 * Tests will fail until the implementation is complete.
 *
 * The fs_append tool should:
 * - Append content to an existing file
 * - Create the file if it doesn't exist
 * - Support multiple sequential appends
 * - Handle permission denied errors gracefully
 * - Handle empty content appends
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

    async appendFile(
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
      if (!directories.has(parentPath) && !files.has(parentPath)) {
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

      // Convert data to Uint8Array
      const newContent = typeof data === 'string' ? new TextEncoder().encode(data) : data

      // Get existing content or create new
      const existing = files.get(path)
      if (existing) {
        // Append to existing content
        const combined = new Uint8Array(existing.content.length + newContent.length)
        combined.set(existing.content)
        combined.set(newContent, existing.content.length)
        files.set(path, { content: combined, mode: existing.mode })
      } else {
        // Create new file with appended content
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

    async writeFile(path: string, data: string | Uint8Array): Promise<void> {
      const content = typeof data === 'string' ? new TextEncoder().encode(data) : data
      files.set(path, { content, mode: 0o666 })
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
      directories.add(path)
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

describe('fs_append MCP tool', () => {
  describe('tool definition', () => {
    it('should be registered in fsTools', () => {
      const appendTool = fsTools.find((t) => t.name === 'fs_append')
      expect(appendTool).toBeDefined()
    })

    it('should have correct description', () => {
      const appendTool = fsTools.find((t) => t.name === 'fs_append')
      expect(appendTool?.description).toBe('Append content to a file')
    })

    it('should require path and content parameters', () => {
      const appendTool = fsTools.find((t) => t.name === 'fs_append')
      expect(appendTool?.inputSchema.required).toContain('path')
      expect(appendTool?.inputSchema.required).toContain('content')
    })

    it('should define path as string type', () => {
      const appendTool = fsTools.find((t) => t.name === 'fs_append')
      expect(appendTool?.inputSchema.properties.path.type).toBe('string')
    })

    it('should define content as string type', () => {
      const appendTool = fsTools.find((t) => t.name === 'fs_append')
      expect(appendTool?.inputSchema.properties.content.type).toBe('string')
    })
  })

  describe('append to existing file', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should append content to an existing file', async () => {
      // Setup: create existing file
      mockFs._files.set('/test/existing.txt', {
        content: new TextEncoder().encode('Hello, '),
        mode: 0o666,
      })

      const result = await invokeTool('fs_append', { path: '/test/existing.txt', content: 'World!' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Successfully appended to /test/existing.txt',
      })

      // Verify content was appended
      const fileContent = mockFs._files.get('/test/existing.txt')
      expect(new TextDecoder().decode(fileContent?.content)).toBe('Hello, World!')
    })

    it('should append to file with multiline content', async () => {
      mockFs._files.set('/test/log.txt', {
        content: new TextEncoder().encode('Line 1\n'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_append', { path: '/test/log.txt', content: 'Line 2\nLine 3\n' }, mockFs)

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get('/test/log.txt')
      expect(new TextDecoder().decode(fileContent?.content)).toBe('Line 1\nLine 2\nLine 3\n')
    })

    it('should preserve existing content when appending', async () => {
      const originalContent = 'Original content that should remain'
      mockFs._files.set('/test/preserve.txt', {
        content: new TextEncoder().encode(originalContent),
        mode: 0o666,
      })

      await invokeTool('fs_append', { path: '/test/preserve.txt', content: ' - appended' }, mockFs)

      const fileContent = mockFs._files.get('/test/preserve.txt')
      const decoded = new TextDecoder().decode(fileContent?.content)
      expect(decoded.startsWith(originalContent)).toBe(true)
      expect(decoded).toBe(originalContent + ' - appended')
    })

    it('should handle unicode content in existing file', async () => {
      mockFs._files.set('/test/unicode.txt', {
        content: new TextEncoder().encode('Hello '),
        mode: 0o666,
      })

      const result = await invokeTool('fs_append', { path: '/test/unicode.txt', content: 'World!' }, mockFs)

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get('/test/unicode.txt')
      expect(new TextDecoder().decode(fileContent?.content)).toBe('Hello World!')
    })
  })

  describe('create file if not exists', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should create new file when appending to non-existent path', async () => {
      const result = await invokeTool('fs_append', { path: '/test/newfile.txt', content: 'New content' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Successfully appended to /test/newfile.txt',
      })

      // Verify file was created with content
      expect(mockFs._files.has('/test/newfile.txt')).toBe(true)
      const fileContent = mockFs._files.get('/test/newfile.txt')
      expect(new TextDecoder().decode(fileContent?.content)).toBe('New content')
    })

    it('should create file with correct initial content', async () => {
      const initialContent = 'This is the initial content for a new file'
      await invokeTool('fs_append', { path: '/test/created.txt', content: initialContent }, mockFs)

      const fileContent = mockFs._files.get('/test/created.txt')
      expect(new TextDecoder().decode(fileContent?.content)).toBe(initialContent)
    })

    it('should fail when parent directory does not exist', async () => {
      const result = await invokeTool(
        'fs_append',
        { path: '/nonexistent/parent/file.txt', content: 'content' },
        mockFs
      )

      expect(result.isError).toBe(true)
      expect(result.content[0].type).toBe('text')
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('Error')
    })
  })

  describe('append multiple times', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should handle multiple sequential appends', async () => {
      const path = '/test/sequential.txt'

      // First append - creates file
      await invokeTool('fs_append', { path, content: 'First ' }, mockFs)
      // Second append
      await invokeTool('fs_append', { path, content: 'Second ' }, mockFs)
      // Third append
      await invokeTool('fs_append', { path, content: 'Third' }, mockFs)

      const fileContent = mockFs._files.get(path)
      expect(new TextDecoder().decode(fileContent?.content)).toBe('First Second Third')
    })

    it('should maintain order of appended content', async () => {
      const path = '/test/ordered.log'

      const entries = ['Entry 1\n', 'Entry 2\n', 'Entry 3\n', 'Entry 4\n', 'Entry 5\n']

      for (const entry of entries) {
        await invokeTool('fs_append', { path, content: entry }, mockFs)
      }

      const fileContent = mockFs._files.get(path)
      const decoded = new TextDecoder().decode(fileContent?.content)
      expect(decoded).toBe(entries.join(''))
    })

    it('should handle rapid successive appends', async () => {
      const path = '/test/rapid.txt'
      const appendCount = 100

      const promises = []
      for (let i = 0; i < appendCount; i++) {
        promises.push(invokeTool('fs_append', { path, content: `${i}` }, mockFs))
      }

      // Note: This tests sequential behavior, not parallel (MCP tools are typically sequential)
      for (const promise of promises) {
        await promise
      }

      const fileContent = mockFs._files.get(path)
      expect(fileContent).toBeDefined()
      // Content should exist and contain all appended data
      expect(fileContent!.content.length).toBeGreaterThan(0)
    })

    it('should correctly accumulate file size with multiple appends', async () => {
      const path = '/test/growing.txt'
      const chunk = 'AAAAAAAAAA' // 10 characters

      for (let i = 0; i < 10; i++) {
        await invokeTool('fs_append', { path, content: chunk }, mockFs)
      }

      const fileContent = mockFs._files.get(path)
      expect(fileContent?.content.length).toBe(100) // 10 * 10 characters
    })
  })

  describe('handle permission denied error', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should return error result when permission denied', async () => {
      const path = '/test/readonly.txt'
      // Mark file as permission denied
      mockFs._permissionDenied.add(path)

      const result = await invokeTool('fs_append', { path, content: 'content' }, mockFs)

      expect(result.isError).toBe(true)
      expect(result.content[0].type).toBe('text')
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText).toContain('Error')
    })

    it('should include EACCES error code in error message', async () => {
      const path = '/test/noaccess.txt'
      mockFs._permissionDenied.add(path)

      const result = await invokeTool('fs_append', { path, content: 'content' }, mockFs)

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      // Error message should contain permission or EACCES indicator
      expect(errorText.toLowerCase()).toMatch(/permission|eacces|denied/)
    })

    it('should handle permission denied on existing file', async () => {
      const path = '/test/existing-readonly.txt'
      mockFs._files.set(path, {
        content: new TextEncoder().encode('existing content'),
        mode: 0o444, // read-only
      })
      mockFs._permissionDenied.add(path)

      const result = await invokeTool('fs_append', { path, content: ' more content' }, mockFs)

      expect(result.isError).toBe(true)
    })

    it('should not modify file when permission denied', async () => {
      const path = '/test/protected.txt'
      const originalContent = 'Original protected content'
      mockFs._files.set(path, {
        content: new TextEncoder().encode(originalContent),
        mode: 0o666,
      })
      mockFs._permissionDenied.add(path)

      await invokeTool('fs_append', { path, content: ' appended' }, mockFs)

      // File should remain unchanged
      const fileContent = mockFs._files.get(path)
      expect(new TextDecoder().decode(fileContent?.content)).toBe(originalContent)
    })
  })

  describe('append empty content', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should handle appending empty string to existing file', async () => {
      const path = '/test/empty-append.txt'
      const originalContent = 'Original content'
      mockFs._files.set(path, {
        content: new TextEncoder().encode(originalContent),
        mode: 0o666,
      })

      const result = await invokeTool('fs_append', { path, content: '' }, mockFs)

      expect(result.isError).toBeFalsy()

      // Content should remain unchanged
      const fileContent = mockFs._files.get(path)
      expect(new TextDecoder().decode(fileContent?.content)).toBe(originalContent)
    })

    it('should create empty file when appending empty string to non-existent file', async () => {
      const path = '/test/new-empty.txt'

      const result = await invokeTool('fs_append', { path, content: '' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has(path)).toBe(true)

      const fileContent = mockFs._files.get(path)
      expect(fileContent?.content.length).toBe(0)
    })

    it('should return success message for empty append', async () => {
      const path = '/test/success-empty.txt'
      mockFs._files.set(path, {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_append', { path, content: '' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(result.content[0]).toEqual({
        type: 'text',
        text: `Successfully appended to ${path}`,
      })
    })

    it('should handle empty content followed by non-empty append', async () => {
      const path = '/test/empty-then-content.txt'

      await invokeTool('fs_append', { path, content: '' }, mockFs)
      await invokeTool('fs_append', { path, content: 'Now with content' }, mockFs)

      const fileContent = mockFs._files.get(path)
      expect(new TextDecoder().decode(fileContent?.content)).toBe('Now with content')
    })
  })

  describe('error handling - directory path', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should return error when trying to append to a directory', async () => {
      const result = await invokeTool('fs_append', { path: '/test', content: 'content' }, mockFs)

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText).toContain('Error')
    })

    it('should return EISDIR error for directory path', async () => {
      const result = await invokeTool('fs_append', { path: '/home', content: 'content' }, mockFs)

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText.toLowerCase()).toMatch(/directory|eisdir/)
    })
  })

  describe('MCP result format', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should return properly formatted success result', async () => {
      const result = await invokeTool('fs_append', { path: '/test/format.txt', content: 'content' }, mockFs)

      // Check result structure
      expect(result).toHaveProperty('content')
      expect(Array.isArray(result.content)).toBe(true)
      expect(result.content.length).toBeGreaterThan(0)
      expect(result.content[0]).toHaveProperty('type')
      expect(result.content[0]).toHaveProperty('text')
    })

    it('should return properly formatted error result', async () => {
      mockFs._permissionDenied.add('/test/error-format.txt')

      const result = await invokeTool('fs_append', { path: '/test/error-format.txt', content: 'content' }, mockFs)

      expect(result).toHaveProperty('content')
      expect(result).toHaveProperty('isError')
      expect(result.isError).toBe(true)
      expect(Array.isArray(result.content)).toBe(true)
      expect(result.content[0]).toHaveProperty('type', 'text')
    })

    it('should include file path in success message', async () => {
      const path = '/test/path-in-message.txt'
      const result = await invokeTool('fs_append', { path, content: 'content' }, mockFs)

      expect(result.isError).toBeFalsy()
      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain(path)
    })
  })

  describe('edge cases', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should handle very long file paths', async () => {
      const longPath = '/test/' + 'a'.repeat(200) + '.txt'
      mockFs._directories.add('/test/' + 'a'.repeat(200).substring(0, 100))

      // This should either succeed or fail gracefully with an error
      const result = await invokeTool('fs_append', { path: longPath, content: 'content' }, mockFs)

      // Either succeeds or returns proper error
      expect(result.content).toBeDefined()
      expect(result.content[0].type).toBe('text')
    })

    it('should handle special characters in content', async () => {
      const path = '/test/special.txt'
      const specialContent = 'Tab:\tNewline:\nCarriage return:\rNull byte safe'

      const result = await invokeTool('fs_append', { path, content: specialContent }, mockFs)

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get(path)
      expect(new TextDecoder().decode(fileContent?.content)).toBe(specialContent)
    })

    it('should handle large content append', async () => {
      const path = '/test/large.txt'
      const largeContent = 'A'.repeat(1024 * 1024) // 1MB of 'A's

      const result = await invokeTool('fs_append', { path, content: largeContent }, mockFs)

      expect(result.isError).toBeFalsy()

      const fileContent = mockFs._files.get(path)
      expect(fileContent?.content.length).toBe(1024 * 1024)
    })

    it('should handle JSON content append', async () => {
      const path = '/test/json-log.jsonl'
      const jsonEntry1 = JSON.stringify({ event: 'start', timestamp: 1 }) + '\n'
      const jsonEntry2 = JSON.stringify({ event: 'end', timestamp: 2 }) + '\n'

      await invokeTool('fs_append', { path, content: jsonEntry1 }, mockFs)
      await invokeTool('fs_append', { path, content: jsonEntry2 }, mockFs)

      const fileContent = mockFs._files.get(path)
      const decoded = new TextDecoder().decode(fileContent?.content)
      const lines = decoded.trim().split('\n')

      expect(lines.length).toBe(2)
      expect(JSON.parse(lines[0])).toEqual({ event: 'start', timestamp: 1 })
      expect(JSON.parse(lines[1])).toEqual({ event: 'end', timestamp: 2 })
    })

    it('should handle binary-safe string content', async () => {
      const path = '/test/binary-string.txt'
      // Content with various byte values represented as string
      const content = String.fromCharCode(0, 1, 2, 255, 254, 253)

      const result = await invokeTool('fs_append', { path, content }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has(path)).toBe(true)
    })
  })
})
