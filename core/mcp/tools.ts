/**
 * MCP Tools: search, fetch, do
 *
 * This module provides the three core MCP tools for filesystem operations:
 * - search: Glob/grep file search
 * - fetch: Read file content by path
 * - do: Execute code with fs binding available
 *
 * These tools replace the 12 individual fs_* tools with a simpler, more
 * flexible pattern that enables sandboxed code execution with filesystem access.
 *
 * @module core/mcp/tools
 */

import type { StorageBackend } from './shared'
import { normalizePath } from './shared'
import { invokeFsSearch } from './fs-search'
import { invokeFsTree, type TreeStorageBackend } from './fs-tree'
import {
  createFsScope,
  type ExtendedFsStorage,
  type FsDoScope,
  type FsPermissions,
} from './scope'

// =============================================================================
// Types
// =============================================================================

/**
 * MCP tool response format.
 */
export interface ToolResponse {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}

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

/**
 * Input parameters for the do tool.
 */
export interface DoInput {
  /** TypeScript/JavaScript code to execute */
  code: string
}

/**
 * Result from the do tool execution.
 */
export interface DoResult {
  success: boolean
  value?: unknown
  logs: Array<{ level: string; message: string; timestamp: number }>
  error?: string
  duration: number
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

      // Use existing fs_search implementation
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
// Do Tool
// =============================================================================

/**
 * Create a do handler that executes code in a sandboxed environment.
 *
 * The do tool provides access to the `fs` binding for filesystem operations.
 * Code is executed in isolation with only the provided bindings available.
 *
 * @param scope - The DoScope configuration with fs binding
 * @returns Do handler function
 *
 * @example
 * ```typescript
 * const scope = createFsScope(storage)
 * const doHandler = createDoHandler(scope)
 *
 * const result = await doHandler({
 *   code: `
 *     const files = await fs.list('/home')
 *     return files.length
 *   `
 * })
 * ```
 */
export function createDoHandler(
  scope: FsDoScope
): (input: DoInput) => Promise<ToolResponse> {
  return async (input: DoInput): Promise<ToolResponse> => {
    const startTime = Date.now()
    const logs: Array<{ level: string; message: string; timestamp: number }> = []

    try {
      // Create console object that captures logs
      const sandboxConsole = {
        log: (...args: unknown[]) => logs.push({
          level: 'log',
          message: args.map(String).join(' '),
          timestamp: Date.now(),
        }),
        error: (...args: unknown[]) => logs.push({
          level: 'error',
          message: args.map(String).join(' '),
          timestamp: Date.now(),
        }),
        warn: (...args: unknown[]) => logs.push({
          level: 'warn',
          message: args.map(String).join(' '),
          timestamp: Date.now(),
        }),
        info: (...args: unknown[]) => logs.push({
          level: 'info',
          message: args.map(String).join(' '),
          timestamp: Date.now(),
        }),
      }

      // Build the code to execute with explicit parameter destructuring
      // This ensures bindings are available as local variables
      const wrappedCode = `
        return (async function(bindings) {
          const { fs, console } = bindings;
          ${input.code}
        })(bindings);
      `

      // Create function that takes bindings as a parameter
      const fn = new Function('bindings', wrappedCode)
      const result = await fn({
        ...scope.bindings,
        console: sandboxConsole,
      })

      const duration = Date.now() - startTime

      const doResult: DoResult = {
        success: true,
        value: result,
        logs,
        duration,
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(doResult, null, 2) }],
        isError: false,
      }
    } catch (error) {
      const duration = Date.now() - startTime
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'

      const doResult: DoResult = {
        success: false,
        logs,
        error: errorMessage,
        duration,
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(doResult, null, 2) }],
        isError: true,
      }
    }
  }
}

// =============================================================================
// Tool Registration
// =============================================================================

/**
 * Tool definition compatible with MCP protocol.
 */
export interface Tool {
  name: string
  description: string
  inputSchema: {
    type: string
    properties: Record<string, unknown>
    required: string[]
  }
}

/**
 * Tool handler function type.
 */
export type ToolHandler = (input: unknown) => Promise<ToolResponse>

/**
 * Tool registry containing tools and their handlers.
 */
export interface ToolRegistry {
  /** Map of tool name to tool definition */
  tools: Record<string, Tool>
  /** Map of tool name to handler function */
  handlers: Record<string, ToolHandler>
  /** Register a new tool */
  register: (tool: Tool, handler: ToolHandler) => void
  /** Get handler for a tool by name */
  getHandler: (name: string) => ToolHandler | undefined
  /** List all registered tools */
  list: () => Tool[]
}

/**
 * Configuration for registering the three core tools.
 */
export interface ToolsConfig {
  /** Storage backend for filesystem operations */
  storage: ExtendedFsStorage
  /** Optional permissions for the fs binding */
  permissions?: FsPermissions
  /** Optional additional bindings for the do tool */
  additionalBindings?: Record<string, unknown>
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
  const { storage, permissions, additionalBindings } = config
  const registry = createToolRegistry()

  // Register search tool
  const searchHandler = createSearchHandler(storage)
  registry.register(searchToolSchema as Tool, searchHandler as ToolHandler)

  // Register fetch tool
  const fetchHandler = createFetchHandler(storage)
  registry.register(fetchToolSchema as Tool, fetchHandler as ToolHandler)

  // Register do tool
  const scope = createFsScope(storage, permissions, additionalBindings)
  const doHandler = createDoHandler(scope)
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
