/**
 * TieredR2Storage - R2-backed tiered storage with automatic tier migration
 *
 * Implements hot/warm/cold tiers based on access patterns:
 * - Hot: Recently accessed (< 1 day by default)
 * - Warm: Moderately accessed (< 30 days by default)
 * - Cold: Infrequently accessed (> 30 days by default)
 *
 * Features:
 * - Automatic tier migration based on access patterns
 * - Configurable tier policies
 * - Access tracking for intelligent placement
 * - Cost optimization through tier demotion
 * - Performance optimization through tier promotion
 */
import { StorageError } from './interfaces.js';
/**
 * Time duration constants in milliseconds
 */
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
/**
 * Default tier policy thresholds
 */
const DEFAULT_HOT_THRESHOLD_DAYS = 1;
const DEFAULT_WARM_THRESHOLD_DAYS = 30;
/**
 * Default tier policy
 */
const DEFAULT_TIER_POLICY = {
    hotMaxAgeDays: DEFAULT_HOT_THRESHOLD_DAYS,
    warmMaxAgeDays: DEFAULT_WARM_THRESHOLD_DAYS,
    autoPromote: true,
    autoDemote: true,
    coldMinSize: 0,
};
/**
 * TieredR2Storage - Intelligent tiered storage using R2
 *
 * Automatically manages file placement across hot/warm/cold tiers
 * based on access patterns and configurable policies.
 *
 * @example
 * ```typescript
 * const storage = new TieredR2Storage({
 *   hotBucket: env.R2_HOT,
 *   warmBucket: env.R2_WARM,
 *   coldBucket: env.R2_COLD,
 *   policy: {
 *     hotMaxAgeDays: 1,
 *     warmMaxAgeDays: 30,
 *     autoPromote: true,
 *     autoDemote: true,
 *   }
 * })
 *
 * // Write - automatically placed in appropriate tier
 * await storage.put('/data/file.json', data)
 *
 * // Read - automatically promoted if frequently accessed
 * const result = await storage.get('/data/file.json')
 * console.log(`Read from ${result.tier} tier`)
 *
 * // Manual tier management
 * await storage.promote('/data/important.json', 'hot')
 * await storage.demote('/data/archive.json', 'cold')
 * ```
 */
export class TieredR2Storage {
    hotBucket;
    warmBucket;
    coldBucket;
    prefix;
    policy;
    sql;
    initialized = false;
    constructor(config) {
        this.hotBucket = config.hotBucket;
        this.warmBucket = config.warmBucket ?? config.hotBucket;
        this.coldBucket = config.coldBucket ?? config.warmBucket ?? config.hotBucket;
        this.prefix = config.prefix ?? '';
        this.policy = { ...DEFAULT_TIER_POLICY, ...config.policy };
        this.sql = config.sql;
    }
    /**
     * Initialize metadata tracking table if SQL storage is available
     */
    async ensureInitialized() {
        if (this.initialized || !this.sql)
            return;
        await this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tiered_access_metadata (
        key TEXT PRIMARY KEY,
        tier TEXT NOT NULL DEFAULT 'hot' CHECK(tier IN ('hot', 'warm', 'cold')),
        last_access INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tiered_tier ON tiered_access_metadata(tier);
      CREATE INDEX IF NOT EXISTS idx_tiered_last_access ON tiered_access_metadata(last_access);
    `);
        this.initialized = true;
    }
    /**
     * Get full key with prefix
     */
    key(path) {
        return this.prefix + path;
    }
    /**
     * Get the R2 bucket for a given tier
     */
    getBucket(tier) {
        switch (tier) {
            case 'hot':
                return this.hotBucket;
            case 'warm':
                return this.warmBucket;
            case 'cold':
                return this.coldBucket;
        }
    }
    /**
     * Determine the appropriate tier based on access pattern
     * @internal Reserved for automatic tier migration based on access patterns
     */
    // Reserved for future tier migration implementation
    _determineTierByAge(lastAccess, now = Date.now()) {
        const ageMs = now - lastAccess;
        const ageDays = ageMs / MS_PER_DAY;
        if (ageDays < this.policy.hotMaxAgeDays) {
            return 'hot';
        }
        else if (ageDays < this.policy.warmMaxAgeDays) {
            return 'warm';
        }
        else {
            return 'cold';
        }
    }
    /**
     * Parse tier metadata from R2 custom metadata
     */
    parseMetadata(customMetadata) {
        if (!customMetadata)
            return null;
        try {
            return {
                tier: customMetadata['x-tier'] ?? 'hot',
                lastAccess: parseInt(customMetadata['x-last-access'] ?? '0', 10),
                accessCount: parseInt(customMetadata['x-access-count'] ?? '0', 10),
                createdAt: parseInt(customMetadata['x-created-at'] ?? '0', 10),
                contentHash: customMetadata['x-content-hash'],
                originalPath: customMetadata['x-original-path'],
            };
        }
        catch {
            return null;
        }
    }
    /**
     * Create tier metadata for R2 custom metadata
     */
    createMetadata(tier, existingMeta, path) {
        const now = Date.now();
        return {
            'x-tier': tier,
            'x-last-access': String(now),
            'x-access-count': String((existingMeta?.accessCount ?? 0) + 1),
            'x-created-at': String(existingMeta?.createdAt ?? now),
            'x-original-path': path ?? existingMeta?.originalPath ?? '',
        };
    }
    /**
     * Update access metadata in SQLite
     */
    async updateAccessMetadata(key, tier, size) {
        if (!this.sql)
            return;
        await this.ensureInitialized();
        const now = Date.now();
        const existing = await this.sql.exec('SELECT * FROM tiered_access_metadata WHERE key = ?', key).one();
        if (existing) {
            await this.sql.exec('UPDATE tiered_access_metadata SET tier = ?, last_access = ?, access_count = access_count + 1, size = ? WHERE key = ?', tier, now, size, key);
        }
        else {
            await this.sql.exec('INSERT INTO tiered_access_metadata (key, tier, last_access, access_count, size, created_at) VALUES (?, ?, ?, ?, ?, ?)', key, tier, now, 1, size, now);
        }
    }
    /**
     * Get access metadata from SQLite
     * @internal Reserved for future tier migration based on access patterns
     */
    // Reserved for future tier migration implementation
    async _getAccessMetadata(key) {
        if (!this.sql)
            return null;
        await this.ensureInitialized();
        return this.sql.exec('SELECT * FROM tiered_access_metadata WHERE key = ?', key).one();
    }
    /**
     * Store a file with automatic tier selection
     *
     * @param path - File path/key
     * @param data - File data
     * @param options - Storage options
     * @returns Write result with tier information
     */
    async put(path, data, options) {
        const key = this.key(path);
        void Date.now(); // Timestamp available for future tracking
        // Determine initial tier
        const tier = options?.tier ?? 'hot';
        const bucket = this.getBucket(tier);
        // Create metadata
        const metadata = this.createMetadata(tier, null, path);
        const combinedMetadata = { ...metadata, ...(options?.customMetadata ?? {}) };
        // Store the object
        const object = await bucket.put(key, data, {
            httpMetadata: options?.contentType ? { contentType: options.contentType } : undefined,
            customMetadata: combinedMetadata,
        });
        // Update SQLite tracking
        await this.updateAccessMetadata(key, tier, object.size);
        return {
            tier,
            migrated: false,
            etag: object.etag,
            size: object.size,
        };
    }
    /**
     * Retrieve a file with automatic tier promotion
     *
     * @param path - File path/key
     * @returns Read result with data and tier information
     */
    async get(path) {
        const key = this.key(path);
        // Track which buckets we've already checked (for when same bucket is used for multiple tiers)
        const checkedBuckets = new Set();
        // Try to find the object in each tier, starting with hot
        for (const tier of ['hot', 'warm', 'cold']) {
            const bucket = this.getBucket(tier);
            // Skip if we've already checked this bucket
            if (checkedBuckets.has(bucket)) {
                continue;
            }
            checkedBuckets.add(bucket);
            const object = await bucket.get(key);
            if (object) {
                const data = new Uint8Array(await object.arrayBuffer());
                const existingMeta = this.parseMetadata(object.customMetadata);
                // Use the tier from metadata if available, otherwise use the bucket's tier
                const actualTier = existingMeta?.tier ?? tier;
                // Update access metadata
                await this.updateAccessMetadata(key, actualTier, data.length);
                // Check if promotion is needed
                if (this.policy.autoPromote && actualTier !== 'hot') {
                    const shouldPromote = this.shouldPromote(existingMeta);
                    if (shouldPromote) {
                        const newTier = actualTier === 'cold' ? 'warm' : 'hot';
                        await this.migrateInternal(key, data, actualTier, newTier, existingMeta, object.httpMetadata);
                        return {
                            data,
                            metadata: object,
                            tier: newTier,
                            migrated: true,
                            previousTier: actualTier,
                        };
                    }
                }
                // Update last access metadata in place
                const updatedMeta = this.createMetadata(actualTier, existingMeta, path);
                await bucket.put(key, data, {
                    httpMetadata: object.httpMetadata,
                    customMetadata: updatedMeta,
                });
                return {
                    data,
                    metadata: object,
                    tier: actualTier,
                    migrated: false,
                };
            }
        }
        return null;
    }
    /**
     * Get a file as a stream
     */
    async getStream(path) {
        const key = this.key(path);
        for (const tier of ['hot', 'warm', 'cold']) {
            const bucket = this.getBucket(tier);
            const object = await bucket.get(key);
            if (object) {
                // Update access tracking
                await this.updateAccessMetadata(key, tier, object.size);
                return { stream: object.body, metadata: object, tier };
            }
        }
        return null;
    }
    /**
     * Get a range of bytes from a file
     */
    async getRange(path, start, end) {
        const key = this.key(path);
        const range = end !== undefined ? { offset: start, length: end - start + 1 } : { offset: start };
        for (const tier of ['hot', 'warm', 'cold']) {
            const bucket = this.getBucket(tier);
            const object = await bucket.get(key, { range });
            if (object) {
                const data = new Uint8Array(await object.arrayBuffer());
                await this.updateAccessMetadata(key, tier, object.size);
                return { data, metadata: object, tier };
            }
        }
        return null;
    }
    /**
     * Check if a file exists
     */
    async exists(path) {
        const key = this.key(path);
        const checkedBuckets = new Set();
        for (const tier of ['hot', 'warm', 'cold']) {
            const bucket = this.getBucket(tier);
            if (checkedBuckets.has(bucket)) {
                continue;
            }
            checkedBuckets.add(bucket);
            const object = await bucket.head(key);
            if (object) {
                // Use tier from metadata if available
                const existingMeta = this.parseMetadata(object.customMetadata);
                const actualTier = existingMeta?.tier ?? tier;
                return { exists: true, tier: actualTier };
            }
        }
        return { exists: false };
    }
    /**
     * Get file metadata without downloading
     */
    async head(path) {
        const key = this.key(path);
        const checkedBuckets = new Set();
        for (const tier of ['hot', 'warm', 'cold']) {
            const bucket = this.getBucket(tier);
            if (checkedBuckets.has(bucket)) {
                continue;
            }
            checkedBuckets.add(bucket);
            const object = await bucket.head(key);
            if (object) {
                // Use tier from metadata if available
                const existingMeta = this.parseMetadata(object.customMetadata);
                const actualTier = existingMeta?.tier ?? tier;
                return { metadata: object, tier: actualTier };
            }
        }
        return null;
    }
    /**
     * Delete a file from all tiers
     */
    async delete(path) {
        const key = this.key(path);
        // Delete from all tiers to ensure cleanup
        await Promise.all([this.hotBucket.delete(key), this.warmBucket.delete(key), this.coldBucket.delete(key)]);
        // Remove from SQLite tracking
        if (this.sql) {
            await this.ensureInitialized();
            await this.sql.exec('DELETE FROM tiered_access_metadata WHERE key = ?', key);
        }
    }
    /**
     * Delete multiple files
     */
    async deleteMany(paths) {
        const keys = paths.map((p) => this.key(p));
        // Delete from all tiers
        await Promise.all([this.hotBucket.delete(keys), this.warmBucket.delete(keys), this.coldBucket.delete(keys)]);
        // Remove from SQLite tracking
        if (this.sql && keys.length > 0) {
            await this.ensureInitialized();
            const placeholders = keys.map(() => '?').join(',');
            await this.sql.exec(`DELETE FROM tiered_access_metadata WHERE key IN (${placeholders})`, ...keys);
        }
    }
    /**
     * Determine if a file should be promoted based on access pattern
     */
    shouldPromote(metadata) {
        if (!metadata)
            return false;
        const now = Date.now();
        const ageMs = now - metadata.lastAccess;
        const ageDays = ageMs / MS_PER_DAY;
        // Promote if accessed recently (within hot threshold)
        if (ageDays < this.policy.hotMaxAgeDays) {
            return true;
        }
        // Promote if accessed frequently (more than 5 times in warm period)
        if (metadata.accessCount > 5 && ageDays < this.policy.warmMaxAgeDays) {
            return true;
        }
        return false;
    }
    /**
     * Internal migration between tiers
     */
    async migrateInternal(key, data, fromTier, toTier, existingMeta, httpMetadata) {
        const toBucket = this.getBucket(toTier);
        const fromBucket = this.getBucket(fromTier);
        // Create updated metadata
        const metadata = this.createMetadata(toTier, existingMeta);
        // Write to new tier
        await toBucket.put(key, data, {
            httpMetadata,
            customMetadata: metadata,
        });
        // Delete from old tier (only if different buckets)
        if (toBucket !== fromBucket) {
            await fromBucket.delete(key);
        }
        // Update SQLite tracking
        await this.updateAccessMetadata(key, toTier, data.length);
    }
    /**
     * Manually promote a file to a higher tier
     *
     * @param path - File path
     * @param targetTier - Target tier ('hot' or 'warm')
     */
    async promote(path, targetTier) {
        const key = this.key(path);
        const checkedBuckets = new Set();
        // Find current location by checking all unique buckets
        for (const tier of ['hot', 'warm', 'cold']) {
            const bucket = this.getBucket(tier);
            if (checkedBuckets.has(bucket)) {
                continue;
            }
            checkedBuckets.add(bucket);
            const object = await bucket.get(key);
            if (object) {
                const data = new Uint8Array(await object.arrayBuffer());
                const existingMeta = this.parseMetadata(object.customMetadata);
                // Use tier from metadata if available
                const currentTier = existingMeta?.tier ?? tier;
                // Check if already at or above target tier
                if (currentTier === targetTier) {
                    return { tier: currentTier, migrated: false };
                }
                if (targetTier === 'warm' && currentTier === 'hot') {
                    return { tier: currentTier, migrated: false };
                }
                await this.migrateInternal(key, data, currentTier, targetTier, existingMeta, object.httpMetadata);
                return {
                    tier: targetTier,
                    migrated: true,
                    previousTier: currentTier,
                };
            }
        }
        throw StorageError.notFound(path, 'promote');
    }
    /**
     * Manually demote a file to a lower tier
     *
     * @param path - File path
     * @param targetTier - Target tier ('warm' or 'cold')
     */
    async demote(path, targetTier) {
        const key = this.key(path);
        const checkedBuckets = new Set();
        // Find current location by checking all unique buckets
        for (const tier of ['hot', 'warm', 'cold']) {
            const bucket = this.getBucket(tier);
            if (checkedBuckets.has(bucket)) {
                continue;
            }
            checkedBuckets.add(bucket);
            const object = await bucket.get(key);
            if (object) {
                const data = new Uint8Array(await object.arrayBuffer());
                const existingMeta = this.parseMetadata(object.customMetadata);
                // Use tier from metadata if available
                const currentTier = existingMeta?.tier ?? tier;
                // Check if already at or below target tier
                if (currentTier === targetTier) {
                    return { tier: currentTier, migrated: false };
                }
                if (targetTier === 'warm' && currentTier === 'cold') {
                    return { tier: currentTier, migrated: false };
                }
                await this.migrateInternal(key, data, currentTier, targetTier, existingMeta, object.httpMetadata);
                return {
                    tier: targetTier,
                    migrated: true,
                    previousTier: currentTier,
                };
            }
        }
        throw StorageError.notFound(path, 'demote');
    }
    /**
     * Get the current tier for a file
     */
    async getTier(path) {
        const result = await this.exists(path);
        return result.tier ?? null;
    }
    /**
     * Run automatic tier migration based on access patterns
     *
     * This should be called periodically (e.g., via cron) to demote
     * infrequently accessed files to lower tiers.
     *
     * @param options - Migration options
     * @returns Number of files migrated
     */
    async runMigration(options) {
        if (!this.sql) {
            return { promoted: 0, demoted: 0, errors: ['SQLite storage not available for migration'] };
        }
        await this.ensureInitialized();
        const now = Date.now();
        const hotThreshold = now - this.policy.hotMaxAgeDays * MS_PER_DAY;
        const warmThreshold = now - this.policy.warmMaxAgeDays * MS_PER_DAY;
        const limit = options?.limit ?? 100;
        let promoted = 0;
        let demoted = 0;
        const errors = [];
        // Find files to demote from hot to warm
        const hotToWarm = this.sql
            .exec('SELECT * FROM tiered_access_metadata WHERE tier = ? AND last_access < ? LIMIT ?', 'hot', hotThreshold, limit)
            .toArray();
        for (const row of hotToWarm) {
            try {
                if (!options?.dryRun) {
                    await this.demote(row.key.replace(this.prefix, ''), 'warm');
                }
                demoted++;
            }
            catch (e) {
                errors.push(`Failed to demote ${row.key}: ${e}`);
            }
        }
        // Find files to demote from warm to cold
        const warmToCold = this.sql
            .exec('SELECT * FROM tiered_access_metadata WHERE tier = ? AND last_access < ? LIMIT ?', 'warm', warmThreshold, limit)
            .toArray();
        for (const row of warmToCold) {
            try {
                if (!options?.dryRun) {
                    await this.demote(row.key.replace(this.prefix, ''), 'cold');
                }
                demoted++;
            }
            catch (e) {
                errors.push(`Failed to demote ${row.key}: ${e}`);
            }
        }
        return { promoted, demoted, errors };
    }
    /**
     * Get storage statistics by tier
     */
    async getStats() {
        if (!this.sql) {
            return {
                hot: { count: 0, totalSize: 0 },
                warm: { count: 0, totalSize: 0 },
                cold: { count: 0, totalSize: 0 },
            };
        }
        await this.ensureInitialized();
        const stats = this.sql
            .exec('SELECT tier, COUNT(*) as count, SUM(size) as total_size FROM tiered_access_metadata GROUP BY tier')
            .toArray();
        const result = {
            hot: { count: 0, totalSize: 0 },
            warm: { count: 0, totalSize: 0 },
            cold: { count: 0, totalSize: 0 },
        };
        for (const row of stats) {
            const tier = row.tier;
            result[tier] = { count: row.count, totalSize: row.total_size ?? 0 };
        }
        return result;
    }
    /**
     * List files in a specific tier
     */
    async listByTier(tier, options) {
        const bucket = this.getBucket(tier);
        const fullPrefix = options?.prefix ? this.key(options.prefix) : this.prefix;
        return bucket.list({
            prefix: fullPrefix,
            limit: options?.limit,
            cursor: options?.cursor,
        });
    }
    /**
     * Copy a file within tiers
     */
    async copy(sourcePath, destPath, destTier) {
        const result = await this.get(sourcePath);
        if (!result) {
            throw new Error(`Source not found: ${sourcePath}`);
        }
        const tier = destTier ?? result.tier;
        return this.put(destPath, result.data, { tier });
    }
}
//# sourceMappingURL=tiered-r2.js.map