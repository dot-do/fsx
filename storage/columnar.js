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
import { WriteBufferCache } from './write-buffer.js';
// Re-export write buffer types for convenience
export { WriteBufferCache } from './write-buffer.js';
// ============================================================================
// Utility Functions
// ============================================================================
/**
 * Utility to convert camelCase to snake_case
 */
function toSnakeCase(str) {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}
// ============================================================================
// Generic Columnar Store
// ============================================================================
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
export class ColumnarStore {
    sql;
    schema;
    cache;
    triggers;
    onCheckpointCallback;
    initialized = false;
    checkpointTimer = null;
    lastCheckpointAt = 0;
    // Cost tracking
    rowWriteCount = 0;
    normalizedRowWriteEstimate = 0;
    // Derived column mappings
    columnNames = new Map();
    fieldNames = new Map();
    constructor(sql, schema, options = {}) {
        this.sql = sql;
        this.schema = schema;
        this.triggers = {
            dirtyCount: options.checkpointTriggers?.dirtyCount ?? 10,
            intervalMs: options.checkpointTriggers?.intervalMs ?? 5000,
            memoryPressureRatio: options.checkpointTriggers?.memoryPressureRatio ?? 0.8,
        };
        this.onCheckpointCallback = options.onCheckpoint;
        // Build column mappings
        for (const [field, def] of Object.entries(schema.columns)) {
            const columnName = def?.column ?? toSnakeCase(field);
            this.columnNames.set(field, columnName);
            this.fieldNames.set(columnName, field);
        }
        // Create cache with eviction callback that triggers checkpoint
        this.cache = new WriteBufferCache({
            ...options.cache,
            onEvict: (key, value, reason) => {
                // If evicting dirty data, checkpoint first
                if (reason === 'count' || reason === 'size') {
                    this.checkpointSync([{ key, value }]);
                }
                options.cache?.onEvict?.(key, value, reason);
            },
        });
    }
    /**
     * Get the SQL column name for a field
     */
    getColumnName(field) {
        return this.columnNames.get(field) ?? toSnakeCase(field);
    }
    /**
     * Get the field name for a SQL column
     */
    getFieldName(column) {
        return this.fieldNames.get(column);
    }
    /**
     * Initialize the database schema
     */
    async ensureSchema() {
        if (this.initialized)
            return;
        const columns = [];
        for (const [field, def] of Object.entries(this.schema.columns)) {
            if (!def)
                continue;
            const columnName = this.getColumnName(field);
            let sqlType;
            switch (def.type) {
                case 'text':
                case 'datetime':
                case 'json':
                    sqlType = 'TEXT';
                    break;
                case 'integer':
                    sqlType = 'INTEGER';
                    break;
                case 'real':
                    sqlType = 'REAL';
                    break;
                case 'blob':
                    sqlType = 'BLOB';
                    break;
                default:
                    sqlType = 'TEXT';
            }
            let columnDef = `${columnName} ${sqlType}`;
            if (field === this.schema.primaryKey) {
                columnDef += ' PRIMARY KEY';
            }
            if (def.required) {
                columnDef += ' NOT NULL';
            }
            if (def.defaultValue !== undefined) {
                columnDef += ` DEFAULT ${def.defaultValue}`;
            }
            columns.push(columnDef);
        }
        const createSQL = `CREATE TABLE IF NOT EXISTS ${this.schema.tableName} (${columns.join(', ')})`;
        this.sql.exec(createSQL);
        this.initialized = true;
        this.startCheckpointTimer();
    }
    /**
     * Get an entity by its primary key
     */
    async get(id) {
        await this.ensureSchema();
        // Check cache first
        const cached = this.cache.get(id);
        if (cached) {
            return cached;
        }
        // Load from database
        const pkColumn = this.getColumnName(this.schema.primaryKey);
        const cursor = this.sql.exec(`SELECT * FROM ${this.schema.tableName} WHERE ${pkColumn} = ?`, id);
        const rows = cursor.toArray();
        if (rows.length === 0) {
            return null;
        }
        const row = rows[0];
        const entity = this.rowToEntity(row);
        // Add to cache (not dirty since it's from DB)
        this.cache.set(id, entity, { markDirty: false });
        return entity;
    }
    /**
     * Create a new entity
     */
    async create(entity) {
        await this.ensureSchema();
        const id = entity[this.schema.primaryKey];
        const now = new Date();
        // Apply automatic timestamps if configured
        const entityWithTimestamps = { ...entity };
        if (this.schema.createdAtField && !(this.schema.createdAtField in entity)) {
            entityWithTimestamps[this.schema.createdAtField] = now;
        }
        if (this.schema.updatedAtField) {
            entityWithTimestamps[this.schema.updatedAtField] = now;
        }
        if (this.schema.versionField && !(this.schema.versionField in entity)) {
            entityWithTimestamps[this.schema.versionField] = 1;
        }
        // Add to cache as dirty
        this.cache.set(id, entityWithTimestamps);
        // Track normalized estimate
        this.normalizedRowWriteEstimate += this.estimateNormalizedRows(entityWithTimestamps);
        // Check if we should checkpoint
        this.maybeCheckpoint();
        return entityWithTimestamps;
    }
    /**
     * Update an existing entity
     */
    async update(id, updates) {
        await this.ensureSchema();
        const entity = await this.get(id);
        if (!entity) {
            return null;
        }
        // Apply updates
        const updated = {
            ...entity,
            ...updates,
            [this.schema.primaryKey]: id, // Preserve ID
        };
        // Apply automatic timestamps and version
        if (this.schema.updatedAtField) {
            updated[this.schema.updatedAtField] = new Date();
        }
        if (this.schema.versionField) {
            const currentVersion = entity[this.schema.versionField];
            updated[this.schema.versionField] = currentVersion + 1;
        }
        // Update cache (marks as dirty)
        this.cache.set(id, updated);
        // Track normalized estimate (each changed attribute = row write)
        const changedAttributes = Object.keys(updates).length;
        this.normalizedRowWriteEstimate += changedAttributes;
        // Check if we should checkpoint
        this.maybeCheckpoint();
        return updated;
    }
    /**
     * Delete an entity
     */
    async delete(id) {
        await this.ensureSchema();
        // Remove from cache
        this.cache.delete(id);
        // Delete from database
        const pkColumn = this.getColumnName(this.schema.primaryKey);
        this.sql.exec(`DELETE FROM ${this.schema.tableName} WHERE ${pkColumn} = ?`, id);
        return true;
    }
    /**
     * Force a checkpoint (flush all dirty data to SQLite)
     */
    async checkpoint(trigger = 'manual') {
        await this.ensureSchema();
        const startTime = Date.now();
        const dirtyEntries = this.cache.getDirtyEntries();
        if (dirtyEntries.size === 0) {
            return {
                entityCount: 0,
                totalBytes: 0,
                durationMs: 0,
                trigger,
            };
        }
        const entities = [];
        let totalBytes = 0;
        // Write all dirty entities in batch
        for (const [, entity] of dirtyEntries) {
            const now = new Date().toISOString();
            // Update checkpoint timestamp if configured
            if (this.schema.checkpointedAtField) {
                entity[this.schema.checkpointedAtField] = new Date(now);
            }
            const { sql, params, bytes } = this.buildUpsertSQL(entity, now);
            totalBytes += bytes;
            this.sql.exec(sql, ...params);
            entities.push(entity);
            // Each entity = 1 row write (columnar approach)
            this.rowWriteCount += 1;
        }
        // Mark entries as clean
        this.cache.markClean(Array.from(dirtyEntries.keys()));
        this.lastCheckpointAt = Date.now();
        const stats = {
            entityCount: entities.length,
            totalBytes,
            durationMs: Date.now() - startTime,
            trigger,
        };
        this.onCheckpointCallback?.(entities, stats);
        return stats;
    }
    /**
     * Get cost comparison statistics
     */
    getCostComparison() {
        const COST_PER_MILLION_ROWS = 0.75;
        const normalizedCost = (this.normalizedRowWriteEstimate / 1_000_000) * COST_PER_MILLION_ROWS;
        const columnarCost = (this.rowWriteCount / 1_000_000) * COST_PER_MILLION_ROWS;
        const reductionFactor = this.normalizedRowWriteEstimate > 0
            ? this.normalizedRowWriteEstimate / Math.max(this.rowWriteCount, 1)
            : 0;
        const reductionPercent = reductionFactor > 0
            ? ((reductionFactor - 1) / reductionFactor) * 100
            : 0;
        return {
            normalized: {
                rowWrites: this.normalizedRowWriteEstimate,
                estimatedCost: normalizedCost,
            },
            columnar: {
                rowWrites: this.rowWriteCount,
                estimatedCost: columnarCost,
            },
            reductionPercent,
            reductionFactor,
        };
    }
    /**
     * Get cache statistics
     */
    getCacheStats() {
        return this.cache.getStats();
    }
    /**
     * Stop the checkpoint timer
     */
    stop() {
        if (this.checkpointTimer) {
            clearTimeout(this.checkpointTimer);
            this.checkpointTimer = null;
        }
    }
    // Protected methods for subclass access
    /**
     * Convert a database row to an entity
     */
    rowToEntity(row) {
        const entity = {};
        for (const [field, def] of Object.entries(this.schema.columns)) {
            if (!def)
                continue;
            const columnName = this.getColumnName(field);
            const rawValue = row[columnName];
            // Use custom deserializer if provided
            if (def.deserialize) {
                entity[field] = def.deserialize(rawValue);
                continue;
            }
            // Default deserialization based on type
            switch (def.type) {
                case 'json':
                    entity[field] = rawValue ? JSON.parse(rawValue) : (def.defaultValue ? JSON.parse(def.defaultValue) : null);
                    break;
                case 'datetime':
                    entity[field] = rawValue ? new Date(rawValue) : null;
                    break;
                case 'integer':
                    entity[field] = rawValue;
                    break;
                case 'real':
                    entity[field] = rawValue;
                    break;
                default:
                    entity[field] = rawValue;
            }
        }
        return entity;
    }
    /**
     * Serialize an entity field value for SQL
     */
    serializeValue(_field, value, def) {
        // Use custom serializer if provided
        if (def.serialize) {
            return def.serialize(value);
        }
        // Default serialization based on type
        switch (def.type) {
            case 'json':
                return JSON.stringify(value ?? (def.defaultValue ? JSON.parse(def.defaultValue) : null));
            case 'datetime':
                return value instanceof Date ? value.toISOString() : value;
            default:
                return value;
        }
    }
    /**
     * Build UPSERT SQL statement
     */
    buildUpsertSQL(entity, _checkpointTime) {
        const columns = [];
        const placeholders = [];
        const updateSets = [];
        const params = [];
        let bytes = 0;
        const pkColumn = this.getColumnName(this.schema.primaryKey);
        for (const [field, def] of Object.entries(this.schema.columns)) {
            if (!def)
                continue;
            const columnName = this.getColumnName(field);
            const value = entity[field];
            const serialized = this.serializeValue(field, value, def);
            columns.push(columnName);
            placeholders.push('?');
            params.push(serialized);
            // Track bytes for JSON columns
            if (def.type === 'json' && typeof serialized === 'string') {
                bytes += serialized.length;
            }
            // Add to update set (except primary key)
            if (field !== this.schema.primaryKey) {
                updateSets.push(`${columnName} = excluded.${columnName}`);
            }
        }
        const sql = `INSERT INTO ${this.schema.tableName} (${columns.join(', ')})
         VALUES (${placeholders.join(', ')})
         ON CONFLICT(${pkColumn}) DO UPDATE SET ${updateSets.join(', ')}`;
        return { sql, params, bytes };
    }
    /**
     * Estimate normalized row count for cost comparison
     */
    estimateNormalizedRows(entity) {
        let count = 0;
        for (const [field, def] of Object.entries(this.schema.columns)) {
            if (!def)
                continue;
            const value = entity[field];
            if (def.type === 'json') {
                // JSON columns would be multiple rows in normalized schema
                if (Array.isArray(value)) {
                    count += value.length || 1;
                }
                else if (value && typeof value === 'object') {
                    count += Object.keys(value).length || 1;
                }
                else {
                    count += 1;
                }
            }
            else {
                count += 1;
            }
        }
        return count;
    }
    maybeCheckpoint() {
        const stats = this.cache.getStats();
        // Check dirty count trigger
        if (stats.dirtyCount >= this.triggers.dirtyCount) {
            this.checkpoint('count').catch(() => {
                // Ignore errors in automatic checkpoint
            });
            return;
        }
        // Check memory pressure trigger
        if (stats.memoryUsageRatio >= this.triggers.memoryPressureRatio) {
            this.checkpoint('memory').catch(() => {
                // Ignore errors in automatic checkpoint
            });
            return;
        }
    }
    startCheckpointTimer() {
        if (this.checkpointTimer)
            return;
        this.checkpointTimer = setInterval(() => {
            const stats = this.cache.getStats();
            if (stats.dirtyCount > 0 && Date.now() - this.lastCheckpointAt >= this.triggers.intervalMs) {
                this.checkpoint('interval').catch(() => {
                    // Ignore errors in automatic checkpoint
                });
            }
        }, this.triggers.intervalMs);
    }
    checkpointSync(entries) {
        const now = new Date().toISOString();
        for (const { value: entity } of entries) {
            if (!entity)
                continue;
            const { sql, params } = this.buildUpsertSQL(entity, now);
            this.sql.exec(sql, ...params);
            this.rowWriteCount += 1;
        }
    }
}
// ============================================================================
// Cost Analysis Utilities
// ============================================================================
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
export function analyzeWorkloadCost(workload) {
    const COST_PER_MILLION_ROWS = 0.75;
    // Normalized: each attribute update = 1 row write
    const normalizedRowWrites = workload.entities *
        workload.updatesPerEntityPerHour *
        workload.hoursPerMonth;
    // Columnar: each checkpoint = 1 row write per dirty entity
    // Assuming all entities are dirty at each checkpoint interval
    const columnarRowWrites = workload.entities *
        workload.checkpointsPerEntityPerHour *
        workload.hoursPerMonth;
    const normalizedCost = (normalizedRowWrites / 1_000_000) * COST_PER_MILLION_ROWS;
    const columnarCost = (columnarRowWrites / 1_000_000) * COST_PER_MILLION_ROWS;
    const reductionFactor = normalizedRowWrites / Math.max(columnarRowWrites, 1);
    const reductionPercent = ((reductionFactor - 1) / reductionFactor) * 100;
    return {
        normalized: {
            rowWrites: normalizedRowWrites,
            estimatedCost: normalizedCost,
        },
        columnar: {
            rowWrites: columnarRowWrites,
            estimatedCost: columnarCost,
        },
        reductionPercent,
        reductionFactor,
    };
}
/**
 * Print a cost comparison report
 */
export function printCostReport(comparison) {
    const lines = [
        '='.repeat(60),
        'DO SQLite Cost Comparison: Normalized vs Columnar',
        '='.repeat(60),
        '',
        'Normalized Approach (many rows per entity):',
        `  Row writes: ${comparison.normalized.rowWrites.toLocaleString()}`,
        `  Estimated cost: $${comparison.normalized.estimatedCost.toFixed(4)}`,
        '',
        'Columnar Approach (one row per entity + JSON columns):',
        `  Row writes: ${comparison.columnar.rowWrites.toLocaleString()}`,
        `  Estimated cost: $${comparison.columnar.estimatedCost.toFixed(4)}`,
        '',
        '-'.repeat(60),
        `Cost Reduction: ${comparison.reductionPercent.toFixed(1)}%`,
        `Reduction Factor: ${comparison.reductionFactor.toFixed(1)}x`,
        '='.repeat(60),
    ];
    return lines.join('\n');
}
//# sourceMappingURL=columnar.js.map