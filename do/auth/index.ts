/**
 * @fileoverview Authentication and multi-tenancy module for fsx
 *
 * This module provides comprehensive authentication and authorization for the
 * fsx filesystem service, including:
 *
 * - **JWT Authentication**: Validate JWT tokens with configurable algorithms
 * - **API Key Authentication**: Generate and validate API keys with permissions
 * - **Multi-tenancy**: Isolate each tenant's files in their own namespace
 * - **Permission Checks**: Path-based permissions with glob pattern support
 *
 * @category Application
 * @module do/auth
 *
 * @example JWT Authentication
 * ```typescript
 * import { createAuthMiddleware, getAuthContext } from 'fsx/do/auth'
 *
 * // Configure auth middleware
 * const authMiddleware = createAuthMiddleware({
 *   required: true,
 *   jwt: {
 *     secret: 'your-secret-key',
 *     issuer: 'https://auth.example.com',
 *     audience: 'fsx-api'
 *   }
 * })
 *
 * // Use in Hono app
 * app.use('*', authMiddleware)
 *
 * // Access auth context in handlers
 * app.get('/files/*', (c) => {
 *   const auth = getAuthContext(c)
 *   console.log(auth.tenantId)
 * })
 * ```
 *
 * @example API Key Authentication
 * ```typescript
 * import { generateAPIKey, createAuthMiddleware, MemoryAPIKeyStore } from 'fsx/do/auth'
 *
 * // Create API key store
 * const apiKeyStore = new MemoryAPIKeyStore()
 *
 * // Generate API key for a tenant
 * const { key, metadata } = await generateAPIKey({
 *   tenantId: 'tenant-123',
 *   name: 'Production Key',
 *   permissions: [
 *     { type: 'read', scope: { path: '/**' } },
 *     { type: 'write', scope: { path: '/data/**' } }
 *   ]
 * })
 * await apiKeyStore.set(metadata)
 *
 * // Configure auth middleware with API key support
 * const authMiddleware = createAuthMiddleware({
 *   required: true,
 *   apiKey: { headerName: 'X-API-Key' }
 * }, apiKeyStore)
 * ```
 *
 * @example Multi-tenant File Access
 * ```typescript
 * import { enforceTenantIsolation, requirePermissionMiddleware } from 'fsx/do/auth'
 *
 * // Tenant isolation - paths automatically scoped to tenant namespace
 * app.use('/fs/*', enforceTenantIsolation(
 *   (c) => '/' + c.req.param('*'),
 *   (c, resolved) => c.set('fsPath', resolved)
 * ))
 *
 * // Permission check middleware
 * app.post('/fs/*', requirePermissionMiddleware('write', (c) => c.get('fsPath')))
 * ```
 */

// Types
export {
  // Auth method types
  type AuthMethod,
  // JWT types
  type JWTPayload,
  type JWTConfig,
  // API key types
  type APIKey,
  type APIKeyConfig,
  type CreateAPIKeyOptions,
  type CreateAPIKeyResult,
  // Permission types
  type PermissionType,
  type PermissionScope,
  type Permission,
  type UserRole,
  type PermissionCheckResult,
  type PathCheckOptions,
  ROLE_PERMISSIONS,
  // Tenant types
  type Tenant,
  type CreateTenantOptions,
  // Auth context types
  type AuthContext,
  type UnauthenticatedContext,
  type FullAuthContext,
  // Config types
  type AuthConfig,
  // Error types
  type AuthErrorCode,
  AuthError,
} from './types.js'

// JWT validation
export { validateJWT, extractBearerToken, decodeJWTUnsafe } from './jwt.js'

// API key management
export {
  generateAPIKey,
  validateAPIKey,
  extractAPIKey,
  extractKeyId,
  hashAPIKey,
  type APIKeyStore,
  MemoryAPIKeyStore,
  DEFAULT_API_KEY_HEADER,
  DEFAULT_API_KEY_PREFIX,
} from './api-key.js'

// Permission checking
export {
  matchPath,
  checkPermission,
  requirePermission,
  getEffectivePermissions,
  resolveTenantPath,
  isPathInTenantNamespace,
  toTenantRelativePath,
  // Permission builders
  readPermission,
  writePermission,
  deletePermission,
  adminPermission,
  fullAccessPermissions,
} from './permissions.js'

// Middleware
export {
  createAuthMiddleware,
  getAuthContext,
  requireAuthContext,
  requireTenantId,
  requirePermissionMiddleware,
  enforceTenantIsolation,
  handleAuthError,
} from './middleware.js'

// Tenant management
export {
  type TenantStore,
  generateTenantId,
  defaultTenantRootPath,
  createTenant,
  getTenant,
  requireTenant,
  suspendTenant,
  reactivateTenant,
  deleteTenant,
  MemoryTenantStore,
  SQLiteTenantStore,
  TENANT_TABLE_SCHEMA,
} from './tenant.js'

// OAuth.do integration
export {
  // JWT verification
  verifyJWT,
  // Token extraction
  extractToken,
  extractBearerToken as extractOAuthBearerToken,
  // Session caching
  OAuthSessionCache,
  // Scope validation
  hasScope,
  checkScopeForOperation,
  // OAuth context
  getOAuthContext,
  requireOAuthContext,
  // Middleware
  createOAuthMiddleware,
  requireOAuthScope,
  // Bridge functions
  scopesToPermissions,
  oauthToAuthContext,
  // Error handling
  OAuthError,
  mapOAuthError,
  // Types
  type OAuthJWTPayload,
  type OAuthScope,
  type JWTVerifyResult,
  type CachedVerifyResult,
  type VerifyJWTOptions,
  type OAuthSessionCacheOptions,
  type ScopeCheckResult,
  type OAuthContext,
  type OAuthMiddlewareOptions,
} from './oauth.js'

// MCP tool authentication middleware
export {
  // Tool classification
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  isReadOnlyTool,
  isWriteTool,
  getRequiredScope,
  // MCP auth context
  getMCPAuthContext,
  requireMCPAuthContext,
  // Middleware
  createMCPAuthMiddleware,
  enforceMCPToolAuth,
  // Tool auth checking
  checkToolAuth,
  // Auth context conversion
  toToolHandlerAuthContext,
  getToolAuthFromContext,
  // Types
  type MCPAuthContext,
  type MCPAuthMiddlewareOptions,
  type ToolAuthCheckResult,
  type ToolHandlerAuthContext,
} from './mcp-middleware.js'
