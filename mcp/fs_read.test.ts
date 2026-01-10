import { describe, it, expect, beforeEach } from 'vitest'
import { invokeTool, fsTools, type McpToolResult } from './index'
import { FSx } from '../core/fsx'
import { InMemoryStorage, MockDurableObjectStub } from '../../tests/test-utils'

/**
 * RED Phase Tests for fs_read MCP Tool
 *
 * These are integration tests that verify the MCP fs_read tool interface
 * for AI-assisted file operations. Tests use an in-memory filesystem backend.
 *
 * The fs_read tool should:
 * - Read file contents and return them in MCP response format
 * - Support UTF-8 (default) and base64 encodings
 * - Return proper error responses for file not found, permission denied, etc.
 * - Handle edge cases like empty files and large files
 *
 * MCP Tool Response Format:
 * - Success: { content: [{ type: 'text', text: '...' }] }
 * - Error: { content: [{ type: 'text', text: 'Error: ...' }], isError: true }
 */

describe('fs_read MCP Tool', () => {
  let storage: InMemoryStorage
  let stub: MockDurableObjectStub
  let fs: FSx

  beforeEach(() => {
    storage = new InMemoryStorage()
    stub = new MockDurableObjectStub(storage)
    fs = new FSx(stub as unknown as DurableObjectStub)

    // Setup test fixtures
    storage.addDirectory('/test')
    storage.addFile('/test/hello.txt', 'Hello, World!')
    storage.addFile('/test/empty.txt', '')
    storage.addFile('/test/unicode.txt', 'Hello, \u4e16\u754c! \u{1F600}')
    storage.addFile('/test/binary.bin', new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]))
    storage.addFile('/test/multiline.txt', 'Line 1\nLine 2\r\nLine 3\tTabbed')
  })

  describe('tool definition', () => {
    it('should be registered in fsTools with correct schema', () => {
      const fsReadTool = fsTools.find((t) => t.name === 'fs_read')

      expect(fsReadTool).toBeDefined()
      expect(fsReadTool!.name).toBe('fs_read')
      expect(fsReadTool!.description).toBe('Read the contents of a file')
      expect(fsReadTool!.inputSchema.type).toBe('object')
      expect(fsReadTool!.inputSchema.properties.path).toBeDefined()
      expect(fsReadTool!.inputSchema.properties.encoding).toBeDefined()
      expect(fsReadTool!.inputSchema.required).toContain('path')
    })

    it('should define encoding as optional with enum values', () => {
      const fsReadTool = fsTools.find((t) => t.name === 'fs_read')

      expect(fsReadTool!.inputSchema.properties.encoding.enum).toEqual(['utf-8', 'base64'])
      expect(fsReadTool!.inputSchema.required).not.toContain('encoding')
    })
  })

  describe('read file with default UTF-8 encoding', () => {
    it('should read file content as UTF-8 by default', async () => {
      const result = await invokeTool('fs_read', { path: '/test/hello.txt' }, fs)

      expect(result.isError).toBeUndefined()
      expect(result.content).toHaveLength(1)
      expect(result.content[0]).toEqual({ type: 'text', text: 'Hello, World!' })
    })

    it('should read file with unicode content correctly', async () => {
      const unicodeContent = 'Hello, \u4e16\u754c! \u{1F600}'

      const result = await invokeTool('fs_read', { path: '/test/unicode.txt' }, fs)

      expect(result.isError).toBeUndefined()
      expect(result.content[0]).toEqual({ type: 'text', text: unicodeContent })
    })

    it('should read file with newlines and special characters', async () => {
      const multilineContent = 'Line 1\nLine 2\r\nLine 3\tTabbed'

      const result = await invokeTool('fs_read', { path: '/test/multiline.txt' }, fs)

      expect(result.isError).toBeUndefined()
      expect(result.content[0]).toEqual({ type: 'text', text: multilineContent })
    })
  })

  describe('read file with explicit encoding', () => {
    it('should read file with explicit utf-8 encoding', async () => {
      const result = await invokeTool(
        'fs_read',
        { path: '/test/hello.txt', encoding: 'utf-8' },
        fs
      )

      expect(result.isError).toBeUndefined()
      expect(result.content[0]).toEqual({ type: 'text', text: 'Hello, World!' })
    })

    it('should read file with base64 encoding', async () => {
      // Base64 of "Hello, World!" is "SGVsbG8sIFdvcmxkIQ=="
      const result = await invokeTool(
        'fs_read',
        { path: '/test/hello.txt', encoding: 'base64' },
        fs
      )

      expect(result.isError).toBeUndefined()
      expect(result.content[0]).toEqual({ type: 'text', text: 'SGVsbG8sIFdvcmxkIQ==' })
    })

    it('should read binary file with base64 encoding', async () => {
      // Binary content [0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd] as base64
      const expectedBase64 = btoa(String.fromCharCode(0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd))

      const result = await invokeTool(
        'fs_read',
        { path: '/test/binary.bin', encoding: 'base64' },
        fs
      )

      expect(result.isError).toBeUndefined()
      expect(result.content[0]).toEqual({ type: 'text', text: expectedBase64 })
    })
  })

  describe('handle file not found error', () => {
    it('should return error response when file does not exist', async () => {
      const result = await invokeTool('fs_read', { path: '/nonexistent/file.txt' }, fs)

      expect(result.isError).toBe(true)
      expect(result.content).toHaveLength(1)
      expect(result.content[0].type).toBe('text')
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('Error')
    })

    it('should include descriptive error message', async () => {
      const result = await invokeTool('fs_read', { path: '/missing/path.txt' }, fs)

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText).toContain('Error')
      // The error message should be informative
      expect(errorText.length).toBeGreaterThan(5)
    })

    it('should handle deeply nested nonexistent paths', async () => {
      const result = await invokeTool(
        'fs_read',
        { path: '/a/b/c/d/e/f/g/file.txt' },
        fs
      )

      expect(result.isError).toBe(true)
    })
  })

  describe('handle permission denied error', () => {
    it('should return error when reading directory instead of file', async () => {
      const result = await invokeTool('fs_read', { path: '/test' }, fs)

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText).toContain('Error')
    })

    // Note: EACCES (permission denied) and EPERM errors are harder to test
    // in the in-memory storage. These would require a mock that simulates
    // permission-based errors. The current implementation handles these
    // errors correctly in the catch block.
  })

  describe('read empty file', () => {
    it('should read empty file and return empty string', async () => {
      const result = await invokeTool('fs_read', { path: '/test/empty.txt' }, fs)

      expect(result.isError).toBeUndefined()
      expect(result.content[0]).toEqual({ type: 'text', text: '' })
    })

    it('should read empty file with base64 encoding', async () => {
      const result = await invokeTool(
        'fs_read',
        { path: '/test/empty.txt', encoding: 'base64' },
        fs
      )

      expect(result.isError).toBeUndefined()
      expect(result.content[0]).toEqual({ type: 'text', text: '' })
    })

    it('should not return [binary data] marker for empty file', async () => {
      const result = await invokeTool('fs_read', { path: '/test/empty.txt' }, fs)

      expect(result.isError).toBeUndefined()
      expect((result.content[0] as { type: 'text'; text: string }).text).not.toContain('[binary data]')
    })
  })

  describe('read large file', () => {
    beforeEach(() => {
      // Create a 100KB text file
      const largeContent = 'The quick brown fox jumps over the lazy dog. '.repeat(2500)
      storage.addFile('/test/large.txt', largeContent)

      // Create a 1MB binary file
      const largeBinary = new Uint8Array(1024 * 1024)
      for (let i = 0; i < largeBinary.length; i++) {
        largeBinary[i] = i % 256
      }
      storage.addFile('/test/large.bin', largeBinary)
    })

    it('should read large text file (100KB)', async () => {
      const result = await invokeTool('fs_read', { path: '/test/large.txt' }, fs)

      expect(result.isError).toBeUndefined()
      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text.length).toBeGreaterThan(100000)
      expect(text.startsWith('The quick brown fox')).toBe(true)
    })

    it('should read large file with base64 encoding (1MB)', async () => {
      const result = await invokeTool(
        'fs_read',
        { path: '/test/large.bin', encoding: 'base64' },
        fs
      )

      expect(result.isError).toBeUndefined()
      const text = (result.content[0] as { type: 'text'; text: string }).text
      // Base64 increases size by ~33%
      expect(text.length).toBeGreaterThan(1000000)
    })

    it('should handle multi-megabyte files without timeout', async () => {
      // 5MB of content
      const veryLargeContent = 'X'.repeat(5 * 1024 * 1024)
      storage.addFile('/test/verylarge.txt', veryLargeContent)

      const startTime = Date.now()
      const result = await invokeTool('fs_read', { path: '/test/verylarge.txt' }, fs)
      const duration = Date.now() - startTime

      expect(result.isError).toBeUndefined()
      // Should complete in reasonable time (less than 5 seconds)
      expect(duration).toBeLessThan(5000)
    })
  })

  describe('edge cases and error handling', () => {
    it('should handle unknown tool name', async () => {
      const result = await invokeTool('fs_read_nonexistent', { path: '/test/file.txt' }, fs)

      expect(result.isError).toBe(true)
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('Unknown tool')
    })

    it('should handle binary data indicator for non-string content', async () => {
      // When fs.readFile returns something that's not a string (like Uint8Array),
      // the MCP tool should indicate it's binary data
      // This tests the case where readFile returns Uint8Array instead of string
      const result = await invokeTool('fs_read', { path: '/test/binary.bin' }, fs)

      // The implementation should either return the text content or [binary data]
      expect(result.isError).toBeUndefined()
      // Binary file without base64 encoding - should be readable as text or marked as binary
      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(typeof text).toBe('string')
    })

    it('should properly format error messages', async () => {
      // Trigger a file not found error
      const result = await invokeTool('fs_read', { path: '/nonexistent.txt' }, fs)

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      // Should have "Error:" prefix
      expect(errorText).toMatch(/^Error:/)
    })
  })

  describe('MCP response format compliance', () => {
    it('should return content array with text type for successful reads', async () => {
      const result = await invokeTool('fs_read', { path: '/test/hello.txt' }, fs)

      expect(Array.isArray(result.content)).toBe(true)
      expect(result.content.length).toBeGreaterThan(0)
      expect(result.content[0]).toHaveProperty('type', 'text')
      expect(result.content[0]).toHaveProperty('text')
    })

    it('should set isError to true only on errors', async () => {
      const successResult = await invokeTool('fs_read', { path: '/test/hello.txt' }, fs)
      const errorResult = await invokeTool('fs_read', { path: '/nonexistent.txt' }, fs)

      expect(successResult.isError).toBeUndefined()
      expect(errorResult.isError).toBe(true)
    })

    it('should not set isError to false on success (should be undefined)', async () => {
      const result = await invokeTool('fs_read', { path: '/test/hello.txt' }, fs)

      // Per MCP spec, isError should be absent (undefined) on success, not false
      expect('isError' in result && result.isError === false).toBe(false)
      expect(result.isError).toBeUndefined()
    })
  })
})
