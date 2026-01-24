/**
 * Tests for MCP Core Tools: search, fetch, do with fs binding
 *
 * This test file verifies the search/fetch/do pattern for MCP filesystem tools.
 *
 * @module tests/mcp/tools
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryStorage, createTestFilesystem } from '../test-utils'

import {
  // Core tools
  createSearchHandler,
  createFetchHandler,
  createDoHandler,
  registerTools,
  createToolCallHandler,
  getToolDefinitions,
  // Scope
  createFsScope,
  createFsBinding,
  // Schemas
  searchToolSchema,
  fetchToolSchema,
  doToolSchema,
  coreTools,
  // Types
  type ExtendedFsStorage,
} from '../../core/mcp'

// =============================================================================
// SEARCH TOOL TESTS
// =============================================================================

describe('search tool', () => {
  let storage: InMemoryStorage

  beforeEach(() => {
    storage = createTestFilesystem()
    storage.addDirectory('/home/user/src')
    storage.addFile('/home/user/src/index.ts', 'export const main = () => {}')
    storage.addFile('/home/user/src/utils.ts', 'export const utils = {}')
    storage.addFile('/home/user/src/config.json', '{"key": "value"}')
    storage.addFile('/home/user/app.ts', 'import { main } from "./src"')
    storage.addFile('/home/user/readme.md', '# Readme')
  })

  describe('glob pattern search', () => {
    it('should search with glob pattern **/*.ts', async () => {
      const searchHandler = createSearchHandler(storage)
      const result = await searchHandler({ query: '**/*.ts', path: '/home/user' })

      expect(result.isError).toBeFalsy()
      const text = result.content[0]?.text ?? ''
      expect(text).toContain('index.ts')
      expect(text).toContain('utils.ts')
      expect(text).toContain('app.ts')
      expect(text).not.toContain('config.json')
    })

    it('should search with limit', async () => {
      const searchHandler = createSearchHandler(storage)
      const result = await searchHandler({ query: '**/*.ts', path: '/home/user', limit: 1 })

      expect(result.isError).toBeFalsy()
      const text = result.content[0]?.text ?? ''
      const lines = text.split('\n').filter(l => l.includes('.ts'))
      expect(lines.length).toBeLessThanOrEqual(1)
    })

    it('should search from custom path', async () => {
      const searchHandler = createSearchHandler(storage)
      const result = await searchHandler({ query: '*.ts', path: '/home/user/src' })

      expect(result.isError).toBeFalsy()
      const text = result.content[0]?.text ?? ''
      expect(text).toContain('index.ts')
      expect(text).toContain('utils.ts')
      expect(text).not.toContain('app.ts') // Not in src/
    })
  })

  describe('content search (grep)', () => {
    it('should search file contents with grep: prefix', async () => {
      const searchHandler = createSearchHandler(storage)
      const result = await searchHandler({ query: 'grep:export', path: '/home/user' })

      expect(result.isError).toBeFalsy()
      const text = result.content[0]?.text ?? ''
      expect(text).toContain('index.ts')
      expect(text).toContain('utils.ts')
      expect(text).not.toContain('readme.md')
    })
  })
})

// =============================================================================
// FETCH TOOL TESTS
// =============================================================================

describe('fetch tool', () => {
  let storage: InMemoryStorage

  beforeEach(() => {
    storage = createTestFilesystem()
    storage.addFile('/home/user/test.txt', 'Hello, World!')
    storage.addFile('/home/user/data.json', '{"name": "test", "value": 42}')
    storage.addDirectory('/home/user/dir')
    storage.addFile('/home/user/dir/nested.txt', 'Nested content')
  })

  describe('file reading', () => {
    it('should read file contents', async () => {
      const fetchHandler = createFetchHandler(storage)
      const result = await fetchHandler({ resource: '/home/user/test.txt' })

      expect(result.isError).toBeFalsy()
      expect(result.content[0]?.text).toContain('Hello, World!')
    })

    it('should format JSON content', async () => {
      const fetchHandler = createFetchHandler(storage)
      const result = await fetchHandler({ resource: '/home/user/data.json' })

      expect(result.isError).toBeFalsy()
      const text = result.content[0]?.text ?? ''
      expect(text).toContain('"name": "test"')
      expect(text).toContain('"value": 42')
    })

    it('should include metadata', async () => {
      const fetchHandler = createFetchHandler(storage)
      const result = await fetchHandler({ resource: '/home/user/test.txt' })

      expect(result.isError).toBeFalsy()
      const metadataText = result.content[1]?.text ?? ''
      expect(metadataText).toContain('metadata')
      expect(metadataText).toContain('/home/user/test.txt')
    })

    it('should return tree view for directories', async () => {
      const fetchHandler = createFetchHandler(storage)
      const result = await fetchHandler({ resource: '/home/user/dir' })

      expect(result.isError).toBeFalsy()
      const text = result.content[0]?.text ?? ''
      expect(text).toContain('nested.txt')
    })

    it('should return error for non-existent file', async () => {
      const fetchHandler = createFetchHandler(storage)
      const result = await fetchHandler({ resource: '/home/user/nonexistent.txt' })

      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toContain('ENOENT')
    })
  })
})

// =============================================================================
// DO TOOL TESTS
// =============================================================================

describe('do tool', () => {
  let storage: InMemoryStorage

  beforeEach(() => {
    storage = createTestFilesystem()
    storage.addFile('/home/user/test.txt', 'Hello, World!')
    storage.addDirectory('/home/user/data')
    storage.addFile('/home/user/data/file1.txt', 'File 1 content')
    storage.addFile('/home/user/data/file2.txt', 'File 2 content')
  })

  describe('code execution with fs binding', () => {
    it('should execute code with fs.read', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage)
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          const content = await fs.read('/home/user/test.txt')
          return content
        `,
      })

      expect(result.isError).toBeFalsy()
      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(true)
      expect(parsed.value).toBe('Hello, World!')
    })

    it('should execute code with fs.write', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage)
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          await fs.write('/home/user/new.txt', 'New content')
          return await fs.read('/home/user/new.txt')
        `,
      })

      expect(result.isError).toBeFalsy()
      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(true)
      expect(parsed.value).toBe('New content')
    })

    it('should execute code with fs.list', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage)
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          const files = await fs.list('/home/user/data')
          return files
        `,
      })

      expect(result.isError).toBeFalsy()
      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(true)
      expect(parsed.value).toContain('file1.txt')
      expect(parsed.value).toContain('file2.txt')
    })

    it('should execute code with fs.exists', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage)
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          const exists = await fs.exists('/home/user/test.txt')
          const notExists = await fs.exists('/home/user/nonexistent.txt')
          return { exists, notExists }
        `,
      })

      expect(result.isError).toBeFalsy()
      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(true)
      expect(parsed.value.exists).toBe(true)
      expect(parsed.value.notExists).toBe(false)
    })

    it('should capture console logs', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage)
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          console.log('Hello from sandbox')
          console.warn('Warning message')
          return 'done'
        `,
      })

      expect(result.isError).toBeFalsy()
      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(true)
      expect(parsed.logs).toHaveLength(2)
      expect(parsed.logs[0].level).toBe('log')
      expect(parsed.logs[0].message).toBe('Hello from sandbox')
      expect(parsed.logs[1].level).toBe('warn')
    })

    it('should handle errors gracefully', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage)
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          await fs.read('/nonexistent/file.txt')
        `,
      })

      expect(result.isError).toBe(true)
      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(false)
      expect(parsed.error).toContain('ENOENT')
    })

    it('should track execution duration', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage)
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `return 1 + 1`,
      })

      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.duration).toBeGreaterThanOrEqual(0)
    })
  })

  describe('fs binding operations', () => {
    it('should support fs.mkdir', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage)
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          await fs.mkdir('/home/user/newdir')
          return await fs.exists('/home/user/newdir')
        `,
      })

      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(true)
      expect(parsed.value).toBe(true)
    })

    it('should support fs.mkdir with recursive option', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage)
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          await fs.mkdir('/home/user/a/b/c', { recursive: true })
          return await fs.exists('/home/user/a/b/c')
        `,
      })

      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(true)
      expect(parsed.value).toBe(true)
    })

    it('should support fs.copy', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage)
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          await fs.copy('/home/user/test.txt', '/home/user/test-copy.txt')
          return await fs.read('/home/user/test-copy.txt')
        `,
      })

      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(true)
      expect(parsed.value).toBe('Hello, World!')
    })

    it('should support fs.move', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage)
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          await fs.move('/home/user/test.txt', '/home/user/test-moved.txt')
          const movedExists = await fs.exists('/home/user/test-moved.txt')
          const originalExists = await fs.exists('/home/user/test.txt')
          return { movedExists, originalExists }
        `,
      })

      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(true)
      expect(parsed.value.movedExists).toBe(true)
      expect(parsed.value.originalExists).toBe(false)
    })

    it('should support fs.delete', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage)
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          await fs.delete('/home/user/test.txt')
          return await fs.exists('/home/user/test.txt')
        `,
      })

      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(true)
      expect(parsed.value).toBe(false)
    })

    it('should support fs.append', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage)
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          await fs.append('/home/user/test.txt', ' Appended!')
          return await fs.read('/home/user/test.txt')
        `,
      })

      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(true)
      expect(parsed.value).toBe('Hello, World! Appended!')
    })

    it('should support fs.stat', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage)
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          const stat = await fs.stat('/home/user/test.txt')
          return stat
        `,
      })

      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(true)
      expect(parsed.value.isFile).toBe(true)
      expect(parsed.value.isDirectory).toBe(false)
      expect(parsed.value.size).toBe(13) // 'Hello, World!' is 13 bytes
    })

    it('should support fs.tree', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage)
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          const tree = await fs.tree('/home/user/data')
          return tree
        `,
      })

      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(true)
      expect(parsed.value).toContain('file1.txt')
      expect(parsed.value).toContain('file2.txt')
    })
  })

  describe('permissions', () => {
    it('should respect write permission denial', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage, { allowWrite: false })
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          await fs.write('/home/user/blocked.txt', 'content')
        `,
      })

      expect(result.isError).toBe(true)
      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(false)
      expect(parsed.error).toContain('permission denied')
    })

    it('should respect delete permission denial', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage, { allowDelete: false })
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          await fs.delete('/home/user/test.txt')
        `,
      })

      expect(result.isError).toBe(true)
      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(false)
      expect(parsed.error).toContain('permission denied')
    })

    it('should respect allowed paths restriction', async () => {
      const scope = createFsScope(storage as ExtendedFsStorage, {
        allowedPaths: ['/home/user/data'],
      })
      const doHandler = createDoHandler(scope)

      const result = await doHandler({
        code: `
          await fs.read('/home/user/test.txt')
        `,
      })

      expect(result.isError).toBe(true)
      const parsed = JSON.parse(result.content[0]?.text ?? '{}')
      expect(parsed.success).toBe(false)
      expect(parsed.error).toContain('path not allowed')
    })
  })
})

// =============================================================================
// TOOL REGISTRATION TESTS
// =============================================================================

describe('tool registration', () => {
  let storage: InMemoryStorage

  beforeEach(() => {
    storage = createTestFilesystem()
    storage.addFile('/home/user/test.txt', 'Test content')
  })

  it('should register all three core tools', () => {
    const registry = registerTools({ storage: storage as ExtendedFsStorage })

    const tools = getToolDefinitions(registry)
    expect(tools).toHaveLength(3)

    const toolNames = tools.map(t => t.name)
    expect(toolNames).toContain('search')
    expect(toolNames).toContain('fetch')
    expect(toolNames).toContain('do')
  })

  it('should provide tool call handler', async () => {
    const registry = registerTools({ storage: storage as ExtendedFsStorage })
    const handleToolCall = createToolCallHandler(registry)

    // Test search
    const searchResult = await handleToolCall('search', { query: '**/*.txt', path: '/home/user' })
    expect(searchResult.isError).toBeFalsy()

    // Test fetch
    const fetchResult = await handleToolCall('fetch', { resource: '/home/user/test.txt' })
    expect(fetchResult.isError).toBeFalsy()
    expect(fetchResult.content[0]?.text).toContain('Test content')

    // Test do
    const doResult = await handleToolCall('do', { code: 'return 1 + 1' })
    expect(doResult.isError).toBeFalsy()
  })

  it('should return error for unknown tool', async () => {
    const registry = registerTools({ storage: storage as ExtendedFsStorage })
    const handleToolCall = createToolCallHandler(registry)

    const result = await handleToolCall('unknown_tool', {})
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Unknown tool')
  })
})

// =============================================================================
// TOOL SCHEMA TESTS
// =============================================================================

describe('tool schemas', () => {
  it('should have correct schema for search tool', () => {
    expect(searchToolSchema.name).toBe('search')
    expect(searchToolSchema.inputSchema.required).toContain('query')
    expect(searchToolSchema.inputSchema.properties.query).toBeDefined()
    expect(searchToolSchema.inputSchema.properties.limit).toBeDefined()
    expect(searchToolSchema.inputSchema.properties.path).toBeDefined()
  })

  it('should have correct schema for fetch tool', () => {
    expect(fetchToolSchema.name).toBe('fetch')
    expect(fetchToolSchema.inputSchema.required).toContain('resource')
    expect(fetchToolSchema.inputSchema.properties.resource).toBeDefined()
  })

  it('should have correct schema for do tool', () => {
    expect(doToolSchema.name).toBe('do')
    expect(doToolSchema.inputSchema.required).toContain('code')
    expect(doToolSchema.inputSchema.properties.code).toBeDefined()
  })

  it('should export coreTools array with all three tools', () => {
    expect(coreTools).toHaveLength(3)
    const names = coreTools.map(t => t.name)
    expect(names).toContain('search')
    expect(names).toContain('fetch')
    expect(names).toContain('do')
  })
})

// =============================================================================
// FS BINDING TESTS
// =============================================================================

describe('fs binding', () => {
  let storage: InMemoryStorage

  beforeEach(() => {
    storage = createTestFilesystem()
    storage.addFile('/home/user/test.txt', 'Hello!')
  })

  it('should create fs binding from storage', () => {
    const fsBinding = createFsBinding(storage as ExtendedFsStorage)

    expect(typeof fsBinding.read).toBe('function')
    expect(typeof fsBinding.write).toBe('function')
    expect(typeof fsBinding.append).toBe('function')
    expect(typeof fsBinding.delete).toBe('function')
    expect(typeof fsBinding.move).toBe('function')
    expect(typeof fsBinding.copy).toBe('function')
    expect(typeof fsBinding.mkdir).toBe('function')
    expect(typeof fsBinding.stat).toBe('function')
    expect(typeof fsBinding.list).toBe('function')
    expect(typeof fsBinding.tree).toBe('function')
    expect(typeof fsBinding.search).toBe('function')
    expect(typeof fsBinding.exists).toBe('function')
  })

  it('should execute fs.read directly', async () => {
    const fsBinding = createFsBinding(storage as ExtendedFsStorage)
    const content = await fsBinding.read('/home/user/test.txt')
    expect(content).toBe('Hello!')
  })

  it('should execute fs.exists directly', async () => {
    const fsBinding = createFsBinding(storage as ExtendedFsStorage)
    const exists = await fsBinding.exists('/home/user/test.txt')
    const notExists = await fsBinding.exists('/nonexistent')
    expect(exists).toBe(true)
    expect(notExists).toBe(false)
  })
})
