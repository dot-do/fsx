/**
 * @fileoverview Tenant management for fsx multi-tenancy
 *
 * Provides tenant creation, lookup, and namespace isolation.
 * Each tenant gets an isolated file namespace under /tenants/{id}.
 *
 * @category Application
 * @module do/auth/tenant
 */

import { AuthError, type Tenant, type CreateTenantOptions } from './types.js'

// ============================================================================
// TENANT STORE INTERFACE
// ============================================================================

/**
 * Interface for tenant storage
 *
 * Implement this interface to provide custom storage for tenants.
 */
export interface TenantStore {
  /** Get a tenant by ID */
  get(tenantId: string): Promise<Tenant | null>
  /** Create a new tenant */
  create(tenant: Tenant): Promise<void>
  /** Update a tenant */
  update(tenant: Tenant): Promise<void>
  /** Delete a tenant */
  delete(tenantId: string): Promise<void>
  /** List all tenants */
  list(): Promise<Tenant[]>
  /** Get tenant by name */
  getByName(name: string): Promise<Tenant | null>
}

// ============================================================================
// TENANT MANAGEMENT
// ============================================================================

/**
 * Generate a unique tenant ID
 */
export function generateTenantId(): string {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 16)
}

/**
 * Generate the default root path for a tenant
 */
export function defaultTenantRootPath(tenantId: string): string {
  return `/tenants/${tenantId}`
}

/**
 * Create a new tenant
 *
 * @param options - Tenant creation options
 * @param store - Tenant store
 * @returns Created tenant
 *
 * @example
 * ```typescript
 * const tenant = await createTenant({
 *   name: 'Acme Corp',
 *   metadata: { plan: 'enterprise' }
 * }, tenantStore)
 * ```
 */
export async function createTenant(options: CreateTenantOptions, store: TenantStore): Promise<Tenant> {
  // Generate tenant ID
  const tenantId = generateTenantId()

  // Use provided root path or generate default
  const rootPath = options.rootPath ?? defaultTenantRootPath(tenantId)

  // Create tenant object
  const tenant: Tenant = {
    id: tenantId,
    name: options.name,
    rootPath,
    createdAt: Date.now(),
    status: 'active',
    metadata: options.metadata,
  }

  // Store tenant
  await store.create(tenant)

  return tenant
}

/**
 * Get a tenant by ID
 *
 * @param tenantId - Tenant ID
 * @param store - Tenant store
 * @returns Tenant or null if not found
 */
export async function getTenant(tenantId: string, store: TenantStore): Promise<Tenant | null> {
  return store.get(tenantId)
}

/**
 * Get a tenant by ID, throwing if not found
 *
 * @param tenantId - Tenant ID
 * @param store - Tenant store
 * @returns Tenant
 * @throws AuthError if tenant not found
 */
export async function requireTenant(tenantId: string, store: TenantStore): Promise<Tenant> {
  const tenant = await store.get(tenantId)
  if (!tenant) {
    throw new AuthError('TENANT_NOT_FOUND', `Tenant ${tenantId} not found`)
  }
  if (tenant.status === 'suspended') {
    throw new AuthError('TENANT_SUSPENDED', `Tenant ${tenantId} is suspended`)
  }
  if (tenant.status === 'deleted') {
    throw new AuthError('TENANT_NOT_FOUND', `Tenant ${tenantId} not found`)
  }
  return tenant
}

/**
 * Suspend a tenant
 *
 * @param tenantId - Tenant ID
 * @param store - Tenant store
 */
export async function suspendTenant(tenantId: string, store: TenantStore): Promise<void> {
  const tenant = await store.get(tenantId)
  if (!tenant) {
    throw new AuthError('TENANT_NOT_FOUND', `Tenant ${tenantId} not found`)
  }

  tenant.status = 'suspended'
  await store.update(tenant)
}

/**
 * Reactivate a suspended tenant
 *
 * @param tenantId - Tenant ID
 * @param store - Tenant store
 */
export async function reactivateTenant(tenantId: string, store: TenantStore): Promise<void> {
  const tenant = await store.get(tenantId)
  if (!tenant) {
    throw new AuthError('TENANT_NOT_FOUND', `Tenant ${tenantId} not found`)
  }
  if (tenant.status === 'deleted') {
    throw new AuthError('TENANT_NOT_FOUND', `Tenant ${tenantId} cannot be reactivated`)
  }

  tenant.status = 'active'
  await store.update(tenant)
}

/**
 * Delete a tenant (soft delete)
 *
 * @param tenantId - Tenant ID
 * @param store - Tenant store
 */
export async function deleteTenant(tenantId: string, store: TenantStore): Promise<void> {
  const tenant = await store.get(tenantId)
  if (!tenant) {
    throw new AuthError('TENANT_NOT_FOUND', `Tenant ${tenantId} not found`)
  }

  tenant.status = 'deleted'
  await store.update(tenant)
}

// ============================================================================
// IN-MEMORY TENANT STORE
// ============================================================================

/**
 * In-memory tenant store for testing
 *
 * WARNING: Not for production use - tenants are lost on restart.
 */
export class MemoryTenantStore implements TenantStore {
  private tenants: Map<string, Tenant> = new Map()

  async get(tenantId: string): Promise<Tenant | null> {
    return this.tenants.get(tenantId) ?? null
  }

  async create(tenant: Tenant): Promise<void> {
    if (this.tenants.has(tenant.id)) {
      throw new Error(`Tenant ${tenant.id} already exists`)
    }
    this.tenants.set(tenant.id, tenant)
  }

  async update(tenant: Tenant): Promise<void> {
    if (!this.tenants.has(tenant.id)) {
      throw new Error(`Tenant ${tenant.id} not found`)
    }
    this.tenants.set(tenant.id, tenant)
  }

  async delete(tenantId: string): Promise<void> {
    this.tenants.delete(tenantId)
  }

  async list(): Promise<Tenant[]> {
    return Array.from(this.tenants.values())
  }

  async getByName(name: string): Promise<Tenant | null> {
    for (const tenant of this.tenants.values()) {
      if (tenant.name === name) {
        return tenant
      }
    }
    return null
  }
}

// ============================================================================
// SQLITE TENANT STORE
// ============================================================================

/**
 * SQLite-backed tenant store schema
 */
export const TENANT_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'deleted')),
    metadata TEXT
  )
`

/**
 * SQLite-backed tenant store
 *
 * Uses the Durable Object's SQLite storage for persistent tenant storage.
 */
export class SQLiteTenantStore implements TenantStore {
  private sql: SqlStorage
  private initialized = false

  constructor(sql: SqlStorage) {
    this.sql = sql
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return
    await this.sql.exec(TENANT_TABLE_SCHEMA)
    this.initialized = true
  }

  async get(tenantId: string): Promise<Tenant | null> {
    await this.initialize()
    const results = this.sql
      .exec<{
        id: string
        name: string
        root_path: string
        created_at: number
        status: string
        metadata: string | null
      }>('SELECT * FROM tenants WHERE id = ?', tenantId)
      .toArray()

    if (results.length === 0) return null

    const row = results[0]!
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      createdAt: row.created_at,
      status: row.status as 'active' | 'suspended' | 'deleted',
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }
  }

  async create(tenant: Tenant): Promise<void> {
    await this.initialize()
    this.sql.exec(
      'INSERT INTO tenants (id, name, root_path, created_at, status, metadata) VALUES (?, ?, ?, ?, ?, ?)',
      tenant.id,
      tenant.name,
      tenant.rootPath,
      tenant.createdAt,
      tenant.status,
      tenant.metadata ? JSON.stringify(tenant.metadata) : null
    )
  }

  async update(tenant: Tenant): Promise<void> {
    await this.initialize()
    this.sql.exec(
      'UPDATE tenants SET name = ?, root_path = ?, status = ?, metadata = ? WHERE id = ?',
      tenant.name,
      tenant.rootPath,
      tenant.status,
      tenant.metadata ? JSON.stringify(tenant.metadata) : null,
      tenant.id
    )
  }

  async delete(tenantId: string): Promise<void> {
    await this.initialize()
    this.sql.exec('DELETE FROM tenants WHERE id = ?', tenantId)
  }

  async list(): Promise<Tenant[]> {
    await this.initialize()
    const results = this.sql
      .exec<{
        id: string
        name: string
        root_path: string
        created_at: number
        status: string
        metadata: string | null
      }>('SELECT * FROM tenants')
      .toArray()

    return results.map((row) => ({
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      createdAt: row.created_at,
      status: row.status as 'active' | 'suspended' | 'deleted',
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }))
  }

  async getByName(name: string): Promise<Tenant | null> {
    await this.initialize()
    const results = this.sql
      .exec<{
        id: string
        name: string
        root_path: string
        created_at: number
        status: string
        metadata: string | null
      }>('SELECT * FROM tenants WHERE name = ?', name)
      .toArray()

    if (results.length === 0) return null

    const row = results[0]!
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      createdAt: row.created_at,
      status: row.status as 'active' | 'suspended' | 'deleted',
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }
  }
}
