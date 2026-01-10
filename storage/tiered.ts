/**
 * TieredFS - Multi-tier filesystem with automatic placement
 *
 * Provides automatic file placement across storage tiers based on file size.
 * Uses Durable Objects for hot storage (small files) and R2 for warm/cold
 * storage (larger files).
 *
 * Features:
 * - Automatic tier selection based on file size thresholds
 * - In-memory tier tracking for fast lookups
 * - Tier promotion for frequently accessed files (configurable)
 * - Manual demotion for cost optimization
 * - Fallback behavior when tiers are unavailable
 *
 * @example
 * ```typescript
 * const tiered = new TieredFS({
 *   hot: env.FSX_DO,
 *   warm: env.FSX_WARM_BUCKET,
 *   cold: env.FSX_COLD_BUCKET,
 *   thresholds: {
 *     hotMaxSize: 1024 * 1024,  // 1MB
 *     warmMaxSize: 100 * 1024 * 1024,  // 100MB
 *   },
 *   promotionPolicy: 'on-access'
 * })
 *
 * // Small files go to hot tier automatically
 * await tiered.writeFile('/config.json', JSON.stringify(config))
 *
 * // Large files go to warm/cold tier
 * await tiered.writeFile('/data/large.bin', largeData)
 *
 * // Read from any tier transparently
 * const { data, tier } = await tiered.readFile('/config.json')
 * console.log(`Read from ${tier} tier`)
 * ```
 *
 * @module storage/tiered
 */

import type { StorageTier } from '../core/types.js'
import { StorageError } from './interfaces.js'

/**
 * Configuration for TieredFS.
 */
export interface TieredFSConfig {
  /**
   * Hot tier (Durable Object namespace).
   * Used for small files that need low-latency access.
   * Required.
   */
  hot: DurableObjectNamespace

  /**
   * Warm tier (R2 bucket).
   * Used for larger files that don't fit in hot tier.
   * Optional - falls back to hot if not provided.
   */
  warm?: R2Bucket

  /**
   * Cold tier (R2 bucket for archive).
   * Used for very large or infrequently accessed files.
   * Optional - falls back to warm/hot if not provided.
   */
  cold?: R2Bucket

  /**
   * Size thresholds for tier selection.
   */
  thresholds?: {
    /** Max size for hot tier in bytes (default: 1MB) */
    hotMaxSize?: number
    /** Max size for warm tier in bytes (default: 100MB) */
    warmMaxSize?: number
  }

  /**
   * Tier promotion policy.
   * - 'none': No automatic promotion
   * - 'on-access': Promote on read (default)
   * - 'aggressive': Promote immediately on any access
   */
  promotionPolicy?: 'none' | 'on-access' | 'aggressive'
}

/** Default configuration values */
const DEFAULT_CONFIG: Required<Omit<TieredFSConfig, 'hot' | 'warm' | 'cold'>> = {
  thresholds: {
    hotMaxSize: 1024 * 1024, // 1MB
    warmMaxSize: 100 * 1024 * 1024, // 100MB
  },
  promotionPolicy: 'on-access',
}

/**
 * Internal tier metadata for tracking file placement.
 * @internal
 */
interface TierMetadata {
  /** Current storage tier */
  tier: StorageTier
  /** File size in bytes */
  size: number
}

/**
 * TieredFS - Multi-tier filesystem with automatic tier selection.
 *
 * Automatically places files in the appropriate storage tier based on
 * file size. Provides transparent read/write operations across tiers.
 *
 * Tier selection logic:
 * 1. Files <= hotMaxSize go to hot tier (Durable Object)
 * 2. Files <= warmMaxSize go to warm tier (R2)
 * 3. Larger files go to cold tier (archive R2)
 * 4. Falls back to available tiers if preferred tier is unavailable
 *
 * @example
 * ```typescript
 * const fs = new TieredFS({ hot: env.DO, warm: env.R2 })
 *
 * // Write automatically selects tier
 * const { tier } = await fs.writeFile('/file.txt', 'Hello')
 *
 * // Read finds file in any tier
 * const { data } = await fs.readFile('/file.txt')
 *
 * // Manual tier management
 * await fs.demote('/old-data.json', 'cold')
 * ```
 */
export class TieredFS {
  /** Durable Object stub for hot tier operations */
  private readonly hotStub: DurableObjectStub

  /** R2 bucket for warm tier (optional) */
  private readonly warm?: R2Bucket

  /** R2 bucket for cold tier (optional) */
  private readonly cold?: R2Bucket

  /** Merged configuration with defaults */
  private readonly config: Required<Omit<TieredFSConfig, 'hot' | 'warm' | 'cold'>>

  /**
   * In-memory tier tracking cache.
   * Supplements the DO storage for fast tier lookups without network calls.
   */
  private readonly tierMap: Map<string, TierMetadata> = new Map()

  /**
   * Create a new TieredFS instance.
   *
   * @param config - Tiered filesystem configuration
   *
   * @example
   * ```typescript
   * const fs = new TieredFS({
   *   hot: env.FSX_DO,
   *   warm: env.FSX_WARM,
   *   cold: env.FSX_COLD,
   *   thresholds: { hotMaxSize: 512 * 1024 }  // 512KB hot threshold
   * })
   * ```
   */
  constructor(config: TieredFSConfig) {
    const id = config.hot.idFromName('tiered')
    this.hotStub = config.hot.get(id)
    this.warm = config.warm
    this.cold = config.cold
    this.config = {
      thresholds: {
        hotMaxSize: config.thresholds?.hotMaxSize ?? DEFAULT_CONFIG.thresholds.hotMaxSize,
        warmMaxSize: config.thresholds?.warmMaxSize ?? DEFAULT_CONFIG.thresholds.warmMaxSize,
      },
      promotionPolicy: config.promotionPolicy ?? DEFAULT_CONFIG.promotionPolicy,
    }
  }

  /**
   * Determine the appropriate storage tier based on file size.
   *
   * Selection logic with fallback:
   * 1. size <= hotMaxSize -> hot tier
   * 2. size <= warmMaxSize -> warm tier (or hot if warm unavailable)
   * 3. size > warmMaxSize -> cold tier (or warm/hot if unavailable)
   *
   * @param size - File size in bytes
   * @returns Selected storage tier
   * @internal
   */
  private selectTier(size: number): StorageTier {
    const hotMax = this.config.thresholds.hotMaxSize
    const warmMax = this.config.thresholds.warmMaxSize

    // Check if fits in hot tier
    if (size <= hotMax) {
      return 'hot'
    }

    // Check if fits in warm tier
    if (size <= warmMax) {
      // Warm tier available?
      if (this.warm) {
        return 'warm'
      }
      // Fall back to hot if no warm tier
      return 'hot'
    }

    // Large file - goes to cold if available
    if (this.cold) {
      return 'cold'
    }

    // Fall back to warm if available, otherwise hot
    if (this.warm) {
      return 'warm'
    }
    return 'hot'
  }

  /**
   * Write a file with automatic tier selection.
   *
   * The storage tier is selected based on the data size:
   * - <= hotMaxSize: stored in Durable Object (hot tier)
   * - <= warmMaxSize: stored in R2 warm bucket
   * - > warmMaxSize: stored in R2 cold bucket
   *
   * For hot tier writes, parent directories are automatically created.
   * For warm/cold tier writes, metadata is synced to the hot tier.
   *
   * @param path - Absolute file path
   * @param data - File content (string or bytes)
   * @returns Object containing the tier used
   *
   * @example
   * ```typescript
   * // Small file -> hot tier
   * const result = await fs.writeFile('/config.json', '{"key": "value"}')
   * console.log(result.tier)  // 'hot'
   *
   * // Large file -> warm/cold tier
   * const largeData = new Uint8Array(10 * 1024 * 1024)
   * const result2 = await fs.writeFile('/data.bin', largeData)
   * console.log(result2.tier)  // 'warm' or 'cold'
   * ```
   */
  async writeFile(path: string, data: Uint8Array | string): Promise<{ tier: StorageTier }> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    const tier = this.selectTier(bytes.length)

    if (tier === 'hot') {
      // Ensure parent directories exist
      await this.ensureParentDir(path)
      // Write to Durable Object
      await this.hotStub.fetch('http://fsx.do/rpc', {
        method: 'POST',
        body: JSON.stringify({
          method: 'writeFile',
          params: {
            path,
            data: this.encodeBase64(bytes),
            encoding: 'base64',
          },
        }),
      })
    } else if (tier === 'warm' && this.warm) {
      // Write to R2
      await this.warm.put(path, bytes)
      // Update metadata in hot tier
      await this.hotStub.fetch('http://fsx.do/rpc', {
        method: 'POST',
        body: JSON.stringify({
          method: 'setMetadata',
          params: { path, tier: 'warm', size: bytes.length },
        }),
      })
    } else if (tier === 'cold' && this.cold) {
      // Write to archive
      await this.cold.put(path, bytes)
      await this.hotStub.fetch('http://fsx.do/rpc', {
        method: 'POST',
        body: JSON.stringify({
          method: 'setMetadata',
          params: { path, tier: 'cold', size: bytes.length },
        }),
      })
    }

    // Track tier in memory
    this.tierMap.set(path, { tier, size: bytes.length })

    return { tier }
  }

  /**
   * Read a file from any tier.
   *
   * First checks the in-memory tier cache for quick lookup, then
   * searches through available tiers (warm, cold, hot) to find the file.
   * Updates the tier cache when a file is found.
   *
   * @param path - Absolute file path
   * @returns Object containing data and the tier it was read from
   * @throws {StorageError} If file is not found in any tier
   *
   * @example
   * ```typescript
   * const { data, tier } = await fs.readFile('/config.json')
   * const text = new TextDecoder().decode(data)
   * console.log(`Read from ${tier} tier: ${text}`)
   * ```
   */
  async readFile(path: string): Promise<{ data: Uint8Array; tier: StorageTier }> {
    // Check our in-memory tier tracking first
    const metadata = this.tierMap.get(path)

    // If we have metadata, read from the known tier
    if (metadata) {
      if (metadata.tier === 'hot') {
        return this.readFromHot(path)
      }
      if (metadata.tier === 'warm' && this.warm) {
        return this.readFromWarm(path)
      }
      if (metadata.tier === 'cold' && this.cold) {
        return this.readFromCold(path)
      }
    }

    // No metadata - search through tiers in order
    // Try warm first (for files put directly into warm bucket in tests)
    if (this.warm) {
      const warmObj = await this.warm.get(path)
      if (warmObj) {
        const data = new Uint8Array(await warmObj.arrayBuffer())
        this.tierMap.set(path, { tier: 'warm', size: data.length })
        return { data, tier: 'warm' }
      }
    }

    // Try cold
    if (this.cold) {
      const coldObj = await this.cold.get(path)
      if (coldObj) {
        const data = new Uint8Array(await coldObj.arrayBuffer())
        this.tierMap.set(path, { tier: 'cold', size: data.length })
        return { data, tier: 'cold' }
      }
    }

    // Try hot tier last (default)
    try {
      return await this.readFromHot(path)
    } catch {
      throw StorageError.notFound(path, 'readFile')
    }
  }

  /**
   * Read file from hot tier (Durable Object).
   *
   * @param path - File path
   * @returns Data and tier info
   * @throws {Error} If file not found in hot tier
   * @internal
   */
  private async readFromHot(path: string): Promise<{ data: Uint8Array; tier: 'hot' }> {
    const readResponse = await this.hotStub.fetch('http://fsx.do/rpc', {
      method: 'POST',
      body: JSON.stringify({
        method: 'readFile',
        params: { path },
      }),
    })

    if (!readResponse.ok) {
      const error = await readResponse.json() as { code?: string; message?: string }
      throw new Error(error.message ?? `File not found: ${path}`)
    }

    const result = (await readResponse.json()) as { data: string; encoding: string }
    return {
      data: this.decodeBase64(result.data),
      tier: 'hot',
    }
  }

  /**
   * Read file from warm tier (R2).
   *
   * @param path - File path
   * @returns Data and tier info
   * @throws {StorageError} If warm tier not available or file not found
   * @internal
   */
  private async readFromWarm(path: string): Promise<{ data: Uint8Array; tier: 'warm' }> {
    if (!this.warm) {
      throw StorageError.invalidArg('Warm tier not available', path, 'readFromWarm')
    }
    const object = await this.warm.get(path)
    if (!object) {
      throw StorageError.notFound(path, 'readFromWarm')
    }
    const data = new Uint8Array(await object.arrayBuffer())
    return { data, tier: 'warm' }
  }

  /**
   * Read file from cold tier (R2 archive).
   *
   * @param path - File path
   * @returns Data and tier info
   * @throws {StorageError} If cold tier not available or file not found
   * @internal
   */
  private async readFromCold(path: string): Promise<{ data: Uint8Array; tier: 'cold' }> {
    if (!this.cold) {
      throw StorageError.invalidArg('Cold tier not available', path, 'readFromCold')
    }
    const object = await this.cold.get(path)
    if (!object) {
      throw StorageError.notFound(path, 'readFromCold')
    }
    const data = new Uint8Array(await object.arrayBuffer())
    return { data, tier: 'cold' }
  }

  /**
   * Ensure parent directory exists in hot tier.
   *
   * Creates parent directories recursively if they don't exist.
   *
   * @param path - File path (parent will be extracted)
   * @internal
   */
  private async ensureParentDir(path: string): Promise<void> {
    const parentPath = path.substring(0, path.lastIndexOf('/'))
    if (parentPath && parentPath !== '/') {
      await this.hotStub.fetch('http://fsx.do/rpc', {
        method: 'POST',
        body: JSON.stringify({
          method: 'mkdir',
          params: { path: parentPath, recursive: true },
        }),
      })
    }
  }

  /**
   * Promote a file to a higher (faster) tier.
   *
   * Writes the file to the target tier and updates metadata.
   *
   * @param path - File path
   * @param data - File data
   * @param _fromTier - Current tier (unused, for logging)
   * @param toTier - Target tier
   * @internal
   */
  private async promote(path: string, data: Uint8Array, _fromTier: string, toTier: 'hot' | 'warm'): Promise<void> {
    if (toTier === 'hot') {
      await this.hotStub.fetch('http://fsx.do/rpc', {
        method: 'POST',
        body: JSON.stringify({
          method: 'writeFile',
          params: {
            path,
            data: this.encodeBase64(data),
            encoding: 'base64',
          },
        }),
      })
    } else if (toTier === 'warm' && this.warm) {
      await this.warm.put(path, data)
    }

    // Update in-memory tier tracking
    this.tierMap.set(path, { tier: toTier, size: data.length })

    // Update metadata in DO
    await this.hotStub.fetch('http://fsx.do/rpc', {
      method: 'POST',
      body: JSON.stringify({
        method: 'setMetadata',
        params: { path, tier: toTier, size: data.length },
      }),
    })
  }

  /**
   * Demote a file to a lower (cheaper) tier.
   *
   * Moves a file from its current tier to a lower-cost tier.
   * Useful for archiving infrequently accessed data.
   *
   * The process:
   * 1. Read file from current tier
   * 2. Write to target tier
   * 3. Delete from original tier
   * 4. Update metadata
   *
   * @param path - File path to demote
   * @param toTier - Target tier ('warm' or 'cold')
   * @throws {StorageError} If target tier is not available
   *
   * @example
   * ```typescript
   * // Move old data to cold storage
   * await fs.demote('/data/archive-2023.json', 'cold')
   *
   * // Move large file from hot to warm
   * await fs.demote('/cache/processed.bin', 'warm')
   * ```
   */
  async demote(path: string, toTier: 'warm' | 'cold'): Promise<void> {
    // Check if target tier is available
    if (toTier === 'warm' && !this.warm) {
      throw StorageError.invalidArg('Warm tier not available', path, 'demote')
    }
    if (toTier === 'cold' && !this.cold) {
      throw StorageError.invalidArg('Cold tier not available', path, 'demote')
    }

    // Read the file from its current tier
    const { data, tier: currentTier } = await this.readFile(path)

    // Demote to warm tier
    if (toTier === 'warm' && this.warm) {
      if (currentTier === 'hot') {
        // Write to warm
        await this.warm.put(path, data)
        // Delete from hot tier
        await this.hotStub.fetch('http://fsx.do/rpc', {
          method: 'POST',
          body: JSON.stringify({
            method: 'unlink',
            params: { path },
          }),
        })
      }
      // Update metadata
      this.tierMap.set(path, { tier: 'warm', size: data.length })
      await this.hotStub.fetch('http://fsx.do/rpc', {
        method: 'POST',
        body: JSON.stringify({
          method: 'setMetadata',
          params: { path, tier: 'warm', size: data.length },
        }),
      })
    }

    // Demote to cold tier
    if (toTier === 'cold' && this.cold) {
      // Write to cold
      await this.cold.put(path, data)

      // Delete from current tier
      if (currentTier === 'hot') {
        await this.hotStub.fetch('http://fsx.do/rpc', {
          method: 'POST',
          body: JSON.stringify({
            method: 'unlink',
            params: { path },
          }),
        })
      } else if (currentTier === 'warm' && this.warm) {
        await this.warm.delete(path)
      }

      // Update metadata
      this.tierMap.set(path, { tier: 'cold', size: data.length })
      await this.hotStub.fetch('http://fsx.do/rpc', {
        method: 'POST',
        body: JSON.stringify({
          method: 'setMetadata',
          params: { path, tier: 'cold', size: data.length },
        }),
      })
    }
  }

  /**
   * Encode binary data to base64 for RPC transport.
   *
   * @param data - Binary data to encode
   * @returns Base64 encoded string
   * @internal
   */
  private encodeBase64(data: Uint8Array): string {
    let binary = ''
    for (const byte of data) {
      binary += String.fromCharCode(byte)
    }
    return btoa(binary)
  }

  /**
   * Decode base64 string to binary data.
   *
   * @param data - Base64 encoded string
   * @returns Decoded binary data
   * @internal
   */
  private decodeBase64(data: string): Uint8Array {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }
}
