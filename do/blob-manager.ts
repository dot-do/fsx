/**
 * BlobManager - Manages blob storage and reference counting
 *
 * Handles content-addressable blob storage with:
 * - Deduplication via SHA-256 checksums
 * - Reference counting for shared blobs
 * - Tiered storage (hot/warm/cold)
 * - Cleanup of orphaned blobs
 *
 * @module do/blob-manager
 */

import {
  computeChecksum,
  blobIdFromChecksum,
  type CleanupConfig,
  type CleanupResult,
  type CleanupSchedulerState,
  createCleanupSchedulerState,
  DEFAULT_CLEANUP_CONFIG,
} from '../storage/blob-utils.js'

/**
 * Storage tiers for blob data.
 * - hot: SQLite storage (fast, limited size)
 * - warm: R2 storage (medium latency, larger files)
 * - cold: Archive R2 storage (slow, archival)
 */
export type StorageTier = 'hot' | 'warm' | 'cold'

/**
 * Blob metadata from database
 */
export interface BlobMetadata {
  id: string
  size: number
  checksum: string
  tier: StorageTier
  ref_count: number
  created_at: number
}

/**
 * Blob with data
 */
export interface BlobWithData {
  id: string
  data: Uint8Array
  size: number
  checksum: string
  tier: StorageTier
}

/**
 * Blob info returned for file lookups
 */
export interface BlobInfo {
  blobId: string
  size: number
  checksum: string
  tier: StorageTier
  refCount: number
  createdAt: number
}

/**
 * Tier statistics
 */
export interface TierStats {
  hot: { count: number; totalSize: number }
  warm: { count: number; totalSize: number }
  cold: { count: number; totalSize: number }
}

/**
 * Deduplication statistics
 */
export interface DedupStats {
  totalBlobs: number
  uniqueBlobs: number
  totalRefs: number
  dedupRatio: number
  savedBytes: number
}

/**
 * Configuration for BlobManager
 */
export interface BlobManagerConfig {
  /** SQLite storage instance */
  sql: SqlStorage
  /** Optional R2 bucket for warm tier */
  r2?: R2Bucket
  /** Optional R2 bucket for cold/archive tier */
  archive?: R2Bucket
  /** Configuration for scheduled cleanup */
  cleanupConfig?: CleanupConfig
}

/**
 * BlobManager - Handles all blob storage operations
 *
 * This class encapsulates:
 * - Content-addressable storage with SHA-256 hashing
 * - Reference counting for deduplication
 * - Tiered storage management (hot/warm/cold)
 * - Orphaned blob cleanup
 */
export class BlobManager {
  private sql: SqlStorage
  private r2?: R2Bucket
  private archive?: R2Bucket
  private cleanupConfig: Required<CleanupConfig>
  private cleanupState: CleanupSchedulerState

  constructor(config: BlobManagerConfig) {
    this.sql = config.sql
    this.r2 = config.r2
    this.archive = config.archive
    this.cleanupConfig = { ...DEFAULT_CLEANUP_CONFIG, ...config.cleanupConfig }
    this.cleanupState = createCleanupSchedulerState()
  }

  // ===========================================================================
  // CORE BLOB OPERATIONS
  // ===========================================================================

  /**
   * Compute SHA-256 checksum of data.
   */
  async computeChecksum(data: Uint8Array): Promise<string> {
    return computeChecksum(data)
  }

  /**
   * Generate content-addressable blob ID from checksum.
   */
  generateBlobId(checksum: string): string {
    return blobIdFromChecksum(checksum)
  }

  /**
   * Store blob with content-addressable ID and reference counting.
   * If blob already exists (same content), just increment ref_count.
   * Returns the blob ID.
   */
  async store(data: Uint8Array, tier: StorageTier): Promise<string> {
    const now = Date.now()
    const checksum = await this.computeChecksum(data)
    const blobId = this.generateBlobId(checksum)

    // Check if blob already exists (deduplication)
    const existing = this.sql
      .exec<{ id: string; ref_count: number; tier: string }>('SELECT id, ref_count, tier FROM blobs WHERE id = ?', blobId)
      .toArray()

    if (existing.length > 0) {
      // Blob exists - increment ref_count
      this.sql.exec('UPDATE blobs SET ref_count = ref_count + 1 WHERE id = ?', blobId)
      return blobId
    }

    // New blob - store with ref_count = 1
    if (tier === 'hot') {
      this.sql.exec(
        'INSERT INTO blobs (id, data, size, checksum, tier, ref_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        blobId,
        data.buffer,
        data.length,
        checksum,
        tier,
        1,
        now
      )
    } else if (tier === 'warm' && this.r2) {
      await this.r2.put(blobId, data)
      this.sql.exec(
        'INSERT INTO blobs (id, size, checksum, tier, ref_count, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        blobId,
        data.length,
        checksum,
        tier,
        1,
        now
      )
    } else if (tier === 'cold' && this.archive) {
      await this.archive.put(blobId, data)
      this.sql.exec(
        'INSERT INTO blobs (id, size, checksum, tier, ref_count, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        blobId,
        data.length,
        checksum,
        tier,
        1,
        now
      )
    }

    return blobId
  }

  /**
   * Get blob data by ID.
   */
  async get(id: string, tier: StorageTier): Promise<Uint8Array | null> {
    if (tier === 'hot') {
      const blobs = this.sql.exec<{ data: ArrayBuffer }>('SELECT data FROM blobs WHERE id = ?', id).toArray()
      if (blobs.length === 0 || !blobs[0]?.data) return null
      return new Uint8Array(blobs[0].data)
    }

    if (tier === 'warm' && this.r2) {
      const obj = await this.r2.get(id)
      if (!obj) return null
      return new Uint8Array(await obj.arrayBuffer())
    }

    if (tier === 'cold' && this.archive) {
      const obj = await this.archive.get(id)
      if (!obj) return null
      return new Uint8Array(await obj.arrayBuffer())
    }

    return null
  }

  /**
   * Decrement blob reference count. If ref_count reaches 0, delete the blob.
   */
  async decrementRef(blobId: string, tier: StorageTier): Promise<void> {
    const blob = this.sql.exec<{ ref_count: number }>('SELECT ref_count FROM blobs WHERE id = ?', blobId).toArray()

    if (blob.length === 0) return

    const firstBlob = blob[0]
    if (!firstBlob) return

    const newRefCount = firstBlob.ref_count - 1

    if (newRefCount <= 0) {
      await this.deleteCompletely(blobId, tier)
    } else {
      this.sql.exec('UPDATE blobs SET ref_count = ? WHERE id = ?', newRefCount, blobId)
    }
  }

  /**
   * Increment blob reference count (for hard links).
   */
  incrementRef(blobId: string): void {
    this.sql.exec('UPDATE blobs SET ref_count = ref_count + 1 WHERE id = ?', blobId)
  }

  /**
   * Completely delete a blob from storage.
   */
  async deleteCompletely(blobId: string, tier: StorageTier): Promise<void> {
    this.sql.exec('DELETE FROM blobs WHERE id = ?', blobId)

    if (tier === 'warm' && this.r2) {
      await this.r2.delete(blobId)
    } else if (tier === 'cold' && this.archive) {
      await this.archive.delete(blobId)
    }
  }

  /**
   * Delete blob (legacy method for compatibility).
   */
  async delete(id: string, tier: StorageTier): Promise<void> {
    await this.deleteCompletely(id, tier)
  }

  // ===========================================================================
  // TIER MANAGEMENT
  // ===========================================================================

  /**
   * Move a blob from one tier to another, preserving its ID and ref_count.
   */
  async moveToTier(blobId: string, data: Uint8Array, fromTier: StorageTier, toTier: StorageTier): Promise<void> {
    // Store data in new tier
    if (toTier === 'hot') {
      this.sql.exec('UPDATE blobs SET data = ?, tier = ? WHERE id = ?', data.buffer, toTier, blobId)
    } else if (toTier === 'warm' && this.r2) {
      await this.r2.put(blobId, data)
      this.sql.exec('UPDATE blobs SET data = NULL, tier = ? WHERE id = ?', toTier, blobId)
    } else if (toTier === 'cold' && this.archive) {
      await this.archive.put(blobId, data)
      this.sql.exec('UPDATE blobs SET data = NULL, tier = ? WHERE id = ?', toTier, blobId)
    }

    // Clean up old tier data
    if (fromTier === 'warm' && this.r2) {
      await this.r2.delete(blobId)
    } else if (fromTier === 'cold' && this.archive) {
      await this.archive.delete(blobId)
    }
    // Hot tier data is overwritten in place, no cleanup needed
  }

  // ===========================================================================
  // BLOB INFORMATION
  // ===========================================================================

  /**
   * Get blob metadata by ID.
   */
  async getInfo(blobId: string): Promise<BlobMetadata | null> {
    const blob = this.sql
      .exec<{
        id: string
        size: number
        checksum: string
        tier: string
        ref_count: number
        created_at: number
      }>('SELECT id, size, checksum, tier, ref_count, created_at FROM blobs WHERE id = ?', blobId)
      .toArray()

    const firstBlob = blob[0]
    if (!firstBlob) return null

    return {
      id: firstBlob.id,
      size: firstBlob.size,
      checksum: firstBlob.checksum,
      tier: firstBlob.tier as StorageTier,
      ref_count: firstBlob.ref_count,
      created_at: firstBlob.created_at,
    }
  }

  /**
   * Get blob with data by ID.
   */
  async getById(blobId: string): Promise<BlobWithData | null> {
    const blobMeta = this.sql
      .exec<{
        id: string
        size: number
        checksum: string
        tier: string
      }>('SELECT id, size, checksum, tier FROM blobs WHERE id = ?', blobId)
      .toArray()

    const firstBlobMeta = blobMeta[0]
    if (!firstBlobMeta) return null

    const tier = firstBlobMeta.tier as StorageTier
    const data = await this.get(blobId, tier)

    if (!data) return null

    return {
      id: firstBlobMeta.id,
      data,
      size: firstBlobMeta.size,
      checksum: firstBlobMeta.checksum,
      tier,
    }
  }

  /**
   * Get reference count for a blob.
   */
  async getRefCount(blobId: string): Promise<number> {
    const blob = this.sql.exec<{ ref_count: number }>('SELECT ref_count FROM blobs WHERE id = ?', blobId).toArray()
    const firstBlob = blob[0]
    return firstBlob ? firstBlob.ref_count : 0
  }

  /**
   * Verify blob integrity by checking checksum.
   */
  async verifyIntegrity(blobId: string): Promise<{
    valid: boolean
    storedChecksum: string
    actualChecksum: string
    size: number
  }> {
    const blobMeta = this.sql
      .exec<{
        id: string
        size: number
        checksum: string
        tier: string
      }>('SELECT id, size, checksum, tier FROM blobs WHERE id = ?', blobId)
      .toArray()

    const firstBlobMeta = blobMeta[0]
    if (!firstBlobMeta) {
      throw new Error(`Blob not found: ${blobId}`)
    }

    const tier = firstBlobMeta.tier as StorageTier
    const data = await this.get(blobId, tier)

    if (!data) {
      throw new Error(`Blob data not found: ${blobId}`)
    }

    const actualChecksum = await this.computeChecksum(data)
    const storedChecksum = firstBlobMeta.checksum

    return {
      valid: actualChecksum === storedChecksum,
      storedChecksum,
      actualChecksum,
      size: data.length,
    }
  }

  /**
   * Verify a checksum matches for given data content.
   */
  async verifyChecksum(checksum: string, content: string | Uint8Array): Promise<boolean> {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content
    const actualChecksum = await this.computeChecksum(data)
    return actualChecksum === checksum
  }

  // ===========================================================================
  // STATISTICS
  // ===========================================================================

  /**
   * Get statistics about blobs by storage tier.
   */
  async getTierStats(): Promise<TierStats> {
    const stats = this.sql
      .exec<{ tier: string; count: number; total_size: number }>(
        'SELECT tier, COUNT(*) as count, COALESCE(SUM(size), 0) as total_size FROM blobs GROUP BY tier'
      )
      .toArray()

    const result: TierStats = {
      hot: { count: 0, totalSize: 0 },
      warm: { count: 0, totalSize: 0 },
      cold: { count: 0, totalSize: 0 },
    }

    for (const s of stats) {
      const tier = s.tier as StorageTier
      result[tier] = { count: s.count, totalSize: s.total_size }
    }

    return result
  }

  /**
   * Get deduplication statistics.
   */
  async getDedupStats(): Promise<DedupStats> {
    const blobStats = this.sql
      .exec<{ total: number; total_refs: number; total_size: number }>(
        'SELECT COUNT(*) as total, COALESCE(SUM(ref_count), 0) as total_refs, COALESCE(SUM(size), 0) as total_size FROM blobs'
      )
      .toArray()

    const totalBlobs = blobStats[0]?.total ?? 0
    const totalRefs = blobStats[0]?.total_refs ?? 0
    const totalSize = blobStats[0]?.total_size ?? 0

    const uniqueBlobs = totalBlobs
    const dedupRatio = totalBlobs > 0 ? totalRefs / totalBlobs : 1
    const avgBlobSize = totalBlobs > 0 ? totalSize / totalBlobs : 0
    const savedBytes = Math.max(0, (totalRefs - totalBlobs) * avgBlobSize)

    return {
      totalBlobs,
      uniqueBlobs,
      totalRefs,
      dedupRatio,
      savedBytes: Math.round(savedBytes),
    }
  }

  // ===========================================================================
  // ORPHAN CLEANUP
  // ===========================================================================

  /**
   * List all orphaned blobs (blobs with ref_count = 0).
   */
  async listOrphaned(): Promise<string[]> {
    const blobs = this.sql.exec<{ id: string }>('SELECT id FROM blobs WHERE ref_count = 0').toArray()
    return blobs.map((b) => b.id)
  }

  /**
   * Count orphaned blobs.
   */
  private async countOrphaned(): Promise<number> {
    const result = this.sql.exec<{ count: number }>('SELECT COUNT(*) as count FROM blobs WHERE ref_count = 0').toArray()
    return result[0]?.count ?? 0
  }

  /**
   * Clean up all orphaned blobs.
   */
  async cleanupOrphaned(): Promise<number> {
    const orphaned = await this.listOrphaned()

    for (const blobId of orphaned) {
      const blobMeta = this.sql.exec<{ tier: string }>('SELECT tier FROM blobs WHERE id = ?', blobId).toArray()
      const firstMeta = blobMeta[0]
      if (firstMeta) {
        const tier = firstMeta.tier as StorageTier
        await this.deleteCompletely(blobId, tier)
      }
    }

    return orphaned.length
  }

  // ===========================================================================
  // SCHEDULED CLEANUP
  // ===========================================================================

  /**
   * Get the current cleanup scheduler state.
   */
  getCleanupState(): CleanupSchedulerState {
    return { ...this.cleanupState }
  }

  /**
   * Check if cleanup should be triggered based on current conditions.
   */
  async shouldRunCleanup(): Promise<boolean> {
    if (this.cleanupState.running) return false
    const orphanedCount = await this.countOrphaned()
    return orphanedCount >= this.cleanupConfig.minOrphanCount
  }

  /**
   * Run scheduled cleanup of orphaned blobs.
   */
  async runScheduledCleanup(force = false): Promise<CleanupResult> {
    const startTime = Date.now()

    if (!force && !(await this.shouldRunCleanup())) {
      return {
        cleaned: 0,
        skipped: 0,
        found: 0,
        durationMs: Date.now() - startTime,
      }
    }

    this.cleanupState.running = true

    try {
      const cutoffTime = Date.now() - this.cleanupConfig.minOrphanAgeMs
      const orphaned = this.sql
        .exec<{ id: string; tier: string; created_at: number }>(
          `SELECT id, tier, created_at FROM blobs
           WHERE ref_count = 0
           ORDER BY created_at ASC
           LIMIT ?`,
          this.cleanupConfig.batchSize
        )
        .toArray()

      let cleaned = 0
      let skipped = 0

      for (const blob of orphaned) {
        if (blob.created_at > cutoffTime) {
          skipped++
          continue
        }

        const tier = blob.tier as StorageTier
        await this.deleteCompletely(blob.id, tier)
        cleaned++
      }

      this.cleanupState.lastCleanup = Date.now()
      this.cleanupState.cleanupCount++
      this.cleanupState.totalCleaned += cleaned

      return {
        cleaned,
        skipped,
        found: orphaned.length,
        durationMs: Date.now() - startTime,
      }
    } finally {
      this.cleanupState.running = false
    }
  }

  /**
   * Trigger background cleanup if conditions are met.
   */
  async maybeRunBackgroundCleanup(): Promise<void> {
    if (!this.cleanupConfig.async) {
      await this.runScheduledCleanup()
      return
    }

    const shouldRun = await this.shouldRunCleanup()
    if (shouldRun) {
      queueMicrotask(async () => {
        try {
          await this.runScheduledCleanup()
        } catch {
          // Swallow errors in background cleanup
        }
      })
    }
  }

  /**
   * Get cleanup configuration.
   */
  getCleanupConfig(): Required<CleanupConfig> {
    return { ...this.cleanupConfig }
  }

  /**
   * Update cleanup configuration.
   */
  setCleanupConfig(config: Partial<CleanupConfig>): void {
    this.cleanupConfig = { ...this.cleanupConfig, ...config }
  }
}
