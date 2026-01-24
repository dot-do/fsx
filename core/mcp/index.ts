/**
 * MCP (Model Context Protocol) Tools for fsx
 *
 * This module provides filesystem tools for AI-assisted file operations
 * via the Model Context Protocol (MCP).
 *
 * ## Core Tools (3-Tool Architecture)
 *
 * The MCP interface exposes exactly three tools:
 *
 * - `search` - Search for files using glob patterns or content search
 * - `fetch` - Read file content by path
 * - `do` - Execute code with fs binding available
 *
 * The `fs` binding in the `do` tool provides:
 * - fs.read(path) - Read file contents
 * - fs.write(path, content) - Write content to a file
 * - fs.append(path, content) - Append content to a file
 * - fs.delete(path) - Delete a file or directory
 * - fs.move(from, to) - Move/rename a file or directory
 * - fs.copy(from, to) - Copy a file
 * - fs.mkdir(path, options?) - Create a directory
 * - fs.stat(path) - Get file/directory statistics
 * - fs.list(path, options?) - List directory contents
 * - fs.tree(path, options?) - Generate directory tree
 * - fs.search(pattern, options?) - Search for files
 * - fs.exists(path) - Check if path exists
 *
 * ## Tool Infrastructure
 *
 * - `registerTools()` - Register search/fetch/do tools with fs binding
 * - `registerTool()` - Register custom tools
 * - `unregisterTool()` - Remove tools from registry
 * - `invokeTool()` - Dispatch to tool handler by name
 * - `getToolRegistry()` - Get registry interface
 *
 * ## Internal Modules
 *
 * The underlying fs operations (invokeFsSearch, invokeFsList, etc.) are
 * still exported for use by the fs binding implementation and testing,
 * but are not registered as MCP tools.
 *
 * @module core/mcp
 */

// Shared utilities and types
export {
  // Types
  type McpToolResult,
  type StorageBackend,
  type StorageEntry,
  type ExtendedStorageBackend,
  type TraversalEntry,
  type TraversalOptions,
  // Path utilities
  normalizePath,
  joinPath,
  getRelativePath,
  isPathTraversal,
  // Symlink handling
  resolveSymlink,
  // Entry helpers
  getEntrySize,
  getEntryMtime,
  collectDirectoryEntries,
  // Result helpers
  errorResult,
  successResult,
} from './shared'

// fs_search - Glob pattern file search (used internally by search tool and fs binding)
export {
  invokeFsSearch,
  // Types
  type FsSearchOptions,
  type SearchResultItem,
  // Utilities (exported for testing)
  shouldExclude,
  countContentMatches,
  searchDirectory,
} from './fs-search'

// fs_list - Directory listing (used internally by fs binding)
export {
  invokeFsList,
  // Types
  type FsListOptions,
} from './fs-list'

// fs_mkdir - Directory creation (used internally by fs binding)
export {
  invokeFsMkdir,
  // Types
  type FsMkdirOptions,
} from './fs-mkdir'

// fs_stat - File/directory statistics (used internally by fs binding)
export {
  invokeFsStat,
  invokeFsLstat,
  fsLstatToolSchema,
  // Types
  type McpStatResult,
  type StatFileEntry,
  type StatStorageBackend,
  type TypeFlags,
  type BuildStatOptions,
  type SymlinkResolution,
  // Utilities (exported for fs_list integration)
  buildStatResult,
  detectFileType,
  resolveSymlinkChain,
  getContentSize,
  calculateBlocks,
  isPathTraversal as isStatPathTraversal,
  // Constants
  DEFAULT_BLOCK_SIZE,
  BLOCKS_UNIT_SIZE,
  MAX_SYMLINK_DEPTH,
} from './fs-stat'

// fs_tree - Directory tree visualization (used internally by fetch tool and fs binding)
export {
  invokeFsTree,
  formatSize,
  // Types
  type FsTreeOptions,
  type TreeNode,
} from './fs-tree'

// Tool registry - Infrastructure for tool registration and invocation
export {
  // Core registry functions
  registerTool,
  unregisterTool,
  invokeTool,
  getToolRegistry,
  clearToolRegistry,
  // Middleware support
  useMiddleware,
  clearMiddleware,
  // Utility functions
  isBuiltinTool,
  // fsTools array with built-in tools (search, fetch, do)
  fsTools,
  // Types
  type PropertySchema,
  type InputSchema,
  type McpToolSchema,
  type McpToolHandler,
  type McpTool,
  type ToolRegistry,
  type InvokeToolOptions,
  type ToolContext,
  type ToolMiddleware,
  // Tool schemas (core tools are registered; legacy schemas exported for compatibility)
  fsSearchToolSchema,
  fsListToolSchema,
  fsTreeToolSchema,
  fsStatToolSchema,
  fsMkdirToolSchema,
  fsReadToolSchema,
  fsWriteToolSchema,
  fsAppendToolSchema,
  fsDeleteToolSchema,
  fsMoveToolSchema,
  fsCopyToolSchema,
  fsExistsToolSchema,
} from './tool-registry'

// Authentication middleware for MCP tools
export {
  // Middleware factory
  createMCPAuthMiddleware,
  defaultAuthMiddleware,
  // Tool classification
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  isReadOnlyTool,
  isWriteTool,
  getRequiredScope,
  // Auth checking
  checkToolAuth,
  // Helper functions
  createAuthMetadata,
  createAnonymousAuthContext,
  // Types
  type FileScope,
  type MCPToolAuthContext,
  type AuthMiddlewareConfig,
  type ToolAuthCheckResult,
} from './auth-middleware'

// =============================================================================
// Core Tools: search, fetch, do with fs binding
// =============================================================================

// DoScope for sandboxed code execution with fs binding
export {
  // Scope creation
  createFsScope,
  createFsBinding,
  // Type definitions for LLM
  FS_BINDING_TYPES,
  // Types
  type FsDoScope,
  type FsBinding,
  type FsPermissions,
  type ExtendedFsStorage,
  type FsStatResult,
  type FsListEntry,
  type FsListOptions as FsScopeListOptions,
  type FsTreeOptions as FsScopeTreeOptions,
  type FsSearchOptions as FsScopeSearchOptions,
  type FsMkdirOptions as FsScopeMkdirOptions,
} from './scope'

// Core tools: search, fetch, do
export {
  // Tool handlers
  createSearchHandler,
  createFetchHandler,
  createDoHandler,
  // Tool registration
  registerTools,
  createToolRegistry as createCoreToolRegistry,
  getToolDefinitions,
  createToolCallHandler,
  // Tool schemas
  searchToolSchema,
  fetchToolSchema,
  doToolSchema,
  coreTools,
  // Types
  type ToolResponse,
  type SearchInput,
  type FetchInput,
  type DoInput,
  type DoResult,
  type Tool,
  type ToolHandler,
  /** @deprecated Use ToolRegistry from tool-registry instead for the global registry */
  type ToolRegistry as CoreToolRegistry,
  type ToolsConfig,
} from './tools'
