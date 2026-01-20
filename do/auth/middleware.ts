/**
 * @fileoverview Authentication middleware for fsx HTTP endpoints
 *
 * Provides Hono middleware for JWT and API key authentication with
 * multi-tenancy support and permission checking.
 *
 * @category Application
 * @module do/auth/middleware
 */

import { Context, MiddlewareHandler, Next } from 'hono'
import {
  AuthError,
  type AuthConfig,
  type AuthContext,
  type FullAuthContext,
  type Permission,
  type Tenant,
  type UnauthenticatedContext,
  ROLE_PERMISSIONS,
} from './types.js'
import { validateJWT, extractBearerToken } from './jwt.js'
import { extractAPIKey, extractKeyId, validateAPIKey, type APIKeyStore } from './api-key.js'
import { checkPermission, resolveTenantPath, type PathCheckOptions } from './permissions.js'

// ============================================================================
// CONTEXT KEYS
// ============================================================================

/** Key for storing auth context in Hono context */
const AUTH_CONTEXT_KEY = 'auth'

// ============================================================================
// MIDDLEWARE FACTORY
// ============================================================================

/**
 * Create authentication middleware for Hono
 *
 * @param config - Authentication configuration
 * @param apiKeyStore - Optional API key store for API key authentication
 * @param tenantResolver - Optional function to resolve tenant from ID
 * @returns Hono middleware handler
 *
 * @example
 * ```typescript
 * const app = new Hono()
 *
 * // Configure auth middleware
 * app.use('*', createAuthMiddleware({
 *   required: true,
 *   jwt: {
 *     secret: env.JWT_SECRET,
 *     issuer: 'https://auth.example.com'
 *   },
 *   apiKey: {
 *     headerName: 'X-API-Key'
 *   }
 * }, apiKeyStore))
 *
 * // Protected route
 * app.get('/files/*', (c) => {
 *   const auth = getAuthContext(c)
 *   // ... handle request with auth context
 * })
 * ```
 */
export function createAuthMiddleware(
  config: AuthConfig,
  apiKeyStore?: APIKeyStore,
  tenantResolver?: (tenantId: string) => Promise<Tenant | null>
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname

    // Check if path is public (no auth required)
    if (config.publicPaths?.some((p) => matchPublicPath(path, p))) {
      const unauthContext: UnauthenticatedContext = {
        method: 'none',
        authenticated: false,
        permissions: [],
      }
      c.set(AUTH_CONTEXT_KEY, unauthContext)
      return next()
    }

    try {
      // Try JWT authentication first
      const bearerToken = extractBearerToken(c.req.header('Authorization') ?? null)
      if (bearerToken && config.jwt) {
        const authContext = await authenticateJWT(bearerToken, config, tenantResolver)
        c.set(AUTH_CONTEXT_KEY, authContext)
        return next()
      }

      // Try API key authentication
      const apiKey = extractAPIKey(c.req.raw, config.apiKey)
      if (apiKey && apiKeyStore) {
        const authContext = await authenticateAPIKey(apiKey, config, apiKeyStore, tenantResolver)
        c.set(AUTH_CONTEXT_KEY, authContext)
        return next()
      }

      // No authentication provided
      if (config.required) {
        throw new AuthError('AUTH_REQUIRED', 'Authentication required')
      }

      // Set default unauthenticated context
      const unauthContext: UnauthenticatedContext = {
        method: 'none',
        authenticated: false,
        permissions: [],
      }
      c.set(AUTH_CONTEXT_KEY, unauthContext)
      return next()
    } catch (error) {
      if (error instanceof AuthError) {
        return c.json(
          {
            code: error.code,
            message: error.message,
          },
          error.statusCode as 401 | 403
        )
      }
      throw error
    }
  }
}

/**
 * Match a path against a public path pattern
 */
function matchPublicPath(path: string, pattern: string): boolean {
  // Simple prefix matching for now
  if (pattern.endsWith('*')) {
    return path.startsWith(pattern.slice(0, -1))
  }
  return path === pattern
}

// ============================================================================
// AUTHENTICATION HANDLERS
// ============================================================================

/**
 * Authenticate using JWT token
 */
async function authenticateJWT(
  token: string,
  config: AuthConfig,
  tenantResolver?: (tenantId: string) => Promise<Tenant | null>
): Promise<AuthContext> {
  const jwtConfig = config.jwt!
  const payload = await validateJWT(token, jwtConfig)

  // Resolve tenant if resolver provided
  let tenant: Tenant | undefined
  if (tenantResolver) {
    tenant = (await tenantResolver(payload.tenant_id)) ?? undefined
    if (!tenant) {
      throw new AuthError('TENANT_NOT_FOUND', `Tenant ${payload.tenant_id} not found`)
    }
    if (tenant.status === 'suspended') {
      throw new AuthError('TENANT_SUSPENDED', `Tenant ${payload.tenant_id} is suspended`)
    }
    if (tenant.status === 'deleted') {
      throw new AuthError('TENANT_NOT_FOUND', `Tenant ${payload.tenant_id} not found`)
    }
  }

  // Get permissions from payload or derive from role
  let permissions: Permission[] = payload.permissions ?? []
  if (payload.role && ROLE_PERMISSIONS[payload.role]) {
    permissions = [...permissions, ...ROLE_PERMISSIONS[payload.role]]
  }

  return {
    method: 'jwt',
    authenticated: true,
    userId: payload.sub,
    tenantId: payload.tenant_id,
    tenant,
    permissions,
    role: payload.role,
    jwtPayload: payload,
  }
}

/**
 * Authenticate using API key
 */
async function authenticateAPIKey(
  key: string,
  config: AuthConfig,
  apiKeyStore: APIKeyStore,
  tenantResolver?: (tenantId: string) => Promise<Tenant | null>
): Promise<AuthContext> {
  // Extract key ID from the full key
  const keyId = extractKeyId(key, config.apiKey)
  if (!keyId) {
    throw new AuthError('INVALID_API_KEY', 'Invalid API key format')
  }

  // Look up the key
  const storedKey = await apiKeyStore.get(keyId)
  if (!storedKey) {
    throw new AuthError('INVALID_API_KEY', 'API key not found')
  }

  // Validate the key
  await validateAPIKey(key, storedKey, config.apiKey)

  // Update last used timestamp
  await apiKeyStore.updateLastUsed(keyId, Date.now())

  // Resolve tenant if resolver provided
  let tenant: Tenant | undefined
  if (tenantResolver) {
    tenant = (await tenantResolver(storedKey.tenantId)) ?? undefined
    if (!tenant) {
      throw new AuthError('TENANT_NOT_FOUND', `Tenant ${storedKey.tenantId} not found`)
    }
    if (tenant.status === 'suspended') {
      throw new AuthError('TENANT_SUSPENDED', `Tenant ${storedKey.tenantId} is suspended`)
    }
    if (tenant.status === 'deleted') {
      throw new AuthError('TENANT_NOT_FOUND', `Tenant ${storedKey.tenantId} not found`)
    }
  }

  return {
    method: 'api-key',
    authenticated: true,
    tenantId: storedKey.tenantId,
    tenant,
    permissions: storedKey.permissions,
    apiKeyId: storedKey.id,
  }
}

// ============================================================================
// CONTEXT HELPERS
// ============================================================================

/**
 * Get authentication context from Hono context
 *
 * @param c - Hono context
 * @returns Authentication context or undefined if not set
 */
export function getAuthContext(c: Context): FullAuthContext | undefined {
  return c.get(AUTH_CONTEXT_KEY) as FullAuthContext | undefined
}

/**
 * Require authentication context, throwing if not authenticated
 *
 * @param c - Hono context
 * @returns Authentication context
 * @throws AuthError if not authenticated
 */
export function requireAuthContext(c: Context): AuthContext {
  const auth = getAuthContext(c)
  if (!auth || !auth.authenticated) {
    throw new AuthError('AUTH_REQUIRED', 'Authentication required')
  }
  return auth as AuthContext
}

/**
 * Get tenant ID from context, throwing if not available
 *
 * @param c - Hono context
 * @returns Tenant ID
 * @throws AuthError if tenant not available
 */
export function requireTenantId(c: Context): string {
  const auth = requireAuthContext(c)
  if (!auth.tenantId) {
    throw new AuthError('MISSING_TENANT', 'Tenant context required')
  }
  return auth.tenantId
}

// ============================================================================
// PERMISSION MIDDLEWARE
// ============================================================================

/**
 * Create middleware that requires specific permissions
 *
 * @param permissionType - Required permission type
 * @param pathExtractor - Function to extract the path from the request
 * @returns Hono middleware handler
 *
 * @example
 * ```typescript
 * // Require write permission for POST /files
 * app.post('/files/*', requirePermission('write', (c) => {
 *   const path = c.req.param('*')
 *   return '/' + path
 * }))
 * ```
 */
export function requirePermissionMiddleware(
  permissionType: PathCheckOptions['type'],
  pathExtractor: (c: Context) => string
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const auth = getAuthContext(c)
    if (!auth || !auth.authenticated) {
      throw new AuthError('AUTH_REQUIRED', 'Authentication required')
    }

    const path = pathExtractor(c)
    const result = checkPermission(auth as AuthContext, {
      path,
      type: permissionType,
      tenantId: auth.tenantId,
    })

    if (!result.allowed) {
      throw new AuthError('PERMISSION_DENIED', result.reason ?? 'Permission denied', 403)
    }

    return next()
  }
}

// ============================================================================
// TENANT ISOLATION MIDDLEWARE
// ============================================================================

/**
 * Create middleware that enforces tenant path isolation
 *
 * Resolves all paths to be within the tenant's namespace and prevents
 * access to other tenants' data.
 *
 * @param pathExtractor - Function to extract the path from the request
 * @param pathSetter - Function to set the resolved path on the request
 * @returns Hono middleware handler
 *
 * @example
 * ```typescript
 * app.use('/fs/*', enforceTenantIsolation(
 *   (c) => c.req.param('*'),
 *   (c, resolvedPath) => c.set('resolvedPath', resolvedPath)
 * ))
 * ```
 */
export function enforceTenantIsolation(
  pathExtractor: (c: Context) => string,
  pathSetter: (c: Context, path: string) => void
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const auth = getAuthContext(c)

    // If no tenant isolation, pass through
    if (!auth?.authenticated || !(auth as AuthContext).tenant) {
      return next()
    }

    const authContext = auth as AuthContext
    const tenant = authContext.tenant!
    const requestedPath = pathExtractor(c)

    // Resolve path within tenant namespace
    const resolvedPath = resolveTenantPath(requestedPath, tenant.rootPath)

    // Set the resolved path
    pathSetter(c, resolvedPath)

    return next()
  }
}

// ============================================================================
// ERROR HANDLER
// ============================================================================

/**
 * Error handler for authentication errors
 *
 * @param error - The error to handle
 * @param c - Hono context
 * @returns Response if error was handled, undefined otherwise
 */
export function handleAuthError(error: unknown, c: Context): Response | undefined {
  if (error instanceof AuthError) {
    return c.json(
      {
        code: error.code,
        message: error.message,
      },
      error.statusCode as 401 | 403
    )
  }
  return undefined
}
