/**
 * @fileoverview API key authentication for fsx
 *
 * Provides API key generation, validation, and management.
 * Keys are stored with hashed values for security.
 *
 * @category Application
 * @module do/auth/api-key
 */

import {
  AuthError,
  type APIKey,
  type APIKeyConfig,
  type CreateAPIKeyOptions,
  type CreateAPIKeyResult,
} from './types.js'

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default API key header name */
export const DEFAULT_API_KEY_HEADER = 'X-API-Key'

/** Default API key prefix */
export const DEFAULT_API_KEY_PREFIX = 'fsx_'

/** API key length (bytes of random data, hex encoded) */
const API_KEY_LENGTH = 32

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Generate cryptographically secure random bytes
 */
function generateRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

/**
 * Convert bytes to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Hash a string using SHA-256
 */
async function hashString(str: string): Promise<string> {
  const data = new TextEncoder().encode(str)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return bytesToHex(new Uint8Array(hashBuffer))
}

/**
 * Generate a key ID from the full key (first 8 chars after prefix)
 */
function generateKeyId(key: string, prefix: string): string {
  const keyWithoutPrefix = key.replace(prefix, '')
  return keyWithoutPrefix.substring(0, 8)
}

// ============================================================================
// API KEY MANAGEMENT
// ============================================================================

/**
 * Generate a new API key
 *
 * @param options - Key creation options
 * @param config - API key configuration
 * @returns Created API key with full key value (only returned once)
 *
 * @example
 * ```typescript
 * const result = await generateAPIKey({
 *   tenantId: 'tenant-123',
 *   name: 'Production API Key',
 *   permissions: [{ type: 'read', scope: { path: '/**' } }]
 * })
 * // Store result.key securely - it won't be shown again
 * console.log(result.key) // fsx_a1b2c3d4e5f6...
 * ```
 */
export async function generateAPIKey(
  options: CreateAPIKeyOptions,
  config: APIKeyConfig = {}
): Promise<CreateAPIKeyResult> {
  const prefix = config.keyPrefix ?? DEFAULT_API_KEY_PREFIX

  // Generate random key
  const randomBytes = generateRandomBytes(API_KEY_LENGTH)
  const keyValue = bytesToHex(randomBytes)
  const fullKey = `${prefix}${keyValue}`

  // Generate key ID (first 8 chars of the key value for identification)
  const keyId = generateKeyId(fullKey, prefix)

  // Hash the key for storage
  const keyHash = await hashString(fullKey)

  const now = Date.now()

  const apiKey: APIKey = {
    id: keyId,
    keyHash,
    tenantId: options.tenantId,
    name: options.name,
    permissions: options.permissions,
    createdAt: now,
    expiresAt: options.expiresAt,
    lastUsedAt: undefined,
    active: true,
  }

  return {
    id: keyId,
    key: fullKey,
    metadata: {
      id: keyId,
      tenantId: options.tenantId,
      name: options.name,
      permissions: options.permissions,
      createdAt: now,
      expiresAt: options.expiresAt,
      lastUsedAt: undefined,
      active: true,
    },
  }
}

/**
 * Validate an API key against stored key data
 *
 * @param key - The API key to validate
 * @param storedKey - The stored API key record
 * @param config - API key configuration
 * @returns True if valid, throws AuthError if invalid
 *
 * @example
 * ```typescript
 * const storedKey = await getAPIKeyFromStorage(keyId)
 * const isValid = await validateAPIKey(providedKey, storedKey)
 * ```
 */
export async function validateAPIKey(
  key: string,
  storedKey: APIKey,
  config: APIKeyConfig = {}
): Promise<true> {
  const prefix = config.keyPrefix ?? DEFAULT_API_KEY_PREFIX

  // Verify key format
  if (!key.startsWith(prefix)) {
    throw new AuthError('INVALID_API_KEY', 'Invalid API key format')
  }

  // Verify key is active
  if (!storedKey.active) {
    throw new AuthError('INVALID_API_KEY', 'API key has been revoked')
  }

  // Verify key hasn't expired
  if (storedKey.expiresAt && Date.now() > storedKey.expiresAt) {
    throw new AuthError('API_KEY_EXPIRED', 'API key has expired')
  }

  // Verify key hash matches
  const keyHash = await hashString(key)
  if (keyHash !== storedKey.keyHash) {
    throw new AuthError('INVALID_API_KEY', 'Invalid API key')
  }

  return true
}

/**
 * Extract API key from request
 *
 * Checks both header and query parameter (if configured).
 *
 * @param request - The incoming request
 * @param config - API key configuration
 * @returns The API key or null if not found
 */
export function extractAPIKey(request: Request, config: APIKeyConfig = {}): string | null {
  const headerName = config.headerName ?? DEFAULT_API_KEY_HEADER

  // Check header first
  const headerKey = request.headers.get(headerName)
  if (headerKey) {
    return headerKey
  }

  // Check query parameter if configured
  if (config.queryParam) {
    const url = new URL(request.url)
    const queryKey = url.searchParams.get(config.queryParam)
    if (queryKey) {
      return queryKey
    }
  }

  return null
}

/**
 * Extract key ID from a full API key
 *
 * Useful for looking up the stored key record.
 *
 * @param key - The full API key
 * @param config - API key configuration
 * @returns The key ID or null if invalid format
 */
export function extractKeyId(key: string, config: APIKeyConfig = {}): string | null {
  const prefix = config.keyPrefix ?? DEFAULT_API_KEY_PREFIX

  if (!key.startsWith(prefix)) {
    return null
  }

  return generateKeyId(key, prefix)
}

/**
 * Create a key hash for storage
 *
 * Use this when migrating existing keys to the hashed format.
 *
 * @param key - The full API key
 * @returns The hashed key value
 */
export async function hashAPIKey(key: string): Promise<string> {
  return hashString(key)
}

// ============================================================================
// API KEY STORE INTERFACE
// ============================================================================

/**
 * Interface for API key storage
 *
 * Implement this interface to provide custom storage for API keys.
 */
export interface APIKeyStore {
  /** Get an API key by its ID */
  get(keyId: string): Promise<APIKey | null>
  /** Store an API key */
  set(key: APIKey): Promise<void>
  /** Delete an API key */
  delete(keyId: string): Promise<void>
  /** List all API keys for a tenant */
  listByTenant(tenantId: string): Promise<APIKey[]>
  /** Update last used timestamp */
  updateLastUsed(keyId: string, timestamp: number): Promise<void>
  /** Revoke (deactivate) an API key */
  revoke(keyId: string): Promise<void>
}

/**
 * In-memory API key store for testing
 *
 * WARNING: Not for production use - keys are lost on restart.
 */
export class MemoryAPIKeyStore implements APIKeyStore {
  private keys: Map<string, APIKey> = new Map()

  async get(keyId: string): Promise<APIKey | null> {
    return this.keys.get(keyId) ?? null
  }

  async set(key: APIKey): Promise<void> {
    this.keys.set(key.id, key)
  }

  async delete(keyId: string): Promise<void> {
    this.keys.delete(keyId)
  }

  async listByTenant(tenantId: string): Promise<APIKey[]> {
    return Array.from(this.keys.values()).filter((k) => k.tenantId === tenantId)
  }

  async updateLastUsed(keyId: string, timestamp: number): Promise<void> {
    const key = this.keys.get(keyId)
    if (key) {
      key.lastUsedAt = timestamp
    }
  }

  async revoke(keyId: string): Promise<void> {
    const key = this.keys.get(keyId)
    if (key) {
      key.active = false
    }
  }
}
