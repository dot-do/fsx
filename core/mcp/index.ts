/**
 * MCP (Model Context Protocol) Tools for fsx
 *
 * This module provides filesystem tools for AI-assisted file operations
 * via the Model Context Protocol (MCP).
 *
 * ## Core Tools (Recommended Pattern)
 *
 * The recommended pattern uses three core tools with an fs binding:
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
 * ## Legacy Tools (Backward Compatible)
 *
 * Individual fs_* tools are still available for backward compatibility:
 * - `fs_search` - Glob pattern file search with content filtering
 * - `fs_list` - Directory listing with recursive, pattern filtering, and pagination
 * - `fs_mkdir` - Directory creation with recursive and permission support
 * - `fs_stat` - File/directory statistics with symlink handling
 * - `fs_lstat` - File/directory statistics (does not follow symlinks)
 * - `fs_tree` - Directory tree visualization with ASCII and JSON output
 * - `fs_read` - Read file contents
 * - `fs_write` - Write content to a file
 * - `fs_append` - Append content to a file
 * - `fs_delete` - Delete a file or directory
 * - `fs_move` - Move/rename a file or directory
 * - `fs_copy` - Copy a file
 * - `fs_exists` - Check if a file or directory exists
 *
 * ## Tool Infrastructure
 *
 * - `registerTools()` - Register search/fetch/do tools with fs binding
 * - `createToolRegistry()` - Create a new tool registry
 * - `registerTool()` - Register custom tools
 * - `unregisterTool()` - Remove tools from registry
 * - `invokeTool()` - Dispatch to tool handler by name
 * - `getToolRegistry()` - Get registry interface
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

// fs_search - Glob pattern file search
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

// fs_list - Directory listing
export {
  invokeFsList,
  // Types
  type FsListOptions,
} from './fs-list'

// fs_mkdir - Directory creation
export {
  invokeFsMkdir,
  // Types
  type FsMkdirOptions,
} from './fs-mkdir'

// fs_stat - File/directory statistics
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

// fs_tree - Directory tree visualization
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
  // fsTools array with all built-in tools
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
  // All tool schemas
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
// Core Tools Pattern: search, fetch, do with fs binding
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
  type ToolRegistry as CoreToolRegistry,
  type ToolsConfig,
} from './tools'
