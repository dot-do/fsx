/**
 * Tests for MCP 3-Tool Cleanup
 *
 * RED phase: These tests verify the cleanup to only 3 core tools.
 * All tests should FAIL until the implementation is updated.
 *
 * The goal is to reduce from 12 fs_* tools to only 3 core tools:
 * - search: Glob/grep file search
 * - fetch: Read file content by path
 * - do: Execute code with fs binding
 *
 * The fs binding in the 'do' tool provides all filesystem operations,
 * making the individual fs_* tools redundant.
 *
 * @module tests/mcp/cleanup
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { InMemoryStorage, createTestFilesystem } from '../test-utils'

import {
  // Tool registry functions
  getToolRegistry,
  invokeTool,
  clearToolRegistry,
  // fsTools array
  fsTools,
} from '../../core/mcp'

// =============================================================================
// TOOL REGISTRY CLEANUP TESTS
// =============================================================================

describe('MCP 3-Tool Cleanup', () => {
  let storage: InMemoryStorage

  beforeEach(() => {
    storage = createTestFilesystem()
    clearToolRegistry()
  })

  afterEach(() => {
    clearToolRegistry()
  })

  // ---------------------------------------------------------------------------
  // Test 1: Registry should have exactly 3 tools
  // ---------------------------------------------------------------------------
  describe('getToolRegistry().list() returns exactly 3 tools', () => {
    it('should return exactly 3 registered tools', () => {
      const registry = getToolRegistry()
      const toolNames = registry.list()

      expect(toolNames.length).toBe(3)
    })

    it('should have a count of 3', () => {
      const registry = getToolRegistry()

      expect(registry.count()).toBe(3)
    })
  })

  // ---------------------------------------------------------------------------
  // Test 2: Registered tool names should be exactly ['search', 'fetch', 'do']
  // ---------------------------------------------------------------------------
  describe('registered tool names are exactly search, fetch, do', () => {
    it('should have search tool registered', () => {
      const registry = getToolRegistry()

      expect(registry.has('search')).toBe(true)
    })

    it('should have fetch tool registered', () => {
      const registry = getToolRegistry()

      expect(registry.has('fetch')).toBe(true)
    })

    it('should have do tool registered', () => {
      const registry = getToolRegistry()

      expect(registry.has('do')).toBe(true)
    })

    it('should only contain search, fetch, and do tools', () => {
      const registry = getToolRegistry()
      const toolNames = registry.list().sort()

      expect(toolNames).toEqual(['do', 'fetch', 'search'])
    })

    it('should not have any fs_* tools registered', () => {
      const registry = getToolRegistry()
      const toolNames = registry.list()

      const fsToolNames = toolNames.filter(name => name.startsWith('fs_'))
      expect(fsToolNames).toEqual([])
    })
  })

  // ---------------------------------------------------------------------------
  // Test 3: invokeTool('fs_read', ...) should return 'unknown tool' error
  // ---------------------------------------------------------------------------
  describe('invokeTool fs_read returns unknown tool error', () => {
    it('should return error for fs_read tool', async () => {
      const result = await invokeTool('fs_read', { path: '/test.txt' }, storage)

      expect(result.isError).toBe(true)
      expect(result.content[0]).toBeDefined()
      expect(result.content[0]?.type).toBe('text')
      const text = 'text' in result.content[0]! ? result.content[0].text : ''
      expect(text.toLowerCase()).toContain('unknown tool')
    })

    it('should not be able to read files via fs_read', async () => {
      storage.addFile('/test.txt', 'test content')
      const result = await invokeTool('fs_read', { path: '/test.txt' }, storage)

      expect(result.isError).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Test 4: invokeTool('fs_write', ...) should return 'unknown tool' error
  // ---------------------------------------------------------------------------
  describe('invokeTool fs_write returns unknown tool error', () => {
    it('should return error for fs_write tool', async () => {
      const result = await invokeTool('fs_write', { path: '/test.txt', content: 'hello' }, storage)

      expect(result.isError).toBe(true)
      expect(result.content[0]).toBeDefined()
      expect(result.content[0]?.type).toBe('text')
      const text = 'text' in result.content[0]! ? result.content[0].text : ''
      expect(text.toLowerCase()).toContain('unknown tool')
    })

    it('should not be able to write files via fs_write', async () => {
      const result = await invokeTool('fs_write', { path: '/new.txt', content: 'new content' }, storage)

      expect(result.isError).toBe(true)
      // File should not have been created
      expect(storage.has('/new.txt')).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Test 5: fsTools array should be empty or only contain 3 tools
  // ---------------------------------------------------------------------------
  describe('fsTools array is empty or only contains 3 tools', () => {
    it('should have fsTools array with 3 or fewer tools', () => {
      expect(fsTools.length).toBeLessThanOrEqual(3)
    })

    it('should only have search, fetch, do in fsTools if not empty', () => {
      if (fsTools.length > 0) {
        const names = fsTools.map(tool => tool.schema.name)
        const allowedNames = ['search', 'fetch', 'do']

        for (const name of names) {
          expect(allowedNames).toContain(name)
        }
      }
    })

    it('should not have fs_read in fsTools', () => {
      const names = fsTools.map(tool => tool.schema.name)
      expect(names).not.toContain('fs_read')
    })

    it('should not have fs_write in fsTools', () => {
      const names = fsTools.map(tool => tool.schema.name)
      expect(names).not.toContain('fs_write')
    })

    it('should not have fs_list in fsTools', () => {
      const names = fsTools.map(tool => tool.schema.name)
      expect(names).not.toContain('fs_list')
    })

    it('should not have fs_search in fsTools', () => {
      const names = fsTools.map(tool => tool.schema.name)
      expect(names).not.toContain('fs_search')
    })

    it('should not have fs_stat in fsTools', () => {
      const names = fsTools.map(tool => tool.schema.name)
      expect(names).not.toContain('fs_stat')
    })

    it('should not have fs_mkdir in fsTools', () => {
      const names = fsTools.map(tool => tool.schema.name)
      expect(names).not.toContain('fs_mkdir')
    })

    it('should not have fs_tree in fsTools', () => {
      const names = fsTools.map(tool => tool.schema.name)
      expect(names).not.toContain('fs_tree')
    })

    it('should not have fs_delete in fsTools', () => {
      const names = fsTools.map(tool => tool.schema.name)
      expect(names).not.toContain('fs_delete')
    })

    it('should not have fs_append in fsTools', () => {
      const names = fsTools.map(tool => tool.schema.name)
      expect(names).not.toContain('fs_append')
    })

    it('should not have fs_move in fsTools', () => {
      const names = fsTools.map(tool => tool.schema.name)
      expect(names).not.toContain('fs_move')
    })

    it('should not have fs_copy in fsTools', () => {
      const names = fsTools.map(tool => tool.schema.name)
      expect(names).not.toContain('fs_copy')
    })

    it('should not have fs_exists in fsTools', () => {
      const names = fsTools.map(tool => tool.schema.name)
      expect(names).not.toContain('fs_exists')
    })
  })

  // ---------------------------------------------------------------------------
  // Additional verification: Other legacy fs_* tools should also be gone
  // ---------------------------------------------------------------------------
  describe('all legacy fs_* tools should be removed', () => {
    const legacyTools = [
      'fs_search',
      'fs_list',
      'fs_mkdir',
      'fs_stat',
      'fs_lstat',
      'fs_tree',
      'fs_read',
      'fs_write',
      'fs_append',
      'fs_delete',
      'fs_move',
      'fs_copy',
      'fs_exists',
    ]

    for (const toolName of legacyTools) {
      it(`should return unknown tool error for ${toolName}`, async () => {
        const result = await invokeTool(toolName, {}, storage)

        expect(result.isError).toBe(true)
        const text = 'text' in result.content[0]! ? result.content[0].text : ''
        expect(text.toLowerCase()).toContain('unknown tool')
      })
    }
  })
})
