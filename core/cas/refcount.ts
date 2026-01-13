/**
 * Reference counting for content-addressable storage
 *
 * Tracks how many references exist to each object by its hash.
 * This enables safe deduplication: objects are only deleted when
 * their reference count drops to zero.
 */

/**
 * Storage interface for reference counts
 *
 * Reference counts are stored separately from objects to allow
 * for efficient querying and updating without touching object data.
 */
export interface RefCountStorage {
  /**
   * Get the reference count for a hash
   * @returns The current reference count, or 0 if not tracked
   */
  getRefCount(hash: string): Promise<number>

  /**
   * Set the reference count for a hash
   */
  setRefCount(hash: string, count: number): Promise<void>

  /**
   * Increment the reference count by 1
   * @returns The new reference count
   */
  incrementRefCount(hash: string): Promise<number>

  /**
   * Decrement the reference count by 1, but not below 0
   * @returns The new reference count
   */
  decrementRefCount(hash: string): Promise<number>

  /**
   * Delete the refcount entry for a hash
   */
  deleteRefCount(hash: string): Promise<void>

  /**
   * Get all refcount entries for statistics
   * @returns Map of hash to { refCount, size }
   */
  getAllRefCounts(): Promise<Map<string, { refCount: number; size: number }>>

  /**
   * Set size for a hash (called when object is first stored)
   */
  setSize(hash: string, size: number): Promise<void>

  /**
   * Get size for a hash
   */
  getSize(hash: string): Promise<number>
}

/**
 * In-memory reference count storage
 *
 * Suitable for testing and single-instance use cases.
 * For production, use a persistent storage implementation.
 */
export class InMemoryRefCountStorage implements RefCountStorage {
  private refCounts: Map<string, number> = new Map()
  private sizes: Map<string, number> = new Map()

  async getRefCount(hash: string): Promise<number> {
    return this.refCounts.get(hash.toLowerCase()) ?? 0
  }

  async setRefCount(hash: string, count: number): Promise<void> {
    if (count <= 0) {
      this.refCounts.delete(hash.toLowerCase())
    } else {
      this.refCounts.set(hash.toLowerCase(), count)
    }
  }

  async incrementRefCount(hash: string): Promise<number> {
    const normalizedHash = hash.toLowerCase()
    const current = this.refCounts.get(normalizedHash) ?? 0
    const newCount = current + 1
    this.refCounts.set(normalizedHash, newCount)
    return newCount
  }

  async decrementRefCount(hash: string): Promise<number> {
    const normalizedHash = hash.toLowerCase()
    const current = this.refCounts.get(normalizedHash) ?? 0
    const newCount = Math.max(0, current - 1)
    if (newCount === 0) {
      this.refCounts.delete(normalizedHash)
    } else {
      this.refCounts.set(normalizedHash, newCount)
    }
    return newCount
  }

  async deleteRefCount(hash: string): Promise<void> {
    const normalizedHash = hash.toLowerCase()
    this.refCounts.delete(normalizedHash)
    this.sizes.delete(normalizedHash)
  }

  async getAllRefCounts(): Promise<Map<string, { refCount: number; size: number }>> {
    const result = new Map<string, { refCount: number; size: number }>()
    for (const [hash, refCount] of this.refCounts) {
      const size = this.sizes.get(hash) ?? 0
      result.set(hash, { refCount, size })
    }
    return result
  }

  async setSize(hash: string, size: number): Promise<void> {
    this.sizes.set(hash.toLowerCase(), size)
  }

  async getSize(hash: string): Promise<number> {
    return this.sizes.get(hash.toLowerCase()) ?? 0
  }

  /**
   * Clear all data (for testing)
   */
  clear(): void {
    this.refCounts.clear()
    this.sizes.clear()
  }
}

/**
 * Deduplication statistics
 */
export interface DeduplicationStats {
  /** Number of unique objects stored */
  totalObjects: number
  /** Total number of references (including duplicates) */
  totalReferences: number
  /** Bytes saved by deduplication */
  deduplicatedBytes: number
  /** Average references per object */
  averageRefCount: number
}

/**
 * Calculate deduplication statistics from refcount data
 */
export function calculateStats(
  refCounts: Map<string, { refCount: number; size: number }>
): DeduplicationStats {
  let totalObjects = 0
  let totalReferences = 0
  let deduplicatedBytes = 0

  for (const { refCount, size } of refCounts.values()) {
    totalObjects++
    totalReferences += refCount
    // Bytes saved = (refCount - 1) * size (we only stored one copy)
    if (refCount > 1) {
      deduplicatedBytes += (refCount - 1) * size
    }
  }

  const averageRefCount = totalObjects > 0 ? totalReferences / totalObjects : 0

  return {
    totalObjects,
    totalReferences,
    deduplicatedBytes,
    averageRefCount,
  }
}
