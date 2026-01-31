/**
 * MCP Tools: search, fetch, do
 *
 * This module provides the three core MCP tools for filesystem operations:
 * - search: Glob/grep file search
 * - fetch: Read file content by path
 * - do: Execute code with fs binding available
 *
 * The fs binding in the 'do' tool provides all filesystem operations
 * (read, write, delete, move, copy, mkdir, stat, list, tree, search, exists),
 * making individual tool exposure unnecessary.
 *
 * @module core/mcp/tools
 */

import type { ToolResponse, DoInput, DoResult, Tool, ToolHandler, ToolRegistry } from '@dotdo/mcp/tools'
import { createDoHandler, type SandboxEnv } from '@dotdo/mcp/tools'

import type { StorageBackend } from './shared'
import { normalizePath } from './shared'
import { invokeFsSearch } from './fs-search'
import { invokeFsTree, type TreeStorageBackend } from './fs-tree'
import {
  createFsScope,
  type ExtendedFsStorage,
  type FsPermissions,
  type DoPermissions,
} from './scope'

// Re-export SandboxEnv and DoPermissions for consumers
export type { SandboxEnv, DoPermissions }

// =============================================================================
// Types - Re-export shared types from @dotdo/mcp
// =============================================================================

export type { ToolResponse, DoInput, DoResult, Tool, ToolHandler, ToolRegistry }

/**
 * Input parameters for the search tool.
 */
export interface SearchInput {
  /** Search query - glob pattern, path pattern, or content search */
  query: string
  /** Maximum number of results */
  limit?: number
  /** Base path to search in */
  path?: string
}

/**
 * Input parameters for the fetch tool.
 */
export interface FetchInput {
  /** Resource identifier - file path */
  resource: string
}

// =============================================================================
// Tool Schemas
// =============================================================================

/**
 * Schema for the search tool.
 */
export const searchToolSchema = {
  name: 'search',
  description: 'Search for files using glob patterns or content search',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search query - glob pattern (e.g., "**/*.ts") or content search',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return',
      },
      path: {
        type: 'string',
        description: 'Base path to search in (default: "/")',
      },
    },
    required: ['query'] as string[],
  },
} as const

/**
 * Schema for the fetch tool.
 */
export const fetchToolSchema = {
  name: 'fetch',
  description: 'Retrieve file content by path',
  inputSchema: {
    type: 'object' as const,
    properties: {
      resource: {
        type: 'string',
        description: 'File path to read',
      },
    },
    required: ['resource'] as string[],
  },
} as const

/**
 * Schema for the do tool.
 */
export const doToolSchema = {
  name: 'do',
  description: 'Execute code in a sandboxed environment with access to fs binding',
  inputSchema: {
    type: 'object' as const,
    properties: {
      code: {
        type: 'string',
        description: 'TypeScript/JavaScript code to execute. Has access to `fs` binding for filesystem operations.',
      },
    },
    required: ['code'] as string[],
  },
} as const

// =============================================================================
// Search Tool
// =============================================================================

/**
 * Create a search handler that uses the storage backend.
 *
 * The search tool supports:
 * - Glob patterns (e.g., "**\/*.ts")
 * - Content search (prefixed with "grep:")
 * - Path patterns
 *
 * @param storage - Storage backend to search
 * @returns Search handler function
 *
 * @example
 * ```typescript
 * const searchHandler = createSearchHandler(storage)
 *
 * // Glob search
 * const result = await searchHandler({ query: '**\/*.ts' })
 *
 * // Content search
 * const result = await searchHandler({ query: 'grep:TODO' })
 * ```
 */
export function createSearchHandler(
  storage: StorageBackend
): (input: SearchInput) => Promise<ToolResponse> {
  return async (input: SearchInput): Promise<ToolResponse> => {
    try {
      const { query, limit, path = '/' } = input

      // Determine search type based on query prefix
      let searchParams: Record<string, unknown>

      if (query.startsWith('grep:')) {
        // Content search mode
        const contentQuery = query.slice(5) // Remove 'grep:' prefix
        searchParams = {
          pattern: '**/*',
          path,
          contentSearch: contentQuery,
          limit,
        }
      } else {
        // Glob pattern search
        searchParams = {
          pattern: query,
          path,
          limit,
        }
      }

      // Delegate to fs_search implementation
      const result = await invokeFsSearch(searchParams, storage)

      return {
        content: result.content.map(item => ({
          type: item.type,
          text: 'text' in item ? item.text : '',
        })),
        isError: result.isError,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'

      return {
        content: [{ type: 'text', text: JSON.stringify({ error: errorMessage }) }],
        isError: true,
      }
    }
  }
}

// =============================================================================
// Fetch Tool
// =============================================================================

/**
 * Create a fetch handler that reads files from the storage backend.
 *
 * The fetch tool retrieves file content by path.
 *
 * @param storage - Storage backend to read from
 * @returns Fetch handler function
 *
 * @example
 * ```typescript
 * const fetchHandler = createFetchHandler(storage)
 *
 * const result = await fetchHandler({ resource: '/home/user/file.txt' })
 * ```
 */
export function createFetchHandler(
  storage: StorageBackend
): (input: FetchInput) => Promise<ToolResponse> {
  return async (input: FetchInput): Promise<ToolResponse> => {
    try {
      const { resource } = input
      const normalizedPath = normalizePath(resource)

      // Check if path exists
      if (!storage.has(normalizedPath)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `ENOENT: no such file: ${resource}` }) }],
          isError: true,
        }
      }

      const entry = storage.get(normalizedPath)

      if (!entry) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `ENOENT: no such file: ${resource}` }) }],
          isError: true,
        }
      }

      if (entry.type === 'directory') {
        // For directories, return tree view
        const treeResult = await invokeFsTree(
          { path: normalizedPath, maxDepth: 2 },
          storage as TreeStorageBackend
        )

        return {
          content: treeResult.content.map(item => ({
            type: item.type,
            text: 'text' in item ? item.text : '',
          })),
          isError: treeResult.isError,
        }
      }

      // Read file content
      const textContent = new TextDecoder().decode(entry.content)

      // Determine content type
      const contentType = inferContentType(resource)

      // Format JSON if applicable
      const formattedContent = isJsonContentType(contentType)
        ? formatJsonContent(textContent)
        : textContent

      const responseContent: Array<{ type: string; text: string }> = [
        { type: 'text', text: formattedContent },
      ]

      // Include metadata
      const metadata = {
        path: normalizedPath,
        size: entry.content.length,
        type: entry.type,
        contentType,
      }

      responseContent.push({
        type: 'text',
        text: JSON.stringify({ metadata }, null, 2),
      })

      return { content: responseContent }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'

      return {
        content: [{ type: 'text', text: JSON.stringify({ error: errorMessage }) }],
        isError: true,
      }
    }
  }
}

/**
 * Check if content type is JSON.
 */
function isJsonContentType(contentType: string): boolean {
  return contentType.includes('application/json') || contentType.includes('+json')
}

/**
 * Format JSON content with pretty printing.
 */
function formatJsonContent(content: string): string {
  try {
    const parsed = JSON.parse(content)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return content
  }
}

/**
 * Infer content type from file extension.
 */
function inferContentType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  const mimeTypes: Record<string, string> = {
    json: 'application/json',
    txt: 'text/plain',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    mjs: 'application/javascript',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    xml: 'application/xml',
    svg: 'image/svg+xml',
    md: 'text/markdown',
    mdx: 'text/mdx',
    yaml: 'text/yaml',
    yml: 'text/yaml',
  }
  return mimeTypes[ext ?? ''] ?? 'text/plain'
}

// =============================================================================
// Do Tool - uses @dotdo/mcp's createDoHandler with ai-evaluate
// =============================================================================

// Re-export createDoHandler from @dotdo/mcp for use with FsDoScope
export { createDoHandler }

// =============================================================================
// Tool Registration
// =============================================================================

/**
 * Configuration for registering the three core tools.
 */
export interface ToolsConfig {
  /** Storage backend for filesystem operations */
  storage: ExtendedFsStorage
  /** Optional permissions for the fs binding (allowWrite, allowDelete, allowedPaths) */
  fsPermissions?: FsPermissions
  /** Optional sandbox permissions for ai-evaluate (allowNetwork, allowedHosts) */
  sandboxPermissions?: DoPermissions
  /** Optional additional bindings for the do tool */
  additionalBindings?: Record<string, unknown>
  /** Optional worker environment with LOADER binding for ai-evaluate sandboxing */
  env?: SandboxEnv
}

/**
 * Create a new tool registry.
 *
 * @returns A new empty tool registry
 */
export function createToolRegistry(): ToolRegistry {
  const tools: Record<string, Tool> = {}
  const handlers: Record<string, ToolHandler> = {}

  return {
    tools,
    handlers,

    register(tool: Tool, handler: ToolHandler) {
      tools[tool.name] = tool
      handlers[tool.name] = handler
    },

    getHandler(name: string) {
      return handlers[name]
    },

    list() {
      return Object.values(tools)
    },
  }
}

/**
 * Register the three core MCP tools (search, fetch, do).
 *
 * @param config - Configuration with storage backend
 * @returns A registry with all three tools registered
 *
 * @example
 * ```typescript
 * const registry = registerTools({ storage })
 *
 * // Get tool definitions for MCP
 * const tools = registry.list()
 *
 * // Handle tool calls
 * const handler = registry.getHandler('search')
 * const result = await handler({ query: '**\/*.ts' })
 * ```
 */
export function registerTools(config: ToolsConfig): ToolRegistry {
  const { storage, fsPermissions, sandboxPermissions, additionalBindings, env } = config
  const registry = createToolRegistry()

  // Register search tool
  const searchHandler = createSearchHandler(storage)
  registry.register(searchToolSchema as Tool, searchHandler as ToolHandler)

  // Register fetch tool
  const fetchHandler = createFetchHandler(storage)
  registry.register(fetchToolSchema as Tool, fetchHandler as ToolHandler)

  // Register do tool - uses ai-evaluate for secure V8 sandbox execution
  const scope = createFsScope(storage, fsPermissions, additionalBindings, sandboxPermissions)
  const doHandler = createDoHandler(scope, env)
  registry.register(doToolSchema as Tool, doHandler as ToolHandler)

  return registry
}

/**
 * Get MCP-compatible tool definitions from a registry.
 *
 * @param registry - The tool registry
 * @returns Array of tool definitions
 */
export function getToolDefinitions(registry: ToolRegistry): Tool[] {
  return registry.list()
}

/**
 * Create a tool call handler that routes to the correct tool.
 *
 * @param registry - The tool registry to use
 * @returns A function that handles tool calls
 */
export function createToolCallHandler(registry: ToolRegistry) {
  return async (toolName: string, input: unknown) => {
    const handler = registry.getHandler(toolName)

    if (!handler) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) }],
        isError: true,
      }
    }

    return handler(input)
  }
}

// =============================================================================
// Array of Core Tools
// =============================================================================

/**
 * Array of the three core MCP tool schemas.
 */
export const coreTools = [
  searchToolSchema,
  fetchToolSchema,
  doToolSchema,
] as const
