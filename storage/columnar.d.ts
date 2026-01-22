/**
 * Columnar Storage Pattern for DO SQLite Cost Optimization
 *
 * This module implements a columnar storage pattern that achieves ~99.6% cost
 * reduction by leveraging the fact that DO SQLite costs are tied to ROWS,
 * not columns.
 *
 * ## Cost Model
 *
 * DO SQLite pricing (as of 2025):
 * - $0.75 per million rows WRITTEN
 * - Reads are essentially free
 * - Costs accrue on WRITE, not on column count or row size
 *
 * ## Normalized vs Columnar Approach
 *
 * ### Normalized (Naive) Approach:
 * For a session with 100 attributes, each stored as a separate row:
 * - 100 rows per session
 * - Every attribute update = 1 row write
 * - 10 sessions x 100 attributes x 10 updates = 10,000 row writes
 *
 * ### Columnar Approach:
 * - 1 row per session, JSON columns for attributes
 * - LRU cache buffers writes in memory
 * - Batch checkpoint writes all dirty data as single row update
 * - 10 sessions x 1 row x 10 checkpoints = 100 row writes
 *
 * Cost Reduction: 10,000 / 100 = 100x = 99% reduction
 *
 * With aggressive buffering (checkpoint every 60s instead of every update):
 * - 10 sessions x 1 row x 1 checkpoint/min x 60 min = 600 row writes
 * - vs 10 sessions x 100 attributes x 100 updates = 100,000 row writes
 * - 100,000 / 600 = 166x = 99.4% reduction
 *
 * @module storage/columnar
 */
import type { SqlStorage } from '@cloudflare/workers-types';
import { WriteBufferCache, type WriteBufferCacheOptions } from './write-buffer.js';
export { WriteBufferCache, type WriteBufferCacheOptions, type EvictionReason, type CacheStats } from './write-buffer.js';
/**
 * Column type for schema definition
 */
export type ColumnType = 'text' | 'integer' | 'real' | 'blob' | 'json' | 'datetime';
/**
 * Column definition for a single field
 */
export interface ColumnDefinition<T, K extends keyof T> {
    /** SQL column name (defaults to field name in snake_case) */
    column?: string;
    /** Column type for SQL schema */
    type: ColumnType;
    /** Whether this field is required (NOT NULL) */
    required?: boolean;
    /** Default value for the column */
    defaultValue?: string;
    /** Custom serializer for this field */
    serialize?: (value: T[K]) => unknown;
    /** Custom deserializer for this field */
    deserialize?: (raw: unknown) => T[K];
}
/**
 * Schema definition for mapping type T to SQL columns
 *
 * @template T The entity type being stored
 *
 * @example
 * ```typescript
 * interface User {
 *   id: string
 *   name: string
 *   metadata: Record<string, unknown>
 *   createdAt: Date
 * }
 *
 * const userSchema: SchemaDefinition<User> = {
 *   tableName: 'users',
 *   primaryKey: 'id',
 *   columns: {
 *     id: { type: 'text', required: true },
 *     name: { type: 'text', required: true },
 *     metadata: { type: 'json', defaultValue: '{}' },
 *     createdAt: { type: 'datetime', column: 'created_at' },
 *   },
 * }
 * ```
 */
export interface SchemaDefinition<T> {
    /** SQL table name */
    tableName: string;
    /** Primary key field name (must be a key of T) */
    primaryKey: keyof T & string;
    /** Column definitions for each field */
    columns: {
        [K in keyof T]?: ColumnDefinition<T, K>;
    };
    /** Version field for optimistic locking (optional) */
    versionField?: keyof T & string;
    /** Updated at field for automatic timestamp (optional) */
    updatedAtField?: keyof T & string;
    /** Created at field for automatic timestamp (optional) */
    createdAtField?: keyof T & string;
    /** Checkpointed at field for tracking checkpoints (optional) */
    checkpointedAtField?: keyof T & string;
}
/**
 * Checkpoint trigger configuration
 */
export interface CheckpointTriggers {
    /** Checkpoint after this many dirty entries (default: 10) */
    dirtyCount?: number;
    /** Checkpoint after this many milliseconds (default: 5000ms) */
    intervalMs?: number;
    /** Checkpoint when memory usage exceeds this ratio (default: 0.8) */
    memoryPressureRatio?: number;
}
/**
 * Options for ColumnarStore<T>
 */
export interface ColumnarStoreOptions<T> {
    /** Cache configuration */
    cache?: WriteBufferCacheOptions<T>;
    /** Checkpoint trigger configuration */
    checkpointTriggers?: CheckpointTriggers;
    /** Callback when checkpoint occurs */
    onCheckpoint?: (entities: T[], stats: CheckpointStats) => void;
}
/**
 * Statistics from a checkpoint operation
 */
export interface CheckpointStats {
    /** Number of entities written */
    entityCount: number;
    /** Total bytes written */
    totalBytes: number;
    /** Time taken in ms */
    durationMs: number;
    /** Trigger reason */
    trigger: 'count' | 'interval' | 'memory' | 'manual' | 'eviction';
}
/**
 * Cost comparison result
 */
export interface CostComparison {
    /** Normalized approach stats */
    normalized: {
        rowWrites: number;
        estimatedCost: number;
    };
    /** Columnar approach stats */
    columnar: {
        rowWrites: number;
        estimatedCost: number;
    };
    /** Cost reduction percentage */
    reductionPercent: number;
    /** Cost reduction factor (e.g., 100x) */
    reductionFactor: number;
}
/**
 * Generic Columnar Store with write buffering
 *
 * This store uses a columnar schema (one row per entity with JSON columns)
 * combined with an LRU cache and batch checkpointing to minimize row writes.
 *
 * @template T The entity type being stored
 *
 * @example
 * ```typescript
 * interface User {
 *   id: string
 *   name: string
 *   settings: Record<string, unknown>
 *   createdAt: Date
 *   updatedAt: Date
 *   version: number
 * }
 *
 * const userSchema: SchemaDefinition<User> = {
 *   tableName: 'users',
 *   primaryKey: 'id',
 *   versionField: 'version',
 *   updatedAtField: 'updatedAt',
 *   createdAtField: 'createdAt',
 *   columns: {
 *     id: { type: 'text', required: true },
 *     name: { type: 'text', required: true },
 *     settings: { type: 'json', defaultValue: '{}' },
 *     createdAt: { type: 'datetime', column: 'created_at' },
 *     updatedAt: { type: 'datetime', column: 'updated_at' },
 *     version: { type: 'integer', defaultValue: '1' },
 *   },
 * }
 *
 * const store = new ColumnarStore<User>(sql, userSchema)
 * ```
 */
export declare class ColumnarStore<T extends object> {
    protected sql: SqlStorage;
    protected schema: SchemaDefinition<T>;
    protected cache: WriteBufferCache<T>;
    protected triggers: Required<CheckpointTriggers>;
    protected onCheckpointCallback?: (entities: T[], stats: CheckpointStats) => void;
    protected initialized: boolean;
    protected checkpointTimer: ReturnType<typeof setTimeout> | null;
    protected lastCheckpointAt: number;
    protected rowWriteCount: number;
    protected normalizedRowWriteEstimate: number;
    private columnNames;
    private fieldNames;
    constructor(sql: SqlStorage, schema: SchemaDefinition<T>, options?: ColumnarStoreOptions<T>);
    /**
     * Get the SQL column name for a field
     */
    getColumnName(field: keyof T): string;
    /**
     * Get the field name for a SQL column
     */
    getFieldName(column: string): keyof T | undefined;
    /**
     * Initialize the database schema
     */
    ensureSchema(): Promise<void>;
    /**
     * Get an entity by its primary key
     */
    get(id: string): Promise<T | null>;
    /**
     * Create a new entity
     */
    create(entity: T): Promise<T>;
    /**
     * Update an existing entity
     */
    update(id: string, updates: Partial<T>): Promise<T | null>;
    /**
     * Delete an entity
     */
    delete(id: string): Promise<boolean>;
    /**
     * Force a checkpoint (flush all dirty data to SQLite)
     */
    checkpoint(trigger?: CheckpointStats['trigger']): Promise<CheckpointStats>;
    /**
     * Get cost comparison statistics
     */
    getCostComparison(): CostComparison;
    /**
     * Get cache statistics
     */
    getCacheStats(): import("./write-buffer.js").CacheStats;
    /**
     * Stop the checkpoint timer
     */
    stop(): void;
    /**
     * Convert a database row to an entity
     */
    protected rowToEntity(row: Record<string, unknown>): T;
    /**
     * Serialize an entity field value for SQL
     */
    protected serializeValue(_field: keyof T, value: unknown, def: ColumnDefinition<T, keyof T>): unknown;
    /**
     * Build UPSERT SQL statement
     */
    protected buildUpsertSQL(entity: T, _checkpointTime: string): {
        sql: string;
        params: unknown[];
        bytes: number;
    };
    /**
     * Estimate normalized row count for cost comparison
     */
    protected estimateNormalizedRows(entity: T): number;
    protected maybeCheckpoint(): void;
    protected startCheckpointTimer(): void;
    protected checkpointSync(entries: Array<{
        key: string;
        value: T;
    }>): void;
}
/**
 * Calculate cost comparison for a given workload
 *
 * @param workload - Workload parameters
 * @returns Cost comparison analysis
 *
 * @example
 * ```typescript
 * const analysis = analyzeWorkloadCost({
 *   entities: 100,
 *   attributesPerEntity: 50,
 *   updatesPerEntityPerHour: 120,
 *   checkpointsPerEntityPerHour: 12,
 *   hoursPerMonth: 720,
 * })
 *
 * console.log(`Cost reduction: ${analysis.reductionPercent.toFixed(1)}%`)
 * console.log(`Normalized cost: $${analysis.normalized.estimatedCost.toFixed(2)}/month`)
 * console.log(`Columnar cost: $${analysis.columnar.estimatedCost.toFixed(2)}/month`)
 * ```
 */
export declare function analyzeWorkloadCost(workload: {
    /** Number of concurrent entities */
    entities: number;
    /** Average attributes per entity (env vars, history entries, etc.) */
    attributesPerEntity: number;
    /** Average updates per entity per hour */
    updatesPerEntityPerHour: number;
    /** Checkpoints per entity per hour (columnar approach) */
    checkpointsPerEntityPerHour: number;
    /** Hours of operation per month */
    hoursPerMonth: number;
}): CostComparison;
/**
 * Print a cost comparison report
 */
export declare function printCostReport(comparison: CostComparison): string;
//# sourceMappingURL=columnar.d.ts.map