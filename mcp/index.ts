/**
 * MCP Tools for filesystem operations
 *
 * Model Context Protocol integration for AI-assisted file operations.
 *
 * Design principles:
 * - Consistent error handling with descriptive messages
 * - Type-safe parameter handling
 * - Clear success/error response format
 * - Encoding support for binary data (base64)
 */

import type { FSx } from '../core/fsx.js'

/**
 * MCP Tool definition
 */
export interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: string; description?: string; enum?: string[] }>
    required?: string[]
  }
}

/**
 * MCP Tool result
 */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  isError?: boolean
}

// ==================== Helper Functions ====================

/**
 * Create a successful MCP response
 */
function success(text: string): McpToolResult {
  return {
    content: [{ type: 'text', text }],
  }
}

/**
 * Create an error MCP response
 */
function error(message: string): McpToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  }
}

/**
 * Safely extract a string parameter
 */
function getString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string') {
    throw new Error(`Missing or invalid parameter: ${key}`)
  }
  return value
}

/**
 * Safely extract an optional string parameter
 */
function getOptionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`Invalid parameter type for: ${key}`)
  }
  return value
}

/**
 * Safely extract an optional boolean parameter
 */
function getOptionalBoolean(params: Record<string, unknown>, key: string): boolean {
  const value = params[key]
  return value === true
}

/**
 * Safely extract an optional number parameter
 */
function getOptionalNumber(params: Record<string, unknown>, key: string, defaultValue: number): number {
  const value = params[key]
  if (value === undefined || value === null) return defaultValue
  if (typeof value !== 'number') {
    throw new Error(`Invalid parameter type for: ${key}`)
  }
  return value
}

/**
 * Decode base64 string to Uint8Array
 */
function decodeBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * Filesystem MCP tools
 */
export const fsTools: McpTool[] = [
  {
    name: 'fs_read',
    description: 'Read the contents of a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' },
        encoding: { type: 'string', description: 'Encoding (utf-8, base64)', enum: ['utf-8', 'base64'] },
      },
      required: ['path'],
    },
  },
  {
    name: 'fs_write',
    description: 'Write content to a file (creates or overwrites)',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Content to write' },
        encoding: { type: 'string', description: 'Encoding of content', enum: ['utf-8', 'base64'] },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'fs_append',
    description: 'Append content to a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file' },
        content: { type: 'string', description: 'Content to append' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'fs_delete',
    description: 'Delete a file or directory',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to delete' },
        recursive: { type: 'boolean', description: 'Delete directories recursively' },
      },
      required: ['path'],
    },
  },
  {
    name: 'fs_move',
    description: 'Move or rename a file or directory',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source path' },
        destination: { type: 'string', description: 'Destination path' },
      },
      required: ['source', 'destination'],
    },
  },
  {
    name: 'fs_copy',
    description: 'Copy a file',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source path' },
        destination: { type: 'string', description: 'Destination path' },
      },
      required: ['source', 'destination'],
    },
  },
  {
    name: 'fs_list',
    description: 'List files and directories in a path',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list' },
        recursive: { type: 'boolean', description: 'List recursively' },
        withDetails: { type: 'boolean', description: 'Include file details (size, modified date)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'fs_mkdir',
    description: 'Create a directory',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to create' },
        recursive: { type: 'boolean', description: 'Create parent directories if needed' },
      },
      required: ['path'],
    },
  },
  {
    name: 'fs_stat',
    description: 'Get file or directory information',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to get info for' },
      },
      required: ['path'],
    },
  },
  {
    name: 'fs_exists',
    description: 'Check if a file or directory exists',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to check' },
      },
      required: ['path'],
    },
  },
  {
    name: 'fs_search',
    description: 'Search for files by name pattern or content',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to search in' },
        pattern: { type: 'string', description: 'File name pattern (glob)' },
        content: { type: 'string', description: 'Search for files containing this text' },
        recursive: { type: 'boolean', description: 'Search recursively' },
      },
      required: ['path'],
    },
  },
  {
    name: 'fs_tree',
    description: 'Get a tree view of directory structure',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Root directory path' },
        depth: { type: 'number', description: 'Maximum depth (default: 3)' },
      },
      required: ['path'],
    },
  },
]

// ==================== Tool Handlers ====================

/**
 * Tool handler type
 */
type ToolHandler = (fs: FSx, params: Record<string, unknown>) => Promise<McpToolResult>

/**
 * Tool handlers - implements the core filesystem operations
 */
const handlers: Record<string, ToolHandler> = {
  /**
   * Read file contents with optional encoding
   *
   * Encoding options:
   * - utf-8 (default): Returns file contents as UTF-8 string
   * - base64: Returns file contents encoded as base64 string
   */
  async fs_read(fs, params) {
    try {
      const path = getString(params, 'path')
      const encoding = getOptionalString(params, 'encoding') ?? 'utf-8'

      const content = await fs.readFile(path, encoding as 'utf-8' | 'base64')

      // FSx.readFile returns string for both utf-8 and base64 encodings
      // For utf-8: decoded text, for base64: base64-encoded string
      const text = typeof content === 'string' ? content : '[binary data]'

      return success(text)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return error(message)
    }
  },

  /**
   * Write content to a file
   *
   * Encoding options:
   * - utf-8 (default): Content is written as UTF-8 text
   * - base64: Content is base64-decoded before writing (for binary data)
   */
  async fs_write(fs, params) {
    try {
      const path = getString(params, 'path')
      const content = getString(params, 'content')
      const encoding = getOptionalString(params, 'encoding')

      // If encoding is base64, decode the content before writing
      const dataToWrite: string | Uint8Array = encoding === 'base64' ? decodeBase64(content) : content

      await fs.writeFile(path, dataToWrite, { flag: 'w' })

      return success(`Successfully wrote to ${path}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return error(message)
    }
  },

  /**
   * Append content to a file
   *
   * Creates the file if it doesn't exist.
   * Appends to the end if it does exist.
   */
  async fs_append(fs, params) {
    try {
      const path = getString(params, 'path')
      const content = getString(params, 'content')

      await fs.appendFile(path, content)

      return success(`Successfully appended to ${path}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return error(message)
    }
  },

  /**
   * Delete a file or directory
   *
   * Options:
   * - recursive: If true, delete directories and their contents recursively
   *
   * Note: Uses force: true to silently ignore non-existent paths
   */
  async fs_delete(fs, params) {
    try {
      const path = getString(params, 'path')
      const recursive = getOptionalBoolean(params, 'recursive')

      await fs.rm(path, { recursive, force: true })

      return success(`Successfully deleted ${path}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return error(message)
    }
  },

  /**
   * Move or rename a file or directory
   */
  async fs_move(fs, params) {
    try {
      const source = getString(params, 'source')
      const destination = getString(params, 'destination')

      await fs.rename(source, destination)

      return success(`Successfully moved ${source} to ${destination}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return error(message)
    }
  },

  /**
   * Copy a file
   */
  async fs_copy(fs, params) {
    try {
      const source = getString(params, 'source')
      const destination = getString(params, 'destination')

      await fs.copyFile(source, destination)

      return success(`Successfully copied ${source} to ${destination}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return error(message)
    }
  },

  /**
   * List directory contents
   *
   * Options:
   * - recursive: List subdirectories recursively
   * - withDetails: Include file type (d=directory, l=symlink, -=file)
   */
  async fs_list(fs, params) {
    try {
      const path = getString(params, 'path')
      const recursive = getOptionalBoolean(params, 'recursive')
      const withDetails = getOptionalBoolean(params, 'withDetails')

      if (withDetails) {
        const entries = (await fs.readdir(path, { withFileTypes: true, recursive })) as Array<{
          name: string
          isDirectory: () => boolean
          isSymbolicLink: () => boolean
        }>
        const lines = entries.map((entry) => {
          const type = entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : '-'
          return `${type} ${entry.name}`
        })
        return success(lines.join('\n') || '(empty)')
      } else {
        const entries = (await fs.readdir(path, { recursive })) as string[]
        return success(entries.join('\n') || '(empty)')
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return error(message)
    }
  },

  /**
   * Create a directory
   *
   * Options:
   * - recursive: Create parent directories if they don't exist
   */
  async fs_mkdir(fs, params) {
    try {
      const path = getString(params, 'path')
      const recursive = getOptionalBoolean(params, 'recursive')

      await fs.mkdir(path, { recursive })

      return success(`Successfully created directory ${path}`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return error(message)
    }
  },

  /**
   * Get file or directory information
   */
  async fs_stat(fs, params) {
    try {
      const path = getString(params, 'path')

      const stats = await fs.stat(path)
      const type = stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file'
      const info = [
        `Type: ${type}`,
        `Size: ${stats.size} bytes`,
        `Mode: ${stats.mode.toString(8)}`,
        `Modified: ${stats.mtime.toISOString()}`,
        `Created: ${stats.birthtime.toISOString()}`,
      ]

      return success(info.join('\n'))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return error(message)
    }
  },

  /**
   * Check if a file or directory exists
   */
  async fs_exists(fs, params) {
    try {
      const path = getString(params, 'path')

      const exists = await fs.exists(path)

      return success(exists ? `${path} exists` : `${path} does not exist`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return error(message)
    }
  },

  /**
   * Search for files by name pattern
   *
   * Options:
   * - pattern: Glob pattern to match file names (* = any chars, ? = single char)
   * - recursive: Search subdirectories
   *
   * Note: Content search is not yet implemented
   */
  async fs_search(fs, params) {
    try {
      const path = getString(params, 'path')
      const pattern = getOptionalString(params, 'pattern')
      const recursive = getOptionalBoolean(params, 'recursive')

      const entries = (await fs.readdir(path, { recursive })) as string[]

      let matches = entries
      if (pattern) {
        // Convert glob pattern to regex
        const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.')
        const regex = new RegExp(regexPattern)
        matches = matches.filter((e) => regex.test(e))
      }

      return success(matches.join('\n') || 'No matches found')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return error(message)
    }
  },

  /**
   * Get a tree view of directory structure
   *
   * Options:
   * - depth: Maximum depth to traverse (default: 3)
   */
  async fs_tree(fs, params) {
    try {
      const path = getString(params, 'path')
      const maxDepth = getOptionalNumber(params, 'depth', 3)

      const buildTree = async (currentPath: string, depth: number, prefix: string): Promise<string[]> => {
        if (depth > maxDepth) return []

        const entries = (await fs.readdir(currentPath, { withFileTypes: true })) as Array<{
          name: string
          path: string
          isDirectory: () => boolean
        }>
        const lines: string[] = []

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]
          const isLast = i === entries.length - 1
          const connector = isLast ? '└── ' : '├── '
          const icon = entry.isDirectory() ? '📁' : '📄'

          lines.push(`${prefix}${connector}${icon} ${entry.name}`)

          if (entry.isDirectory()) {
            const newPrefix = prefix + (isLast ? '    ' : '│   ')
            const subLines = await buildTree(entry.path, depth + 1, newPrefix)
            lines.push(...subLines)
          }
        }

        return lines
      }

      const tree = await buildTree(path, 1, '')
      const output = `📁 ${path}\n${tree.join('\n')}`

      return success(output)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return error(message)
    }
  },
}

// ==================== Public API ====================

/**
 * Invoke an MCP tool by name
 *
 * @param name - Tool name (e.g., 'fs_read', 'fs_write')
 * @param params - Tool parameters
 * @param fs - FSx filesystem instance
 * @returns MCP tool result with content and optional error flag
 */
export async function invokeTool(name: string, params: Record<string, unknown>, fs: FSx): Promise<McpToolResult> {
  const handler = handlers[name]
  if (!handler) {
    return error(`Unknown tool: ${name}`)
  }
  return handler(fs, params)
}

/**
 * Register a custom tool
 */
export function registerTool(
  tool: McpTool & {
    handler: (fs: FSx, params: Record<string, unknown>) => Promise<McpToolResult>
  }
): void {
  fsTools.push(tool)
  handlers[tool.name] = tool.handler
}
