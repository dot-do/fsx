/**
 * @fileoverview Authentication and authorization types for fsx
 *
 * Defines interfaces and types for:
 * - JWT token payload and validation
 * - API key authentication
 * - Tenant isolation
 * - Permission checks (read/write per path)
 *
 * @category Application
 * @module do/auth/types
 */

// ============================================================================
// AUTHENTICATION TYPES
// ============================================================================

/**
 * Supported authentication methods
 */
export type AuthMethod = 'jwt' | 'api-key' | 'none'

/**
 * JWT token payload structure
 *
 * Contains claims for tenant identification and permissions.
 * Compatible with standard JWT claims (sub, iss, aud, exp, iat).
 */
export interface JWTPayload {
  /** Subject - unique user identifier */
  sub: string
  /** Issuer - token issuer identifier */
  iss?: string
  /** Audience - intended recipient */
  aud?: string | string[]
  /** Expiration time (Unix timestamp) */
  exp?: number
  /** Issued at (Unix timestamp) */
  iat?: number
  /** Not before (Unix timestamp) */
  nbf?: number
  /** JWT ID - unique token identifier */
  jti?: string
  /** Tenant identifier for multi-tenancy */
  tenant_id: string
  /** User permissions (optional - can be derived from role) */
  permissions?: Permission[]
  /** User role */
  role?: UserRole
  /** Custom claims */
  [key: string]: unknown
}

/**
 * API key structure for storage
 */
export interface APIKey {
  /** Unique key identifier (prefix of the full key) */
  id: string
  /** Hashed key value for secure comparison */
  keyHash: string
  /** Tenant this key belongs to */
  tenantId: string
  /** Human-readable name/label */
  name: string
  /** Permissions granted to this key */
  permissions: Permission[]
  /** Creation timestamp */
  createdAt: number
  /** Expiration timestamp (optional) */
  expiresAt?: number
  /** Last used timestamp */
  lastUsedAt?: number
  /** Whether the key is active */
  active: boolean
}

/**
 * API key creation options
 */
export interface CreateAPIKeyOptions {
  /** Tenant this key belongs to */
  tenantId: string
  /** Human-readable name/label */
  name: string
  /** Permissions granted to this key */
  permissions: Permission[]
  /** Expiration timestamp (optional) */
  expiresAt?: number
}

/**
 * Result of API key creation
 */
export interface CreateAPIKeyResult {
  /** Unique key identifier */
  id: string
  /** Full API key (only returned on creation, never stored) */
  key: string
  /** Key metadata */
  metadata: Omit<APIKey, 'keyHash'>
}

// ============================================================================
// AUTHORIZATION TYPES
// ============================================================================

/**
 * Permission types for filesystem operations
 */
export type PermissionType = 'read' | 'write' | 'delete' | 'admin'

/**
 * Permission scope - defines what paths a permission applies to
 */
export interface PermissionScope {
  /** Path pattern (supports glob patterns like /data/** ) */
  path: string
  /** Whether this permission is recursive (includes subdirectories) */
  recursive?: boolean
}

/**
 * A single permission entry
 */
export interface Permission {
  /** Permission type */
  type: PermissionType
  /** Path scope for this permission */
  scope: PermissionScope
}

/**
 * User roles with predefined permission sets
 */
export type UserRole = 'admin' | 'editor' | 'viewer' | 'custom'

/**
 * Role to permissions mapping
 */
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [
    { type: 'read', scope: { path: '/**', recursive: true } },
    { type: 'write', scope: { path: '/**', recursive: true } },
    { type: 'delete', scope: { path: '/**', recursive: true } },
    { type: 'admin', scope: { path: '/**', recursive: true } },
  ],
  editor: [
    { type: 'read', scope: { path: '/**', recursive: true } },
    { type: 'write', scope: { path: '/**', recursive: true } },
    { type: 'delete', scope: { path: '/**', recursive: true } },
  ],
  viewer: [{ type: 'read', scope: { path: '/**', recursive: true } }],
  custom: [], // Custom roles have explicitly defined permissions
}

// ============================================================================
// TENANT TYPES
// ============================================================================

/**
 * Tenant configuration
 */
export interface Tenant {
  /** Unique tenant identifier */
  id: string
  /** Human-readable tenant name */
  name: string
  /** Root path for this tenant's isolated namespace */
  rootPath: string
  /** Tenant creation timestamp */
  createdAt: number
  /** Tenant status */
  status: 'active' | 'suspended' | 'deleted'
  /** Optional metadata */
  metadata?: Record<string, unknown>
}

/**
 * Tenant creation options
 */
export interface CreateTenantOptions {
  /** Human-readable tenant name */
  name: string
  /** Optional custom root path (defaults to /tenants/{id}) */
  rootPath?: string
  /** Optional metadata */
  metadata?: Record<string, unknown>
}

// ============================================================================
// AUTHENTICATION CONTEXT
// ============================================================================

/**
 * Authenticated user context
 *
 * Contains all information about the authenticated user including
 * tenant, permissions, and identity information.
 */
export interface AuthContext {
  /** Authentication method used */
  method: AuthMethod
  /** Whether the user is authenticated */
  authenticated: boolean
  /** User identifier (from JWT sub or API key owner) */
  userId?: string
  /** Tenant identifier */
  tenantId?: string
  /** Tenant configuration (if resolved) */
  tenant?: Tenant
  /** User permissions */
  permissions: Permission[]
  /** User role */
  role?: UserRole
  /** API key ID (if authenticated via API key) */
  apiKeyId?: string
  /** Original JWT payload (if authenticated via JWT) */
  jwtPayload?: JWTPayload
}

/**
 * Unauthenticated context
 */
export interface UnauthenticatedContext {
  method: 'none'
  authenticated: false
  permissions: []
}

/**
 * Full auth context type
 */
export type FullAuthContext = AuthContext | UnauthenticatedContext

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

/**
 * JWT validation configuration
 */
export interface JWTConfig {
  /** Secret key for HMAC algorithms */
  secret?: string
  /** Public key for RSA/EC algorithms (PEM format) */
  publicKey?: string
  /** Allowed algorithms (default: ['HS256']) */
  algorithms?: string[]
  /** Expected issuer(s) */
  issuer?: string | string[]
  /** Expected audience(s) */
  audience?: string | string[]
  /** Clock tolerance in seconds (default: 60) */
  clockTolerance?: number
  /** Whether to validate exp claim (default: true) */
  validateExp?: boolean
  /** Whether to validate nbf claim (default: true) */
  validateNbf?: boolean
}

/**
 * API key configuration
 */
export interface APIKeyConfig {
  /** Header name for API key (default: 'X-API-Key') */
  headerName?: string
  /** Query parameter name for API key (optional) */
  queryParam?: string
  /** Key prefix for identification (e.g., 'fsx_') */
  keyPrefix?: string
  /** Hash algorithm for key storage (default: 'SHA-256') */
  hashAlgorithm?: string
}

/**
 * Full authentication configuration
 */
export interface AuthConfig {
  /** Whether authentication is required (default: false for backwards compatibility) */
  required?: boolean
  /** JWT configuration */
  jwt?: JWTConfig
  /** API key configuration */
  apiKey?: APIKeyConfig
  /** Default tenant ID for unauthenticated requests (if auth not required) */
  defaultTenantId?: string
  /** Whether to enable tenant isolation (default: true if auth enabled) */
  enableTenantIsolation?: boolean
  /** Paths that don't require authentication */
  publicPaths?: string[]
}

// ============================================================================
// ERROR TYPES
// ============================================================================

/**
 * Authentication error codes
 */
export type AuthErrorCode =
  | 'AUTH_REQUIRED'
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'INVALID_API_KEY'
  | 'API_KEY_EXPIRED'
  | 'PERMISSION_DENIED'
  | 'TENANT_NOT_FOUND'
  | 'TENANT_SUSPENDED'
  | 'INVALID_SIGNATURE'
  | 'MISSING_TENANT'

/**
 * Authentication error
 */
export class AuthError extends Error {
  readonly code: AuthErrorCode
  readonly statusCode: number

  constructor(code: AuthErrorCode, message: string, statusCode: number = 401) {
    super(message)
    this.name = 'AuthError'
    this.code = code
    this.statusCode = statusCode
  }
}

// ============================================================================
// HELPER TYPES
// ============================================================================

/**
 * Permission check result
 */
export interface PermissionCheckResult {
  /** Whether the permission is granted */
  allowed: boolean
  /** Reason for denial (if not allowed) */
  reason?: string
  /** Matched permission (if allowed) */
  matchedPermission?: Permission
}

/**
 * Path check options
 */
export interface PathCheckOptions {
  /** The path to check */
  path: string
  /** Required permission type */
  type: PermissionType
  /** Tenant context */
  tenantId?: string
}
