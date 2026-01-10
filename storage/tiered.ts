/**
 * TieredFS - Multi-tier filesystem with automatic placement
 */

export interface TieredFSConfig {
  /** Hot tier (Durable Object) - fast, small files */
  hot: DurableObjectNamespace
  /** Warm tier (R2) - large files */
  warm?: R2Bucket
  /** Cold tier (archive) - infrequent access */
  cold?: R2Bucket
  /** Size thresholds */
  thresholds?: {
    /** Max size for hot tier (default: 1MB) */
    hotMaxSize?: number
    /** Max size for warm tier (default: 100MB) */
    warmMaxSize?: number
  }
  /** Promotion policy */
  promotionPolicy?: 'none' | 'on-access' | 'aggressive'
}

const DEFAULT_CONFIG: Required<Omit<TieredFSConfig, 'hot' | 'warm' | 'cold'>> = {
  thresholds: {
    hotMaxSize: 1024 * 1024, // 1MB
    warmMaxSize: 100 * 1024 * 1024, // 100MB
  },
  promotionPolicy: 'on-access',
}

/** Internal tier metadata tracking */
interface TierMetadata {
  tier: 'hot' | 'warm' | 'cold'
  size: number
}

/**
 * TieredFS - Automatically place files in appropriate storage tier
 */
export class TieredFS {
  private hotStub: DurableObjectStub
  private warm?: R2Bucket
  private cold?: R2Bucket
  private config: Required<Omit<TieredFSConfig, 'hot' | 'warm' | 'cold'>>
  /** In-memory tier tracking (supplemental to DO storage) */
  private tierMap: Map<string, TierMetadata> = new Map()

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
   * Determine storage tier based on file size
   */
  private selectTier(size: number): 'hot' | 'warm' | 'cold' {
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
   * Write file with automatic tier selection
   */
  async writeFile(path: string, data: Uint8Array | string): Promise<{ tier: 'hot' | 'warm' | 'cold' }> {
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
   * Read file from appropriate tier
   */
  async readFile(path: string): Promise<{ data: Uint8Array; tier: 'hot' | 'warm' | 'cold' }> {
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
      throw new Error(`File not found: ${path}`)
    }
  }

  /**
   * Read file from hot tier (Durable Object)
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
   * Read file from warm tier (R2)
   */
  private async readFromWarm(path: string): Promise<{ data: Uint8Array; tier: 'warm' }> {
    if (!this.warm) {
      throw new Error(`Warm tier not available`)
    }
    const object = await this.warm.get(path)
    if (!object) {
      throw new Error(`File not found: ${path}`)
    }
    const data = new Uint8Array(await object.arrayBuffer())
    return { data, tier: 'warm' }
  }

  /**
   * Read file from cold tier (R2 archive)
   */
  private async readFromCold(path: string): Promise<{ data: Uint8Array; tier: 'cold' }> {
    if (!this.cold) {
      throw new Error(`Cold tier not available`)
    }
    const object = await this.cold.get(path)
    if (!object) {
      throw new Error(`File not found: ${path}`)
    }
    const data = new Uint8Array(await object.arrayBuffer())
    return { data, tier: 'cold' }
  }

  /**
   * Ensure parent directory exists in hot tier (Durable Object)
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
   * Promote a file to a higher tier
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
   * Demote a file to a lower tier (for cost optimization)
   */
  async demote(path: string, toTier: 'warm' | 'cold'): Promise<void> {
    // Check if target tier is available
    if (toTier === 'warm' && !this.warm) {
      throw new Error(`Warm tier not available`)
    }
    if (toTier === 'cold' && !this.cold) {
      throw new Error(`Cold tier not available`)
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

  private encodeBase64(data: Uint8Array): string {
    let binary = ''
    for (const byte of data) {
      binary += String.fromCharCode(byte)
    }
    return btoa(binary)
  }

  private decodeBase64(data: string): Uint8Array {
    const binary = atob(data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  }
}
