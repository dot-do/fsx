/**
 * Tests for fs_copy MCP tool
 *
 * RED phase - These tests define the expected behavior of the fs_copy MCP tool.
 * Tests will fail until the implementation is complete.
 *
 * The fs_copy tool should:
 * - Copy a file to a new location
 * - Copy a file to the same directory with different name
 * - Handle source not found error (ENOENT)
 * - Handle destination parent not found error (ENOENT)
 * - Handle permission denied error (EACCES)
 * - Preserve file content exactly
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
  const directories = new Set<string>(['/', '/test', '/home', '/home/user', '/empty-dir', '/dest', '/src'])
  const permissionDenied = new Set<string>()

  const getParentPath = (path: string): string => {
    const lastSlash = path.lastIndexOf('/')
    if (lastSlash <= 0) return '/'
    return path.substring(0, lastSlash)
  }

  // Helper to get all paths under a directory
  const getChildPaths = (dirPath: string): string[] => {
    const children: string[] = []
    const prefix = dirPath === '/' ? '/' : dirPath + '/'

    for (const [filePath] of files) {
      if (filePath.startsWith(prefix)) {
        children.push(filePath)
      }
    }

    for (const dirPathEntry of directories) {
      if (dirPathEntry !== dirPath && dirPathEntry.startsWith(prefix)) {
        children.push(dirPathEntry)
      }
    }

    return children
  }

  const mockFSx = {
    _files: files,
    _directories: directories,
    _permissionDenied: permissionDenied,

    async copyFile(src: string, dest: string): Promise<void> {
      // Check for permission denied on source
      if (permissionDenied.has(src)) {
        const error = new Error(`EACCES: permission denied, copyfile '${src}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'EACCES'
        error.syscall = 'copyfile'
        error.path = src
        throw error
      }

      // Check for permission denied on destination
      if (permissionDenied.has(dest)) {
        const error = new Error(`EACCES: permission denied, copyfile '${dest}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'EACCES'
        error.syscall = 'copyfile'
        error.path = dest
        throw error
      }

      const isFile = files.has(src)
      const isDir = directories.has(src)

      // Source doesn't exist
      if (!isFile && !isDir) {
        const error = new Error(`ENOENT: no such file or directory, copyfile '${src}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'ENOENT'
        error.syscall = 'copyfile'
        error.path = src
        throw error
      }

      // Source is a directory
      if (isDir) {
        const error = new Error(`EISDIR: illegal operation on a directory, copyfile '${src}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'EISDIR'
        error.syscall = 'copyfile'
        error.path = src
        throw error
      }

      // Check destination parent exists
      const destParent = getParentPath(dest)
      if (destParent !== '/' && !directories.has(destParent)) {
        const error = new Error(`ENOENT: no such file or directory, copyfile '${dest}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'ENOENT'
        error.syscall = 'copyfile'
        error.path = dest
        throw error
      }

      // Check if destination is a directory
      if (directories.has(dest)) {
        const error = new Error(`EISDIR: illegal operation on a directory, copyfile '${dest}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'EISDIR'
        error.syscall = 'copyfile'
        error.path = dest
        throw error
      }

      // Perform the copy
      const file = files.get(src)!
      files.set(dest, { content: new Uint8Array(file.content), mode: file.mode })
    },

    async rename(oldPath: string, newPath: string): Promise<void> {
      const file = files.get(oldPath)
      if (file) {
        files.delete(oldPath)
        files.set(newPath, file)
      }
    },

    async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
      const { recursive = false, force = false } = options ?? {}

      if (permissionDenied.has(path)) {
        const error = new Error(`EACCES: permission denied, unlink '${path}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'EACCES'
        error.syscall = 'unlink'
        error.path = path
        throw error
      }

      const isFile = files.has(path)
      const isDir = directories.has(path)

      if (!isFile && !isDir) {
        if (force) return
        const error = new Error(`ENOENT: no such file or directory, rm '${path}'`) as Error & {
          code: string
          syscall: string
          path: string
        }
        error.code = 'ENOENT'
        error.syscall = 'rm'
        error.path = path
        throw error
      }

      if (isFile) {
        files.delete(path)
        return
      }

      if (isDir) {
        const children = getChildPaths(path)

        if (children.length > 0 && !recursive) {
          const error = new Error(`ENOTEMPTY: directory not empty, rm '${path}'`) as Error & {
            code: string
            syscall: string
            path: string
          }
          error.code = 'ENOTEMPTY'
          error.syscall = 'rm'
          error.path = path
          throw error
        }

        if (recursive) {
          for (const childPath of children) {
            files.delete(childPath)
            directories.delete(childPath)
          }
        }

        directories.delete(path)
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

    async writeFile(
      path: string,
      data: string | Uint8Array,
      options?: { encoding?: string; mode?: number; flag?: string }
    ): Promise<void> {
      const content = typeof data === 'string' ? new TextEncoder().encode(data) : data
      files.set(path, { content, mode: options?.mode ?? 0o666 })
    },

    async appendFile(path: string, data: string | Uint8Array): Promise<void> {
      const newContent = typeof data === 'string' ? new TextEncoder().encode(data) : data
      const existing = files.get(path)
      if (existing) {
        const combined = new Uint8Array(existing.content.length + newContent.length)
        combined.set(existing.content)
        combined.set(newContent, existing.content.length)
        files.set(path, { content: combined, mode: existing.mode })
      } else {
        files.set(path, { content: newContent, mode: 0o666 })
      }
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

    async readdir(
      path: string,
      options?: { withFileTypes?: boolean; recursive?: boolean }
    ): Promise<string[] | { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean; path: string }[]> {
      if (!directories.has(path)) {
        const error = new Error(`ENOENT: no such file or directory, scandir '${path}'`) as Error & {
          code: string
        }
        error.code = 'ENOENT'
        throw error
      }

      const prefix = path === '/' ? '/' : path + '/'
      const entries: string[] = []

      for (const [filePath] of files) {
        if (filePath.startsWith(prefix)) {
          const relativePath = filePath.substring(prefix.length)
          const immediateChild = relativePath.split('/')[0]
          if (immediateChild && !entries.includes(immediateChild)) {
            entries.push(immediateChild)
          }
        }
      }

      for (const dirPath of directories) {
        if (dirPath !== path && dirPath.startsWith(prefix)) {
          const relativePath = dirPath.substring(prefix.length)
          const immediateChild = relativePath.split('/')[0]
          if (immediateChild && !entries.includes(immediateChild)) {
            entries.push(immediateChild)
          }
        }
      }

      if (options?.withFileTypes) {
        return entries.map((name) => {
          const fullPath = path === '/' ? `/${name}` : `${path}/${name}`
          return {
            name,
            isDirectory: () => directories.has(fullPath),
            isSymbolicLink: () => false,
            path: fullPath,
          }
        })
      }

      return entries.sort()
    },
  } as unknown as FSx & {
    _files: Map<string, { content: Uint8Array; mode: number }>
    _directories: Set<string>
    _permissionDenied: Set<string>
  }

  return mockFSx
}

describe('fs_copy MCP tool', () => {
  describe('tool definition', () => {
    it('should be registered in fsTools', () => {
      const copyTool = fsTools.find((t) => t.name === 'fs_copy')
      expect(copyTool).toBeDefined()
    })

    it('should have correct description', () => {
      const copyTool = fsTools.find((t) => t.name === 'fs_copy')
      expect(copyTool?.description).toBe('Copy a file')
    })

    it('should require source parameter', () => {
      const copyTool = fsTools.find((t) => t.name === 'fs_copy')
      expect(copyTool?.inputSchema.required).toContain('source')
    })

    it('should require destination parameter', () => {
      const copyTool = fsTools.find((t) => t.name === 'fs_copy')
      expect(copyTool?.inputSchema.required).toContain('destination')
    })

    it('should define source as string type', () => {
      const copyTool = fsTools.find((t) => t.name === 'fs_copy')
      expect(copyTool?.inputSchema.properties.source.type).toBe('string')
    })

    it('should define destination as string type', () => {
      const copyTool = fsTools.find((t) => t.name === 'fs_copy')
      expect(copyTool?.inputSchema.properties.destination.type).toBe('string')
    })
  })

  describe('copy file to new location', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should copy a file to a new location in the same directory', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('test content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_copy', { source: '/test/source.txt', destination: '/test/dest.txt' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Successfully copied /test/source.txt to /test/dest.txt',
      })

      // Verify file was copied
      expect(mockFs._files.has('/test/source.txt')).toBe(true)
      expect(mockFs._files.has('/test/dest.txt')).toBe(true)
    })

    it('should copy a file to a different directory', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('test content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_copy', { source: '/test/source.txt', destination: '/dest/copied.txt' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has('/test/source.txt')).toBe(true)
      expect(mockFs._files.has('/dest/copied.txt')).toBe(true)
    })

    it('should preserve file content after copy', async () => {
      const originalContent = new TextEncoder().encode('original content here')
      mockFs._files.set('/test/source.txt', {
        content: originalContent,
        mode: 0o666,
      })

      await invokeTool('fs_copy', { source: '/test/source.txt', destination: '/test/dest.txt' }, mockFs)

      const copiedFile = mockFs._files.get('/test/dest.txt')
      expect(copiedFile?.content).toEqual(originalContent)
    })

    it('should preserve file mode after copy', async () => {
      mockFs._files.set('/test/script.sh', {
        content: new TextEncoder().encode('#!/bin/bash'),
        mode: 0o755,
      })

      await invokeTool('fs_copy', { source: '/test/script.sh', destination: '/test/copied.sh' }, mockFs)

      const copiedFile = mockFs._files.get('/test/copied.sh')
      expect(copiedFile?.mode).toBe(0o755)
    })

    it('should copy file from nested directory to root', async () => {
      mockFs._directories.add('/test/deep/nested')
      mockFs._files.set('/test/deep/nested/file.txt', {
        content: new TextEncoder().encode('deep content'),
        mode: 0o666,
      })

      const result = await invokeTool(
        'fs_copy',
        { source: '/test/deep/nested/file.txt', destination: '/file-at-root.txt' },
        mockFs
      )

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has('/test/deep/nested/file.txt')).toBe(true)
      expect(mockFs._files.has('/file-at-root.txt')).toBe(true)
    })

    it('should copy file from root to nested directory', async () => {
      mockFs._directories.add('/dest/deep')
      mockFs._files.set('/root-file.txt', {
        content: new TextEncoder().encode('root content'),
        mode: 0o666,
      })

      const result = await invokeTool(
        'fs_copy',
        { source: '/root-file.txt', destination: '/dest/deep/copied.txt' },
        mockFs
      )

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has('/root-file.txt')).toBe(true)
      expect(mockFs._files.has('/dest/deep/copied.txt')).toBe(true)
    })
  })

  describe('source file is not modified', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should not modify source file content', async () => {
      const originalContent = new TextEncoder().encode('content')
      mockFs._files.set('/test/source.txt', {
        content: originalContent,
        mode: 0o666,
      })

      await invokeTool('fs_copy', { source: '/test/source.txt', destination: '/test/dest.txt' }, mockFs)

      const sourceFile = mockFs._files.get('/test/source.txt')
      expect(sourceFile?.content).toEqual(originalContent)
    })

    it('should not modify source file mode', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o755,
      })

      await invokeTool('fs_copy', { source: '/test/source.txt', destination: '/test/dest.txt' }, mockFs)

      const sourceFile = mockFs._files.get('/test/source.txt')
      expect(sourceFile?.mode).toBe(0o755)
    })

    it('source should remain readable after copy', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('readable content'),
        mode: 0o666,
      })

      await invokeTool('fs_copy', { source: '/test/source.txt', destination: '/test/dest.txt' }, mockFs)

      // Source should still be readable
      const content = await mockFs.readFile('/test/source.txt', 'utf-8')
      expect(content).toBe('readable content')
    })
  })

  describe('copy with same name (duplicate)', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should create independent copy of the file', async () => {
      const originalContent = new TextEncoder().encode('original')
      mockFs._files.set('/test/file.txt', {
        content: originalContent,
        mode: 0o666,
      })

      await invokeTool('fs_copy', { source: '/test/file.txt', destination: '/dest/file.txt' }, mockFs)

      // Both files should exist with same content
      expect(mockFs._files.has('/test/file.txt')).toBe(true)
      expect(mockFs._files.has('/dest/file.txt')).toBe(true)
      expect(mockFs._files.get('/test/file.txt')?.content).toEqual(originalContent)
      expect(mockFs._files.get('/dest/file.txt')?.content).toEqual(originalContent)
    })

    it('should create separate copy that can be modified independently', async () => {
      const originalContent = new TextEncoder().encode('original')
      mockFs._files.set('/test/file.txt', {
        content: originalContent,
        mode: 0o666,
      })

      await invokeTool('fs_copy', { source: '/test/file.txt', destination: '/dest/file.txt' }, mockFs)

      // Modify the copy
      mockFs._files.set('/dest/file.txt', {
        content: new TextEncoder().encode('modified'),
        mode: 0o666,
      })

      // Source should still have original content
      const sourceContent = mockFs._files.get('/test/file.txt')?.content
      expect(new TextDecoder().decode(sourceContent)).toBe('original')
    })
  })

  describe('overwrite existing file', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should overwrite existing file at destination', async () => {
      const sourceContent = new TextEncoder().encode('source content - should win')
      const destContent = new TextEncoder().encode('dest content - should be replaced')

      mockFs._files.set('/test/source.txt', { content: sourceContent, mode: 0o666 })
      mockFs._files.set('/test/dest.txt', { content: destContent, mode: 0o666 })

      const result = await invokeTool('fs_copy', { source: '/test/source.txt', destination: '/test/dest.txt' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has('/test/source.txt')).toBe(true)
      expect(mockFs._files.has('/test/dest.txt')).toBe(true)

      const finalContent = mockFs._files.get('/test/dest.txt')?.content
      expect(finalContent).toEqual(sourceContent)
    })

    it('should overwrite larger destination with smaller source', async () => {
      const smallContent = new TextEncoder().encode('small')
      const largeContent = new Uint8Array(10000).fill(0x41)

      mockFs._files.set('/test/small.txt', { content: smallContent, mode: 0o666 })
      mockFs._files.set('/test/large.txt', { content: largeContent, mode: 0o666 })

      await invokeTool('fs_copy', { source: '/test/small.txt', destination: '/test/large.txt' }, mockFs)

      const finalContent = mockFs._files.get('/test/large.txt')?.content
      expect(finalContent).toEqual(smallContent)
      expect(finalContent?.length).toBe(5)
    })

    it('should overwrite smaller destination with larger source', async () => {
      const smallContent = new TextEncoder().encode('small')
      const largeContent = new Uint8Array(10000).fill(0x42)

      mockFs._files.set('/test/large.bin', { content: largeContent, mode: 0o666 })
      mockFs._files.set('/test/small.txt', { content: smallContent, mode: 0o666 })

      await invokeTool('fs_copy', { source: '/test/large.bin', destination: '/test/small.txt' }, mockFs)

      const finalContent = mockFs._files.get('/test/small.txt')?.content
      expect(finalContent).toEqual(largeContent)
      expect(finalContent?.length).toBe(10000)
    })
  })

  describe('handle source not found error', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should return error when source file does not exist', async () => {
      const result = await invokeTool(
        'fs_copy',
        { source: '/nonexistent.txt', destination: '/dest/file.txt' },
        mockFs
      )

      expect(result.isError).toBe(true)
      expect(result.content[0].type).toBe('text')
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText).toContain('Error')
    })

    it('should include ENOENT indicator in error message', async () => {
      const result = await invokeTool(
        'fs_copy',
        { source: '/nonexistent/deep/file.txt', destination: '/dest/file.txt' },
        mockFs
      )

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText.toLowerCase()).toMatch(/no such file|enoent|not found/)
    })
  })

  describe('handle destination parent not found error', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should return error when destination parent directory does not exist', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool(
        'fs_copy',
        { source: '/test/source.txt', destination: '/nonexistent-parent/file.txt' },
        mockFs
      )

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText.toLowerCase()).toMatch(/no such file|enoent|not found/)
    })

    it('should not modify source when destination parent is missing', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      await invokeTool(
        'fs_copy',
        { source: '/test/source.txt', destination: '/nonexistent/deep/path/file.txt' },
        mockFs
      )

      // Source should still exist and be unchanged
      expect(mockFs._files.has('/test/source.txt')).toBe(true)
    })
  })

  describe('handle permission denied error', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should return error when permission denied on source', async () => {
      const path = '/test/readonly.txt'
      mockFs._files.set(path, {
        content: new TextEncoder().encode('protected content'),
        mode: 0o444,
      })
      mockFs._permissionDenied.add(path)

      const result = await invokeTool('fs_copy', { source: path, destination: '/dest/copied.txt' }, mockFs)

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText.toLowerCase()).toMatch(/permission|eacces|denied/)
    })

    it('should return error when permission denied on destination', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })
      mockFs._permissionDenied.add('/dest/protected.txt')

      const result = await invokeTool(
        'fs_copy',
        { source: '/test/source.txt', destination: '/dest/protected.txt' },
        mockFs
      )

      expect(result.isError).toBe(true)
    })

    it('should not create destination file when permission denied', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })
      mockFs._permissionDenied.add('/dest/protected.txt')

      await invokeTool(
        'fs_copy',
        { source: '/test/source.txt', destination: '/dest/protected.txt' },
        mockFs
      )

      // Destination should not be created
      expect(mockFs._files.has('/dest/protected.txt')).toBe(false)
    })
  })

  describe('handle source is directory error', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should return error when source is a directory', async () => {
      mockFs._directories.add('/test/mydir')

      const result = await invokeTool(
        'fs_copy',
        { source: '/test/mydir', destination: '/dest/copied' },
        mockFs
      )

      expect(result.isError).toBe(true)
      const errorText = (result.content[0] as { type: 'text'; text: string }).text
      expect(errorText.toLowerCase()).toMatch(/directory|eisdir/)
    })
  })

  describe('handle destination is directory error', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should return error when destination is a directory', async () => {
      mockFs._files.set('/test/file.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })
      mockFs._directories.add('/test/existing-dir')

      const result = await invokeTool(
        'fs_copy',
        { source: '/test/file.txt', destination: '/test/existing-dir' },
        mockFs
      )

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
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_copy', { source: '/test/source.txt', destination: '/test/dest.txt' }, mockFs)

      expect(result).toHaveProperty('content')
      expect(Array.isArray(result.content)).toBe(true)
      expect(result.content.length).toBeGreaterThan(0)
      expect(result.content[0]).toHaveProperty('type')
      expect(result.content[0]).toHaveProperty('text')
    })

    it('should return properly formatted error result', async () => {
      const result = await invokeTool('fs_copy', { source: '/nonexistent.txt', destination: '/dest.txt' }, mockFs)

      expect(result).toHaveProperty('content')
      expect(result).toHaveProperty('isError')
      expect(result.isError).toBe(true)
      expect(Array.isArray(result.content)).toBe(true)
      expect(result.content[0]).toHaveProperty('type', 'text')
    })

    it('should include both paths in success message', async () => {
      const source = '/test/src-file.txt'
      const destination = '/test/dst-file.txt'
      mockFs._files.set(source, {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_copy', { source, destination }, mockFs)

      expect(result.isError).toBeFalsy()
      const text = (result.content[0] as { type: 'text'; text: string }).text
      expect(text).toContain(source)
      expect(text).toContain(destination)
    })

    it('should have text type in content array', async () => {
      mockFs._files.set('/test/file.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_copy', { source: '/test/file.txt', destination: '/test/copied.txt' }, mockFs)

      expect(result.content[0].type).toBe('text')
    })
  })

  describe('edge cases', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should handle very long file paths', async () => {
      const longSource = '/test/' + 'a'.repeat(200) + '.txt'
      const longDest = '/test/' + 'b'.repeat(200) + '.txt'
      mockFs._files.set(longSource, {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_copy', { source: longSource, destination: longDest }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has(longSource)).toBe(true)
      expect(mockFs._files.has(longDest)).toBe(true)
    })

    it('should handle paths with spaces', async () => {
      const source = '/test/file with spaces.txt'
      const dest = '/test/copied file with spaces.txt'
      mockFs._files.set(source, {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_copy', { source, destination: dest }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.has(source)).toBe(true)
      expect(mockFs._files.has(dest)).toBe(true)
    })

    it('should handle paths with special characters', async () => {
      const source = '/test/file-with_special.chars!.txt'
      const dest = '/test/copied-with_special.chars!.txt'
      mockFs._files.set(source, {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_copy', { source, destination: dest }, mockFs)

      expect(result.isError).toBeFalsy()
    })

    it('should handle empty source path', async () => {
      const result = await invokeTool('fs_copy', { source: '', destination: '/dest/file.txt' }, mockFs)

      // Should handle gracefully (likely error)
      expect(result.content).toBeDefined()
    })

    it('should handle empty destination path', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      const result = await invokeTool('fs_copy', { source: '/test/source.txt', destination: '' }, mockFs)

      // Should handle gracefully (likely error)
      expect(result.content).toBeDefined()
    })

    it('should handle large file copy', async () => {
      const largeContent = new Uint8Array(10 * 1024 * 1024) // 10MB
      for (let i = 0; i < largeContent.length; i++) {
        largeContent[i] = i % 256
      }
      mockFs._files.set('/test/large.bin', {
        content: largeContent,
        mode: 0o666,
      })

      const result = await invokeTool('fs_copy', { source: '/test/large.bin', destination: '/dest/large.bin' }, mockFs)

      expect(result.isError).toBeFalsy()
      expect(mockFs._files.get('/dest/large.bin')?.content).toEqual(largeContent)
    })

    it('should handle concurrent copy operations on different files', async () => {
      mockFs._files.set('/test/file1.txt', {
        content: new TextEncoder().encode('content1'),
        mode: 0o666,
      })
      mockFs._files.set('/test/file2.txt', {
        content: new TextEncoder().encode('content2'),
        mode: 0o666,
      })

      const results = await Promise.all([
        invokeTool('fs_copy', { source: '/test/file1.txt', destination: '/dest/copied1.txt' }, mockFs),
        invokeTool('fs_copy', { source: '/test/file2.txt', destination: '/dest/copied2.txt' }, mockFs),
      ])

      for (const result of results) {
        expect(result.isError).toBeFalsy()
      }

      expect(mockFs._files.has('/dest/copied1.txt')).toBe(true)
      expect(mockFs._files.has('/dest/copied2.txt')).toBe(true)
    })
  })

  describe('binary content preservation', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should preserve all byte values (0x00 to 0xFF)', async () => {
      const content = new Uint8Array(256)
      for (let i = 0; i < 256; i++) {
        content[i] = i
      }
      mockFs._files.set('/test/allbytes.bin', { content, mode: 0o666 })

      await invokeTool('fs_copy', { source: '/test/allbytes.bin', destination: '/dest/allbytes.bin' }, mockFs)

      const copiedContent = mockFs._files.get('/dest/allbytes.bin')?.content
      expect(copiedContent).toEqual(content)
    })

    it('should preserve null bytes', async () => {
      const content = new Uint8Array([0x00, 0x00, 0x00, 0x41, 0x00, 0x42, 0x00])
      mockFs._files.set('/test/nulls.bin', { content, mode: 0o666 })

      await invokeTool('fs_copy', { source: '/test/nulls.bin', destination: '/dest/nulls.bin' }, mockFs)

      const copiedContent = mockFs._files.get('/dest/nulls.bin')?.content
      expect(copiedContent).toEqual(content)
    })

    it('should copy empty file', async () => {
      mockFs._files.set('/test/empty.txt', {
        content: new Uint8Array([]),
        mode: 0o666,
      })

      await invokeTool('fs_copy', { source: '/test/empty.txt', destination: '/dest/empty.txt' }, mockFs)

      const copiedContent = mockFs._files.get('/dest/empty.txt')?.content
      expect(copiedContent).toEqual(new Uint8Array([]))
      expect(copiedContent?.length).toBe(0)
    })
  })

  describe('verify copy operation', () => {
    let mockFs: ReturnType<typeof createMockFSx>

    beforeEach(() => {
      mockFs = createMockFSx()
    })

    it('should make stat succeed on destination after copy', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      await invokeTool('fs_copy', { source: '/test/source.txt', destination: '/dest/copied.txt' }, mockFs)

      // stat should succeed on destination
      const stat = await mockFs.stat('/dest/copied.txt')
      expect(stat.isFile()).toBe(true)
    })

    it('should make readFile succeed on destination after copy', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('readable content'),
        mode: 0o666,
      })

      await invokeTool('fs_copy', { source: '/test/source.txt', destination: '/dest/copied.txt' }, mockFs)

      const content = await mockFs.readFile('/dest/copied.txt', 'utf-8')
      expect(content).toBe('readable content')
    })

    it('should make exists return true on destination after copy', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      // Before copy
      expect(await mockFs.exists('/dest/copied.txt')).toBe(false)

      await invokeTool('fs_copy', { source: '/test/source.txt', destination: '/dest/copied.txt' }, mockFs)

      // After copy
      expect(await mockFs.exists('/dest/copied.txt')).toBe(true)
    })

    it('source should still be readable after copy', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('source content'),
        mode: 0o666,
      })

      await invokeTool('fs_copy', { source: '/test/source.txt', destination: '/dest/copied.txt' }, mockFs)

      // Source should still be readable
      const content = await mockFs.readFile('/test/source.txt', 'utf-8')
      expect(content).toBe('source content')
    })

    it('should add file to destination directory listing after copy', async () => {
      mockFs._files.set('/test/source.txt', {
        content: new TextEncoder().encode('content'),
        mode: 0o666,
      })

      // Before copy
      const beforeEntries = await mockFs.readdir('/dest')
      expect(beforeEntries).not.toContain('copied.txt')

      await invokeTool('fs_copy', { source: '/test/source.txt', destination: '/dest/copied.txt' }, mockFs)

      // After copy
      const afterEntries = await mockFs.readdir('/dest')
      expect(afterEntries).toContain('copied.txt')
    })
  })
})
