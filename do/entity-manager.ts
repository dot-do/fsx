/**
 * EntityManager - Manages entity stores with deferred initialization
 *
 * This class solves the problem of store creation timing vs state context
 * availability in Durable Objects. Stores cannot be created during
 * construction because the state context (ctx) is not fully initialized.
 *
 * The EntityManager defers store creation until the state context is
 * explicitly provided or accessed, ensuring stores are created only when
 * the context is ready.
 *
 * @category Application
 * @example
 * ```typescript
 * // In a Durable Object class
 * class MyDO extends DurableObject {
 *   private entityManager: EntityManager
 *
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env)
 *     // EntityManager is created but stores are NOT initialized yet
 *     this.entityManager = new EntityManager()
 *   }
 *
 *   async fetch(request: Request): Promise<Response> {
 *     // Initialize with state context when needed
 *     await this.entityManager.initialize(this.ctx)
 *
 *     // Now stores are available
 *     const store = this.entityManager.getStore('users')
 *     // ...
 *   }
 * }
 * ```
 *
 * @example
 * ```typescript
 * // Using factory pattern with state context
 * const manager = EntityManager.create(ctx)
 * await manager.initialize()
 * ```
 */

/**
 * Store interface - represents a typed key-value store backed by SQLite
 */
export interface EntityStore<T = unknown> {
  /** Store name/identifier */
  readonly name: string

  /** Get an entity by key */
  get(key: string): Promise<T | null>

  /** Set an entity by key */
  set(key: string, value: T): Promise<void>

  /** Delete an entity by key */
  delete(key: string): Promise<boolean>

  /** Check if entity exists */
  has(key: string): Promise<boolean>

  /** List all keys */
  keys(): Promise<string[]>

  /** List all entries */
  entries(): Promise<Array<[string, T]>>

  /** Get count of entities */
  count(): Promise<number>

  /** Clear all entities in this store */
  clear(): Promise<void>
}

/**
 * Configuration for EntityManager
 */
export interface EntityManagerConfig {
  /** SQLite storage instance from Durable Object context */
  sql?: SqlStorage

  /** Table name prefix for entity stores (default: 'entity_') */
  tablePrefix?: string

  /** Whether to auto-create tables on first access (default: true) */
  autoCreateTables?: boolean
}

/**
 * Internal store entry tracked by EntityManager
 */
interface StoreEntry<T = unknown> {
  name: string
  store: EntityStore<T> | null
  initialized: boolean
}

/**
 * Schema for entity store tables
 */
const ENTITY_STORE_SCHEMA = `
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
`

/**
 * EntityManager - Manages entity stores with deferred initialization
 *
 * This class provides a pattern for creating entity stores that require
 * state context (like SQLite storage from DurableObjectState) without
 * creating them during construction when the context may not be ready.
 *
 * Key features:
 * - Deferred store creation until state context is available
 * - Lazy initialization of individual stores
 * - Type-safe store access with generics
 * - Automatic schema creation for stores
 */
export class EntityManager {
  private sql: SqlStorage | null = null
  private tablePrefix: string
  private autoCreateTables: boolean
  private initialized = false
  private stores: Map<string, StoreEntry> = new Map()

  /**
   * Create a new EntityManager instance.
   *
   * Note: This constructor does NOT create any stores. Call initialize()
   * with a state context before accessing stores.
   *
   * @param config - Optional configuration
   */
  constructor(config: EntityManagerConfig = {}) {
    this.sql = config.sql ?? null
    this.tablePrefix = config.tablePrefix ?? 'entity_'
    this.autoCreateTables = config.autoCreateTables ?? true
  }

  /**
   * Create an EntityManager with state context.
   *
   * This is the preferred factory method when you have the state context
   * available at creation time.
   *
   * @param ctx - Durable Object state context
   * @param config - Optional additional configuration
   * @returns Initialized EntityManager
   */
  static create(
    ctx: { storage: { sql: SqlStorage } },
    config: Omit<EntityManagerConfig, 'sql'> = {}
  ): EntityManager {
    return new EntityManager({
      sql: ctx.storage.sql,
      ...config,
    })
  }

  /**
   * Initialize the EntityManager with a state context.
   *
   * This method must be called before accessing any stores if the
   * EntityManager was created without a SQL storage reference.
   *
   * @param ctx - Durable Object state context
   * @throws Error if already initialized with different context
   */
  async initialize(ctx?: { storage: { sql: SqlStorage } }): Promise<void> {
    if (ctx?.storage?.sql) {
      if (this.sql && this.sql !== ctx.storage.sql) {
        throw new Error('EntityManager already initialized with different SQL storage')
      }
      this.sql = ctx.storage.sql
    }

    if (!this.sql) {
      throw new Error('EntityManager requires SQL storage context. Call initialize(ctx) with DurableObjectState.')
    }

    this.initialized = true
  }

  /**
   * Check if EntityManager is initialized and ready for use.
   */
  isInitialized(): boolean {
    return this.initialized && this.sql !== null
  }

  /**
   * Register a store by name without creating it.
   *
   * The store will be lazily created on first access.
   *
   * @param name - Store name
   */
  registerStore<T = unknown>(name: string): void {
    if (!this.stores.has(name)) {
      this.stores.set(name, {
        name,
        store: null,
        initialized: false,
      })
    }
  }

  /**
   * Get a store by name, creating it if necessary.
   *
   * The store table is created lazily on first access.
   *
   * @param name - Store name
   * @returns Entity store instance
   * @throws Error if not initialized
   */
  async getStore<T = unknown>(name: string): Promise<EntityStore<T>> {
    if (!this.sql) {
      throw new Error('EntityManager not initialized. Call initialize(ctx) first.')
    }

    let entry = this.stores.get(name) as StoreEntry<T> | undefined

    if (!entry) {
      entry = {
        name,
        store: null,
        initialized: false,
      }
      this.stores.set(name, entry)
    }

    if (!entry.store) {
      // Create the store lazily
      entry.store = await this.createStore<T>(name)
      entry.initialized = true
    }

    return entry.store
  }

  /**
   * Check if a store exists (either registered or has data).
   *
   * @param name - Store name
   */
  hasStore(name: string): boolean {
    return this.stores.has(name)
  }

  /**
   * Get list of all registered store names.
   */
  getStoreNames(): string[] {
    return Array.from(this.stores.keys())
  }

  /**
   * Create a new entity store backed by SQLite.
   *
   * @param name - Store name
   * @returns EntityStore instance
   */
  private async createStore<T>(name: string): Promise<EntityStore<T>> {
    const sql = this.sql!
    const tableName = `${this.tablePrefix}${name}`

    // Create table if auto-create is enabled
    if (this.autoCreateTables) {
      sql.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (${ENTITY_STORE_SCHEMA})`)
    }

    // Return store implementation
    return {
      name,

      async get(key: string): Promise<T | null> {
        const results = sql
          .exec<{ value: string }>(`SELECT value FROM ${tableName} WHERE key = ?`, key)
          .toArray()

        if (results.length === 0) return null

        try {
          return JSON.parse(results[0]!.value) as T
        } catch {
          return null
        }
      },

      async set(key: string, value: T): Promise<void> {
        const now = Date.now()
        const jsonValue = JSON.stringify(value)

        sql.exec(
          `INSERT INTO ${tableName} (key, value, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`,
          key,
          jsonValue,
          now,
          now,
          jsonValue,
          now
        )
      },

      async delete(key: string): Promise<boolean> {
        const before = sql
          .exec<{ count: number }>(`SELECT COUNT(*) as count FROM ${tableName} WHERE key = ?`, key)
          .toArray()

        if (before[0]?.count === 0) return false

        sql.exec(`DELETE FROM ${tableName} WHERE key = ?`, key)
        return true
      },

      async has(key: string): Promise<boolean> {
        const results = sql
          .exec<{ count: number }>(`SELECT COUNT(*) as count FROM ${tableName} WHERE key = ?`, key)
          .toArray()

        return (results[0]?.count ?? 0) > 0
      },

      async keys(): Promise<string[]> {
        const results = sql.exec<{ key: string }>(`SELECT key FROM ${tableName}`).toArray()
        return results.map((r) => r.key)
      },

      async entries(): Promise<Array<[string, T]>> {
        const results = sql
          .exec<{ key: string; value: string }>(`SELECT key, value FROM ${tableName}`)
          .toArray()

        return results.map((r) => {
          try {
            return [r.key, JSON.parse(r.value) as T]
          } catch {
            return [r.key, null as T]
          }
        })
      },

      async count(): Promise<number> {
        const results = sql
          .exec<{ count: number }>(`SELECT COUNT(*) as count FROM ${tableName}`)
          .toArray()

        return results[0]?.count ?? 0
      },

      async clear(): Promise<void> {
        sql.exec(`DELETE FROM ${tableName}`)
      },
    }
  }

  /**
   * Dispose of all stores and cleanup resources.
   */
  async dispose(): Promise<void> {
    this.stores.clear()
    this.initialized = false
    // Note: We don't clear this.sql as it's owned by the Durable Object context
  }
}

/**
 * Type helper for creating typed entity stores.
 *
 * @example
 * ```typescript
 * interface User {
 *   id: string
 *   name: string
 *   email: string
 * }
 *
 * const manager = new EntityManager()
 * await manager.initialize(ctx)
 *
 * const userStore: TypedEntityStore<User> = await manager.getStore<User>('users')
 * await userStore.set('user-1', { id: 'user-1', name: 'Alice', email: 'alice@example.com' })
 * ```
 */
export type TypedEntityStore<T> = EntityStore<T>
