/**
 * Page Metadata Schema Tests - 2MB BLOB Chunk Tracking for VFS
 *
 * Tests for the page_metadata schema that tracks 2MB blob chunks for the
 * Virtual File System. This schema enables:
 *
 * - Tracking individual 2MB pages/chunks for large files
 * - Storage tier management (hot/warm/cold) per page
 * - LRU-based eviction decisions via last_access_at tracking
 * - Access pattern analysis via access_count for tier promotion
 * - Compression metadata tracking
 * - Integrity verification via checksums
 *
 * Expected Schema:
 * ```sql
 * CREATE TABLE page_metadata (
 *   file_id INTEGER NOT NULL,           -- FK to files table
 *   page_number INTEGER NOT NULL,       -- 0-indexed page within file
 *   page_key TEXT NOT NULL,             -- DO storage key for chunk
 *   tier TEXT NOT NULL DEFAULT 'warm',  -- 'hot' | 'warm' | 'cold'
 *   size INTEGER NOT NULL,              -- Actual bytes in this chunk
 *   checksum TEXT,                      -- CRC32 or SHA256 for integrity
 *   last_access_at INTEGER NOT NULL,    -- Unix ms for LRU tracking
 *   access_count INTEGER DEFAULT 0,     -- For promotion decisions
 *   compressed INTEGER DEFAULT 0,       -- 1 if compressed
 *   original_size INTEGER,              -- Pre-compression size
 *   PRIMARY KEY (file_id, page_number)
 * );
 *
 * CREATE INDEX idx_page_metadata_tier ON page_metadata(tier);
 * CREATE INDEX idx_page_metadata_lru ON page_metadata(last_access_at);
 * ```
 *
 * Issue: fsx-5i99 - [RED] Page metadata schema for VFS blob tracking
 *
 * This is RED phase TDD - tests are expected to FAIL because the
 * implementation doesn't exist yet.
 *
 * @module storage/page-metadata.test
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  PageMetadataStore,
  type PageMetadata,
  type CreatePageOptions,
  type UpdatePageOptions,
  type TierStats,
} from './page-metadata.js'

// ============================================================================
// Mock SqlStorage Implementation
// ============================================================================

/**
 * Mock SQL result interface matching Cloudflare's SqlStorage
 */
interface MockSqlResult<T> {
  one: () => T | null
  toArray: () => T[]
}

/**
 * Mock SQLite storage that simulates Cloudflare DO SqlStorage behavior.
 * Extended to support page_metadata tests.
 */
class MockSqlStorage {
  private pages: Map<string, Record<string, unknown>> = new Map()
  private files: Map<string, Record<string, unknown>> = new Map()
  private nextFileId = 1
  public execCalls: { sql: string; params: unknown[] }[] = []
  public schemaCreated = false

  exec<T = unknown>(sql: string, ...params: unknown[]): MockSqlResult<T> {
    this.execCalls.push({ sql, params })
    const normalizedSql = sql.trim().toLowerCase()

    // Handle CREATE TABLE for page_metadata
    if (normalizedSql.includes('create table') && normalizedSql.includes('page_metadata')) {
      this.schemaCreated = true
      return this.emptyResult<T>()
    }

    // Handle CREATE TABLE for files
    if (normalizedSql.includes('create table') && normalizedSql.includes('files')) {
      this.schemaCreated = true
      return this.emptyResult<T>()
    }

    // Handle CREATE INDEX
    if (normalizedSql.includes('create index')) {
      return this.emptyResult<T>()
    }

    // Handle INSERT into page_metadata
    if (normalizedSql.includes('insert into page_metadata')) {
      const page = this.parsePageInsert(sql, params)
      const key = `${page.file_id}:${page.page_number}`
      this.pages.set(key, page)
      return this.emptyResult<T>()
    }

    // Handle INSERT into files (for FK testing)
    if (normalizedSql.includes('insert into files')) {
      const id = this.nextFileId++
      const entry = { id, path: params[0] as string }
      this.files.set(entry.path, entry)
      return this.emptyResult<T>()
    }

    // Handle SELECT from page_metadata WHERE file_id = ? AND page_number = ?
    if (
      normalizedSql.includes('select') &&
      normalizedSql.includes('from page_metadata') &&
      normalizedSql.includes('where file_id = ?') &&
      normalizedSql.includes('page_number = ?')
    ) {
      const fileId = params[0] as number
      const pageNumber = params[1] as number
      const key = `${fileId}:${pageNumber}`
      const page = this.pages.get(key)
      return {
        one: () => (page as T) || null,
        toArray: () => (page ? [page as T] : []),
      }
    }

    // Handle SUM(size) query for getTotalFileSize - MUST come before general file_id handler
    if (
      normalizedSql.includes('select') &&
      (normalizedSql.includes('sum(size)') || normalizedSql.includes('coalesce(sum(size)')) &&
      normalizedSql.includes('from page_metadata') &&
      normalizedSql.includes('where file_id = ?')
    ) {
      const fileId = params[0] as number
      let total = 0
      for (const page of this.pages.values()) {
        if (page.file_id === fileId) {
          total += (page.size as number) || 0
        }
      }
      return {
        one: () => ({ total } as T),
        toArray: () => [{ total } as T],
      }
    }

    // Handle SELECT from page_metadata WHERE file_id = ? (all pages for file)
    if (
      normalizedSql.includes('select') &&
      normalizedSql.includes('from page_metadata') &&
      normalizedSql.includes('where file_id = ?') &&
      !normalizedSql.includes('page_number = ?')
    ) {
      const fileId = params[0] as number
      const pages: Record<string, unknown>[] = []
      for (const [key, page] of this.pages) {
        if (page.file_id === fileId) {
          pages.push(page)
        }
      }
      // Sort by page_number
      pages.sort((a, b) => (a.page_number as number) - (b.page_number as number))
      return {
        one: () => (pages.length > 0 ? (pages[0] as T) : null),
        toArray: () => pages as T[],
      }
    }

    // Handle SELECT from page_metadata WHERE tier = ?
    if (
      normalizedSql.includes('select') &&
      normalizedSql.includes('from page_metadata') &&
      normalizedSql.includes('where tier = ?')
    ) {
      const tier = params[0] as string
      const pages: Record<string, unknown>[] = []
      for (const page of this.pages.values()) {
        if (page.tier === tier) {
          pages.push(page)
        }
      }
      return {
        one: () => (pages.length > 0 ? (pages[0] as T) : null),
        toArray: () => pages as T[],
      }
    }

    // Handle SELECT for LRU query (oldest pages by last_access_at)
    if (
      normalizedSql.includes('select') &&
      normalizedSql.includes('from page_metadata') &&
      normalizedSql.includes('order by last_access_at') &&
      normalizedSql.includes('limit')
    ) {
      const limit = params[0] as number
      const pages = Array.from(this.pages.values())
      pages.sort((a, b) => (a.last_access_at as number) - (b.last_access_at as number))
      const result = pages.slice(0, limit)
      return {
        one: () => (result.length > 0 ? (result[0] as T) : null),
        toArray: () => result as T[],
      }
    }

    // Handle UPDATE page_metadata SET access_count = access_count + 1
    if (
      normalizedSql.includes('update page_metadata') &&
      normalizedSql.includes('access_count = access_count + 1')
    ) {
      const fileId = params[0] as number
      const pageNumber = params[1] as number
      const key = `${fileId}:${pageNumber}`
      const page = this.pages.get(key)
      if (page) {
        page.access_count = ((page.access_count as number) || 0) + 1
        page.last_access_at = Date.now()
      }
      return this.emptyResult<T>()
    }

    // Handle UPDATE page_metadata SET tier = ?
    if (normalizedSql.includes('update page_metadata') && normalizedSql.includes('tier = ?')) {
      const tier = params[0] as string
      const fileId = params[1] as number
      const pageNumber = params[2] as number
      const key = `${fileId}:${pageNumber}`
      const page = this.pages.get(key)
      if (page) {
        page.tier = tier
      }
      return this.emptyResult<T>()
    }

    // Handle UPDATE page_metadata (general)
    if (normalizedSql.includes('update page_metadata set')) {
      const fileId = params[params.length - 2] as number
      const pageNumber = params[params.length - 1] as number
      const key = `${fileId}:${pageNumber}`
      const page = this.pages.get(key)
      if (page) {
        this.applyPageUpdate(page, sql, params)
      }
      return this.emptyResult<T>()
    }

    // Handle DELETE from page_metadata WHERE file_id = ? AND page_number = ?
    if (
      normalizedSql.includes('delete from page_metadata') &&
      normalizedSql.includes('where file_id = ?') &&
      normalizedSql.includes('page_number = ?')
    ) {
      const fileId = params[0] as number
      const pageNumber = params[1] as number
      const key = `${fileId}:${pageNumber}`
      this.pages.delete(key)
      return this.emptyResult<T>()
    }

    // Handle DELETE from page_metadata WHERE file_id = ? (all pages for file)
    if (
      normalizedSql.includes('delete from page_metadata') &&
      normalizedSql.includes('where file_id = ?') &&
      !normalizedSql.includes('page_number = ?')
    ) {
      const fileId = params[0] as number
      for (const [key] of this.pages) {
        if (key.startsWith(`${fileId}:`)) {
          this.pages.delete(key)
        }
      }
      return this.emptyResult<T>()
    }

    // Handle SELECT with file_id check for FK constraint validation
    if (
      normalizedSql.includes('select') &&
      normalizedSql.includes('from files') &&
      normalizedSql.includes('where id = ?')
    ) {
      const id = params[0] as number
      for (const entry of this.files.values()) {
        if (entry.id === id) {
          return {
            one: () => entry as T,
            toArray: () => [entry as T],
          }
        }
      }
      return this.emptyResult<T>()
    }

    // Handle SELECT page_key FROM page_metadata (for init)
    if (
      normalizedSql.includes('select page_key from page_metadata')
    ) {
      const keys = Array.from(this.pages.values()).map((p) => ({ page_key: p.page_key }))
      return {
        one: () => (keys.length > 0 ? (keys[0] as T) : null),
        toArray: () => keys as T[],
      }
    }

    // Handle getEvictionCandidates query with ORDER BY CASE
    if (
      normalizedSql.includes('select') &&
      normalizedSql.includes('from page_metadata') &&
      normalizedSql.includes('order by') &&
      normalizedSql.includes('case tier')
    ) {
      const limit = params[0] as number
      const pages = Array.from(this.pages.values())
      // Sort by: cold > warm > hot, then access_count ASC, then last_access_at ASC
      const tierOrder: Record<string, number> = { cold: 0, warm: 1, hot: 2 }
      pages.sort((a, b) => {
        const tierA = tierOrder[a.tier as string] ?? 1
        const tierB = tierOrder[b.tier as string] ?? 1
        if (tierA !== tierB) return tierA - tierB
        const accessA = (a.access_count as number) || 0
        const accessB = (b.access_count as number) || 0
        if (accessA !== accessB) return accessA - accessB
        return ((a.last_access_at as number) || 0) - ((b.last_access_at as number) || 0)
      })
      const result = pages.slice(0, limit)
      return {
        one: () => (result.length > 0 ? (result[0] as T) : null),
        toArray: () => result as T[],
      }
    }

    // Handle getTierStats query with GROUP BY tier
    if (
      normalizedSql.includes('select') &&
      normalizedSql.includes('from page_metadata') &&
      normalizedSql.includes('group by tier')
    ) {
      const tierStats: Record<string, { tier: string; count: number; total_size: number }> = {}
      for (const page of this.pages.values()) {
        const tier = (page.tier as string) || 'warm'
        if (!tierStats[tier]) {
          tierStats[tier] = { tier, count: 0, total_size: 0 }
        }
        tierStats[tier].count++
        tierStats[tier].total_size += (page.size as number) || 0
      }
      const result = Object.values(tierStats)
      return {
        one: () => (result.length > 0 ? (result[0] as T) : null),
        toArray: () => result as T[],
      }
    }

    // Handle getHotPages query with access_count >= ?
    if (
      normalizedSql.includes('select') &&
      normalizedSql.includes('from page_metadata') &&
      normalizedSql.includes('where access_count >= ?')
    ) {
      const minAccessCount = params[0] as number
      const tier = normalizedSql.includes('and tier = ?') ? (params[1] as string) : null
      const pages: Record<string, unknown>[] = []
      for (const page of this.pages.values()) {
        const accessCount = (page.access_count as number) || 0
        if (accessCount >= minAccessCount) {
          if (tier === null || page.tier === tier) {
            pages.push(page)
          }
        }
      }
      // Sort by access_count DESC
      pages.sort((a, b) => ((b.access_count as number) || 0) - ((a.access_count as number) || 0))
      return {
        one: () => (pages.length > 0 ? (pages[0] as T) : null),
        toArray: () => pages as T[],
      }
    }

    return this.emptyResult<T>()
  }

  private parsePageInsert(sql: string, params: unknown[]): Record<string, unknown> {
    const columnsMatch = sql.match(/\(([^)]+)\)\s*values/i)
    if (!columnsMatch) {
      return {
        file_id: params[0],
        page_number: params[1],
        page_key: params[2],
        tier: params[3] || 'warm',
        size: params[4],
        checksum: params[5],
        last_access_at: params[6] || Date.now(),
        access_count: params[7] || 0,
        compressed: params[8] || 0,
        original_size: params[9],
      }
    }

    const columns = columnsMatch[1].split(',').map((c) => c.trim())
    const page: Record<string, unknown> = {}
    columns.forEach((col, i) => {
      page[col] = params[i]
    })
    return page
  }

  private applyPageUpdate(page: Record<string, unknown>, sql: string, params: unknown[]): void {
    const setClause = sql.match(/set\s+(.+)\s+where/i)?.[1] || ''
    const assignments = setClause.split(',').map((a) => a.trim())
    let paramIndex = 0

    for (const assignment of assignments) {
      const [column] = assignment.split('=').map((s) => s.trim())
      if (column && params[paramIndex] !== undefined) {
        page[column] = params[paramIndex]
        paramIndex++
      }
    }
  }

  private emptyResult<T>(): MockSqlResult<T> {
    return {
      one: () => null,
      toArray: () => [],
    }
  }

  // Test helpers
  getPages(): Map<string, Record<string, unknown>> {
    return this.pages
  }

  getFiles(): Map<string, Record<string, unknown>> {
    return this.files
  }

  clear(): void {
    this.pages.clear()
    this.files.clear()
    this.nextFileId = 1
    this.execCalls = []
  }

  // Helper to create a file entry for FK tests
  createFile(path: string): number {
    const id = this.nextFileId++
    this.files.set(path, { id, path })
    return id
  }
}

// ============================================================================
// Schema Creation and Constraints Tests
// ============================================================================

describe('PageMetadata Schema', () => {
  let sql: MockSqlStorage
  let pageStore: PageMetadataStore

  beforeEach(() => {
    sql = new MockSqlStorage()
    // @ts-expect-error - Implementation does not exist yet
    pageStore = new PageMetadataStore(sql as unknown as SqlStorage)
  })

  describe('init() - Schema Creation', () => {
    it('should create page_metadata table with correct schema', async () => {
      await pageStore.init()

      const createTableCall = sql.execCalls.find(
        (c) => c.sql.toLowerCase().includes('create table') && c.sql.toLowerCase().includes('page_metadata')
      )
      expect(createTableCall).toBeDefined()

      // Verify required columns
      expect(createTableCall!.sql).toContain('file_id INTEGER NOT NULL')
      expect(createTableCall!.sql).toContain('page_number INTEGER NOT NULL')
      expect(createTableCall!.sql).toContain('page_key TEXT NOT NULL')
      expect(createTableCall!.sql).toContain("tier TEXT NOT NULL DEFAULT 'warm'")
      expect(createTableCall!.sql).toContain('size INTEGER NOT NULL')
      expect(createTableCall!.sql).toContain('checksum TEXT')
      expect(createTableCall!.sql).toContain('last_access_at INTEGER NOT NULL')
      expect(createTableCall!.sql).toContain('access_count INTEGER DEFAULT 0')
      expect(createTableCall!.sql).toContain('compressed INTEGER DEFAULT 0')
      expect(createTableCall!.sql).toContain('original_size INTEGER')
    })

    it('should create composite primary key (file_id, page_number)', async () => {
      await pageStore.init()

      const createTableCall = sql.execCalls.find(
        (c) => c.sql.toLowerCase().includes('create table') && c.sql.toLowerCase().includes('page_metadata')
      )
      expect(createTableCall).toBeDefined()
      expect(createTableCall!.sql).toContain('PRIMARY KEY (file_id, page_number)')
    })

    it('should create index on tier column', async () => {
      await pageStore.init()

      const indexCall = sql.execCalls.find(
        (c) => c.sql.toLowerCase().includes('create index') && c.sql.toLowerCase().includes('idx_page_metadata_tier')
      )
      expect(indexCall).toBeDefined()
      expect(indexCall!.sql.toLowerCase()).toContain('on page_metadata(tier)')
    })

    it('should create index on last_access_at for LRU queries', async () => {
      await pageStore.init()

      const indexCall = sql.execCalls.find(
        (c) => c.sql.toLowerCase().includes('create index') && c.sql.toLowerCase().includes('idx_page_metadata_lru')
      )
      expect(indexCall).toBeDefined()
      expect(indexCall!.sql.toLowerCase()).toContain('on page_metadata(last_access_at)')
    })

    it('should be idempotent (CREATE TABLE IF NOT EXISTS)', async () => {
      await pageStore.init()
      await pageStore.init()
      await pageStore.init()

      // Should not throw and should use IF NOT EXISTS
      const createTableCall = sql.execCalls.find(
        (c) => c.sql.toLowerCase().includes('create table if not exists page_metadata')
      )
      expect(createTableCall).toBeDefined()
    })

    it('should constrain tier to valid values (hot, warm, cold)', async () => {
      await pageStore.init()

      const createTableCall = sql.execCalls.find(
        (c) => c.sql.toLowerCase().includes('create table') && c.sql.toLowerCase().includes('page_metadata')
      )
      // Either via CHECK constraint or application-level validation
      expect(createTableCall!.sql.toLowerCase()).toMatch(/tier.*check|check.*tier|'hot'.*'warm'.*'cold'/)
    })
  })
})

// ============================================================================
// Page Insert/Update/Delete Operations Tests
// ============================================================================

describe('PageMetadata CRUD Operations', () => {
  let sql: MockSqlStorage
  let pageStore: PageMetadataStore

  beforeEach(async () => {
    sql = new MockSqlStorage()
    // @ts-expect-error - Implementation does not exist yet
    pageStore = new PageMetadataStore(sql as unknown as SqlStorage)
    await pageStore.init()
  })

  describe('createPage() - Insert Operations', () => {
    it('should insert a new page with all required fields', async () => {
      const fileId = sql.createFile('/test.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:file1:page0',
        tier: 'warm',
        size: 2 * 1024 * 1024, // 2MB
        checksum: 'sha256:abc123',
        lastAccessAt: Date.now(),
      })

      const page = await pageStore.getPage(fileId, 0)
      expect(page).not.toBeNull()
      expect(page?.fileId).toBe(fileId)
      expect(page?.pageNumber).toBe(0)
      expect(page?.pageKey).toBe('blob:file1:page0')
      expect(page?.tier).toBe('warm')
      expect(page?.size).toBe(2 * 1024 * 1024)
      expect(page?.checksum).toBe('sha256:abc123')
    })

    it('should default tier to warm', async () => {
      const fileId = sql.createFile('/test-default-tier.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:file2:page0',
        size: 1024,
        lastAccessAt: Date.now(),
      })

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.tier).toBe('warm')
    })

    it('should default access_count to 0', async () => {
      const fileId = sql.createFile('/test-access-count.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:file3:page0',
        size: 1024,
        lastAccessAt: Date.now(),
      })

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.accessCount).toBe(0)
    })

    it('should default compressed to 0 (not compressed)', async () => {
      const fileId = sql.createFile('/test-compressed.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:file4:page0',
        size: 1024,
        lastAccessAt: Date.now(),
      })

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.compressed).toBe(0)
    })

    it('should insert multiple pages for the same file', async () => {
      const fileId = sql.createFile('/multi-page.bin')
      const pageCount = 5

      for (let i = 0; i < pageCount; i++) {
        await pageStore.createPage({
          fileId,
          pageNumber: i,
          pageKey: `blob:multipage:page${i}`,
          size: 2 * 1024 * 1024,
          lastAccessAt: Date.now(),
        })
      }

      const pages = await pageStore.getPagesForFile(fileId)
      expect(pages.length).toBe(pageCount)
      expect(pages.map((p) => p.pageNumber)).toEqual([0, 1, 2, 3, 4])
    })

    it('should store compression metadata when provided', async () => {
      const fileId = sql.createFile('/compressed.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:compressed:page0',
        size: 1024 * 1024, // 1MB compressed
        originalSize: 2 * 1024 * 1024, // 2MB original
        compressed: 1,
        lastAccessAt: Date.now(),
      })

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.compressed).toBe(1)
      expect(page?.originalSize).toBe(2 * 1024 * 1024)
      expect(page?.size).toBe(1024 * 1024)
    })

    it('should reject duplicate (file_id, page_number) - primary key constraint', async () => {
      const fileId = sql.createFile('/duplicate.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:dup:page0-v1',
        size: 1024,
        lastAccessAt: Date.now(),
      })

      // Attempting to insert same file_id + page_number should fail
      await expect(
        pageStore.createPage({
          fileId,
          pageNumber: 0,
          pageKey: 'blob:dup:page0-v2',
          size: 2048,
          lastAccessAt: Date.now(),
        })
      ).rejects.toThrow()
    })
  })

  describe('updatePage() - Update Operations', () => {
    it('should update tier', async () => {
      const fileId = sql.createFile('/update-tier.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:update-tier:page0',
        tier: 'warm',
        size: 1024,
        lastAccessAt: Date.now(),
      })

      await pageStore.updatePage(fileId, 0, { tier: 'hot' })

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.tier).toBe('hot')
    })

    it('should update last_access_at', async () => {
      const fileId = sql.createFile('/update-lru.bin')
      const initialTime = Date.now() - 10000

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:update-lru:page0',
        size: 1024,
        lastAccessAt: initialTime,
      })

      const newTime = Date.now()
      await pageStore.updatePage(fileId, 0, { lastAccessAt: newTime })

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.lastAccessAt).toBe(newTime)
    })

    it('should update checksum', async () => {
      const fileId = sql.createFile('/update-checksum.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:update-checksum:page0',
        size: 1024,
        checksum: 'sha256:old',
        lastAccessAt: Date.now(),
      })

      await pageStore.updatePage(fileId, 0, { checksum: 'sha256:new' })

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.checksum).toBe('sha256:new')
    })

    it('should update page_key (for rewrites)', async () => {
      const fileId = sql.createFile('/update-key.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:old-key',
        size: 1024,
        lastAccessAt: Date.now(),
      })

      await pageStore.updatePage(fileId, 0, { pageKey: 'blob:new-key' })

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.pageKey).toBe('blob:new-key')
    })

    it('should update compression metadata', async () => {
      const fileId = sql.createFile('/update-compression.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:update-compression:page0',
        size: 2 * 1024 * 1024,
        compressed: 0,
        lastAccessAt: Date.now(),
      })

      await pageStore.updatePage(fileId, 0, {
        compressed: 1,
        originalSize: 2 * 1024 * 1024,
        size: 1024 * 1024,
      })

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.compressed).toBe(1)
      expect(page?.originalSize).toBe(2 * 1024 * 1024)
      expect(page?.size).toBe(1024 * 1024)
    })
  })

  describe('deletePage() - Delete Operations', () => {
    it('should delete a single page', async () => {
      const fileId = sql.createFile('/delete-single.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:delete:page0',
        size: 1024,
        lastAccessAt: Date.now(),
      })

      await pageStore.deletePage(fileId, 0)

      const page = await pageStore.getPage(fileId, 0)
      expect(page).toBeNull()
    })

    it('should delete all pages for a file', async () => {
      const fileId = sql.createFile('/delete-all.bin')

      for (let i = 0; i < 5; i++) {
        await pageStore.createPage({
          fileId,
          pageNumber: i,
          pageKey: `blob:delete-all:page${i}`,
          size: 1024,
          lastAccessAt: Date.now(),
        })
      }

      await pageStore.deletePagesForFile(fileId)

      const pages = await pageStore.getPagesForFile(fileId)
      expect(pages.length).toBe(0)
    })

    it('should handle deleting non-existent page gracefully', async () => {
      // Should not throw
      await expect(pageStore.deletePage(9999, 0)).resolves.not.toThrow()
    })
  })
})

// ============================================================================
// LRU Query Tests (Eviction Candidates)
// ============================================================================

describe('PageMetadata LRU Queries', () => {
  let sql: MockSqlStorage
  let pageStore: PageMetadataStore

  beforeEach(async () => {
    sql = new MockSqlStorage()
    // @ts-expect-error - Implementation does not exist yet
    pageStore = new PageMetadataStore(sql as unknown as SqlStorage)
    await pageStore.init()
  })

  describe('getOldestPages() - LRU Eviction Candidates', () => {
    it('should return pages ordered by last_access_at ascending', async () => {
      const fileId = sql.createFile('/lru-test.bin')
      const baseTime = Date.now()

      // Create pages with different access times
      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:lru:page0',
        size: 1024,
        lastAccessAt: baseTime - 3000, // 3 seconds ago (oldest)
      })

      await pageStore.createPage({
        fileId,
        pageNumber: 1,
        pageKey: 'blob:lru:page1',
        size: 1024,
        lastAccessAt: baseTime - 1000, // 1 second ago (newest)
      })

      await pageStore.createPage({
        fileId,
        pageNumber: 2,
        pageKey: 'blob:lru:page2',
        size: 1024,
        lastAccessAt: baseTime - 2000, // 2 seconds ago (middle)
      })

      const oldestPages = await pageStore.getOldestPages(3)

      expect(oldestPages.length).toBe(3)
      expect(oldestPages[0].pageNumber).toBe(0) // Oldest first
      expect(oldestPages[1].pageNumber).toBe(2)
      expect(oldestPages[2].pageNumber).toBe(1) // Newest last
    })

    it('should respect limit parameter', async () => {
      const fileId = sql.createFile('/lru-limit.bin')
      const baseTime = Date.now()

      for (let i = 0; i < 10; i++) {
        await pageStore.createPage({
          fileId,
          pageNumber: i,
          pageKey: `blob:lru-limit:page${i}`,
          size: 1024,
          lastAccessAt: baseTime - i * 1000,
        })
      }

      const oldestPages = await pageStore.getOldestPages(3)
      expect(oldestPages.length).toBe(3)
    })

    it('should return empty array when no pages exist', async () => {
      const oldestPages = await pageStore.getOldestPages(10)
      expect(oldestPages).toEqual([])
    })

    it('should filter by tier when specified', async () => {
      const fileId = sql.createFile('/lru-tier.bin')
      const baseTime = Date.now()

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:lru-tier:page0',
        size: 1024,
        tier: 'warm',
        lastAccessAt: baseTime - 3000,
      })

      await pageStore.createPage({
        fileId,
        pageNumber: 1,
        pageKey: 'blob:lru-tier:page1',
        size: 1024,
        tier: 'hot',
        lastAccessAt: baseTime - 4000, // Older but hot
      })

      await pageStore.createPage({
        fileId,
        pageNumber: 2,
        pageKey: 'blob:lru-tier:page2',
        size: 1024,
        tier: 'warm',
        lastAccessAt: baseTime - 2000,
      })

      // Only get warm tier pages for eviction
      const warmPages = await pageStore.getOldestPages(10, { tier: 'warm' })
      expect(warmPages.length).toBe(2)
      expect(warmPages.every((p) => p.tier === 'warm')).toBe(true)
    })
  })

  describe('getEvictionCandidates() - Smart Eviction', () => {
    it('should prioritize cold tier pages over warm tier', async () => {
      const fileId = sql.createFile('/eviction-priority.bin')
      const baseTime = Date.now()

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:evict:page0',
        size: 1024,
        tier: 'warm',
        lastAccessAt: baseTime - 1000, // More recent but warm
      })

      await pageStore.createPage({
        fileId,
        pageNumber: 1,
        pageKey: 'blob:evict:page1',
        size: 1024,
        tier: 'cold',
        lastAccessAt: baseTime - 500, // Less recent but cold
      })

      const candidates = await pageStore.getEvictionCandidates(1)

      // Cold tier should be evicted first (already in cheaper storage)
      expect(candidates[0].tier).toBe('cold')
    })

    it('should consider access_count for eviction priority', async () => {
      const fileId = sql.createFile('/eviction-access.bin')
      const baseTime = Date.now()

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:evict-access:page0',
        size: 1024,
        tier: 'warm',
        lastAccessAt: baseTime - 1000,
        accessCount: 100, // Frequently accessed
      })

      await pageStore.createPage({
        fileId,
        pageNumber: 1,
        pageKey: 'blob:evict-access:page1',
        size: 1024,
        tier: 'warm',
        lastAccessAt: baseTime - 1000, // Same time
        accessCount: 1, // Rarely accessed
      })

      const candidates = await pageStore.getEvictionCandidates(1)

      // Rarely accessed page should be evicted first
      expect(candidates[0].accessCount).toBe(1)
    })
  })
})

// ============================================================================
// Tier Filtering Query Tests
// ============================================================================

describe('PageMetadata Tier Queries', () => {
  let sql: MockSqlStorage
  let pageStore: PageMetadataStore

  beforeEach(async () => {
    sql = new MockSqlStorage()
    // @ts-expect-error - Implementation does not exist yet
    pageStore = new PageMetadataStore(sql as unknown as SqlStorage)
    await pageStore.init()
  })

  describe('getPagesByTier()', () => {
    it('should return all pages in hot tier', async () => {
      const fileId = sql.createFile('/tier-query.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:tier:page0',
        size: 1024,
        tier: 'hot',
        lastAccessAt: Date.now(),
      })

      await pageStore.createPage({
        fileId,
        pageNumber: 1,
        pageKey: 'blob:tier:page1',
        size: 1024,
        tier: 'warm',
        lastAccessAt: Date.now(),
      })

      await pageStore.createPage({
        fileId,
        pageNumber: 2,
        pageKey: 'blob:tier:page2',
        size: 1024,
        tier: 'hot',
        lastAccessAt: Date.now(),
      })

      const hotPages = await pageStore.getPagesByTier('hot')
      expect(hotPages.length).toBe(2)
      expect(hotPages.every((p) => p.tier === 'hot')).toBe(true)
    })

    it('should return all pages in warm tier', async () => {
      const fileId = sql.createFile('/tier-warm.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:tier-warm:page0',
        size: 1024,
        tier: 'warm',
        lastAccessAt: Date.now(),
      })

      const warmPages = await pageStore.getPagesByTier('warm')
      expect(warmPages.length).toBeGreaterThan(0)
      expect(warmPages.every((p) => p.tier === 'warm')).toBe(true)
    })

    it('should return all pages in cold tier', async () => {
      const fileId = sql.createFile('/tier-cold.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:tier-cold:page0',
        size: 1024,
        tier: 'cold',
        lastAccessAt: Date.now(),
      })

      const coldPages = await pageStore.getPagesByTier('cold')
      expect(coldPages.length).toBeGreaterThan(0)
      expect(coldPages.every((p) => p.tier === 'cold')).toBe(true)
    })

    it('should return empty array for empty tier', async () => {
      const pages = await pageStore.getPagesByTier('cold')
      expect(pages).toEqual([])
    })
  })

  describe('getTierStats()', () => {
    it('should return count and size statistics per tier', async () => {
      const fileId = sql.createFile('/tier-stats.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:stats:page0',
        size: 1024,
        tier: 'hot',
        lastAccessAt: Date.now(),
      })

      await pageStore.createPage({
        fileId,
        pageNumber: 1,
        pageKey: 'blob:stats:page1',
        size: 2048,
        tier: 'hot',
        lastAccessAt: Date.now(),
      })

      await pageStore.createPage({
        fileId,
        pageNumber: 2,
        pageKey: 'blob:stats:page2',
        size: 4096,
        tier: 'warm',
        lastAccessAt: Date.now(),
      })

      const stats = await pageStore.getTierStats()

      expect(stats.hot.count).toBe(2)
      expect(stats.hot.totalSize).toBe(1024 + 2048)
      expect(stats.warm.count).toBe(1)
      expect(stats.warm.totalSize).toBe(4096)
    })
  })
})

// ============================================================================
// Access Count Increment Tests
// ============================================================================

describe('PageMetadata Access Tracking', () => {
  let sql: MockSqlStorage
  let pageStore: PageMetadataStore

  beforeEach(async () => {
    sql = new MockSqlStorage()
    // @ts-expect-error - Implementation does not exist yet
    pageStore = new PageMetadataStore(sql as unknown as SqlStorage)
    await pageStore.init()
  })

  describe('recordAccess()', () => {
    it('should increment access_count by 1', async () => {
      const fileId = sql.createFile('/access-count.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:access:page0',
        size: 1024,
        lastAccessAt: Date.now() - 10000,
      })

      const pageBefore = await pageStore.getPage(fileId, 0)
      expect(pageBefore?.accessCount).toBe(0)

      await pageStore.recordAccess(fileId, 0)

      const pageAfter = await pageStore.getPage(fileId, 0)
      expect(pageAfter?.accessCount).toBe(1)
    })

    it('should update last_access_at on access', async () => {
      const fileId = sql.createFile('/access-time.bin')
      const oldTime = Date.now() - 60000 // 1 minute ago

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:access-time:page0',
        size: 1024,
        lastAccessAt: oldTime,
      })

      const beforeAccess = Date.now()
      await pageStore.recordAccess(fileId, 0)
      const afterAccess = Date.now()

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.lastAccessAt).toBeGreaterThanOrEqual(beforeAccess)
      expect(page?.lastAccessAt).toBeLessThanOrEqual(afterAccess)
    })

    it('should accumulate access_count over multiple accesses', async () => {
      const fileId = sql.createFile('/multi-access.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:multi-access:page0',
        size: 1024,
        lastAccessAt: Date.now(),
      })

      // Simulate 5 accesses
      for (let i = 0; i < 5; i++) {
        await pageStore.recordAccess(fileId, 0)
      }

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.accessCount).toBe(5)
    })

    it('should handle concurrent access increments', async () => {
      const fileId = sql.createFile('/concurrent-access.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:concurrent:page0',
        size: 1024,
        lastAccessAt: Date.now(),
      })

      // Simulate 10 concurrent accesses
      await Promise.all(
        Array.from({ length: 10 }, () => pageStore.recordAccess(fileId, 0))
      )

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.accessCount).toBe(10)
    })
  })

  describe('getHotPages() - Promotion Candidates', () => {
    it('should return pages with access_count above threshold', async () => {
      const fileId = sql.createFile('/hot-candidates.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:hot:page0',
        size: 1024,
        tier: 'warm',
        accessCount: 100, // Hot candidate
        lastAccessAt: Date.now(),
      })

      await pageStore.createPage({
        fileId,
        pageNumber: 1,
        pageKey: 'blob:hot:page1',
        size: 1024,
        tier: 'warm',
        accessCount: 5, // Not hot enough
        lastAccessAt: Date.now(),
      })

      const hotCandidates = await pageStore.getHotPages({ minAccessCount: 50, tier: 'warm' })

      expect(hotCandidates.length).toBe(1)
      expect(hotCandidates[0].accessCount).toBeGreaterThanOrEqual(50)
    })
  })
})

// ============================================================================
// Foreign Key Constraint Tests
// ============================================================================

describe('PageMetadata Foreign Key Constraints', () => {
  let sql: MockSqlStorage
  let pageStore: PageMetadataStore

  beforeEach(async () => {
    sql = new MockSqlStorage()
    // @ts-expect-error - Implementation does not exist yet
    pageStore = new PageMetadataStore(sql as unknown as SqlStorage)
    await pageStore.init()
  })

  describe('file_id FK constraint', () => {
    it('should allow inserting page with valid file_id', async () => {
      const fileId = sql.createFile('/valid-fk.bin')

      await expect(
        pageStore.createPage({
          fileId,
          pageNumber: 0,
          pageKey: 'blob:fk:page0',
          size: 1024,
          lastAccessAt: Date.now(),
        })
      ).resolves.not.toThrow()
    })

    it('should reject inserting page with non-existent file_id', async () => {
      const invalidFileId = 99999 // Does not exist

      await expect(
        pageStore.createPage({
          fileId: invalidFileId,
          pageNumber: 0,
          pageKey: 'blob:invalid-fk:page0',
          size: 1024,
          lastAccessAt: Date.now(),
        })
      ).rejects.toThrow()
    })

    it('should delete pages when parent file is deleted (CASCADE)', async () => {
      const fileId = sql.createFile('/cascade.bin')

      for (let i = 0; i < 3; i++) {
        await pageStore.createPage({
          fileId,
          pageNumber: i,
          pageKey: `blob:cascade:page${i}`,
          size: 1024,
          lastAccessAt: Date.now(),
        })
      }

      // Verify pages exist
      let pages = await pageStore.getPagesForFile(fileId)
      expect(pages.length).toBe(3)

      // Delete the parent file (should cascade to pages)
      await pageStore.onFileDeleted(fileId)

      // Pages should be deleted
      pages = await pageStore.getPagesForFile(fileId)
      expect(pages.length).toBe(0)
    })
  })
})

// ============================================================================
// Edge Cases and Error Handling
// ============================================================================

describe('PageMetadata Edge Cases', () => {
  let sql: MockSqlStorage
  let pageStore: PageMetadataStore

  beforeEach(async () => {
    sql = new MockSqlStorage()
    // @ts-expect-error - Implementation does not exist yet
    pageStore = new PageMetadataStore(sql as unknown as SqlStorage)
    await pageStore.init()
  })

  describe('page size validation', () => {
    it('should accept maximum chunk size (2MB)', async () => {
      const fileId = sql.createFile('/max-size.bin')

      await expect(
        pageStore.createPage({
          fileId,
          pageNumber: 0,
          pageKey: 'blob:max:page0',
          size: 2 * 1024 * 1024, // 2MB
          lastAccessAt: Date.now(),
        })
      ).resolves.not.toThrow()
    })

    it('should accept smaller last chunk sizes', async () => {
      const fileId = sql.createFile('/small-last.bin')

      await expect(
        pageStore.createPage({
          fileId,
          pageNumber: 0,
          pageKey: 'blob:small:page0',
          size: 500, // 500 bytes - last chunk can be any size
          lastAccessAt: Date.now(),
        })
      ).resolves.not.toThrow()
    })

    it('should store size accurately', async () => {
      const fileId = sql.createFile('/size-accuracy.bin')
      const exactSize = 1234567

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:accuracy:page0',
        size: exactSize,
        lastAccessAt: Date.now(),
      })

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.size).toBe(exactSize)
    })
  })

  describe('checksum handling', () => {
    it('should accept null checksum', async () => {
      const fileId = sql.createFile('/no-checksum.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:no-checksum:page0',
        size: 1024,
        checksum: null,
        lastAccessAt: Date.now(),
      })

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.checksum).toBeNull()
    })

    it('should accept CRC32 checksum format', async () => {
      const fileId = sql.createFile('/crc32.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:crc32:page0',
        size: 1024,
        checksum: 'crc32:a1b2c3d4',
        lastAccessAt: Date.now(),
      })

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.checksum).toBe('crc32:a1b2c3d4')
    })

    it('should accept SHA256 checksum format', async () => {
      const fileId = sql.createFile('/sha256.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:sha256:page0',
        size: 1024,
        checksum: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        lastAccessAt: Date.now(),
      })

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.checksum?.startsWith('sha256:')).toBe(true)
    })
  })

  describe('page_key uniqueness', () => {
    it('should ensure page_key is unique across all pages', async () => {
      const fileId1 = sql.createFile('/file1.bin')
      const fileId2 = sql.createFile('/file2.bin')
      const sharedKey = 'blob:shared:page0'

      await pageStore.createPage({
        fileId: fileId1,
        pageNumber: 0,
        pageKey: sharedKey,
        size: 1024,
        lastAccessAt: Date.now(),
      })

      // Different file but same page_key should fail (keys must be unique)
      await expect(
        pageStore.createPage({
          fileId: fileId2,
          pageNumber: 0,
          pageKey: sharedKey,
          size: 1024,
          lastAccessAt: Date.now(),
        })
      ).rejects.toThrow()
    })
  })

  describe('timestamp precision', () => {
    it('should store timestamps with millisecond precision', async () => {
      const fileId = sql.createFile('/timestamp-precision.bin')
      const preciseTime = 1704067200123 // Specific milliseconds

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:ts-precision:page0',
        size: 1024,
        lastAccessAt: preciseTime,
      })

      const page = await pageStore.getPage(fileId, 0)
      expect(page?.lastAccessAt).toBe(preciseTime)
    })
  })

  describe('large file with many pages', () => {
    it('should handle file with 1000+ pages', async () => {
      const fileId = sql.createFile('/large-file.bin')
      const pageCount = 1000

      for (let i = 0; i < pageCount; i++) {
        await pageStore.createPage({
          fileId,
          pageNumber: i,
          pageKey: `blob:large:page${i}`,
          size: 2 * 1024 * 1024,
          lastAccessAt: Date.now(),
        })
      }

      const pages = await pageStore.getPagesForFile(fileId)
      expect(pages.length).toBe(pageCount)
    })
  })
})

// ============================================================================
// Integration-style Tests
// ============================================================================

describe('PageMetadata Integration', () => {
  let sql: MockSqlStorage
  let pageStore: PageMetadataStore

  beforeEach(async () => {
    sql = new MockSqlStorage()
    // @ts-expect-error - Implementation does not exist yet
    pageStore = new PageMetadataStore(sql as unknown as SqlStorage)
    await pageStore.init()
  })

  describe('complete file lifecycle', () => {
    it('should handle create, access, tier change, and delete lifecycle', async () => {
      const fileId = sql.createFile('/lifecycle.bin')

      // 1. Create pages for a 10MB file (5 x 2MB pages)
      for (let i = 0; i < 5; i++) {
        await pageStore.createPage({
          fileId,
          pageNumber: i,
          pageKey: `blob:lifecycle:page${i}`,
          size: 2 * 1024 * 1024,
          tier: 'warm',
          lastAccessAt: Date.now() - 10000,
        })
      }

      // 2. Access first page multiple times (should become hot candidate)
      for (let i = 0; i < 10; i++) {
        await pageStore.recordAccess(fileId, 0)
      }

      const firstPage = await pageStore.getPage(fileId, 0)
      expect(firstPage?.accessCount).toBe(10)

      // 3. Promote first page to hot tier
      await pageStore.updatePage(fileId, 0, { tier: 'hot' })

      const promotedPage = await pageStore.getPage(fileId, 0)
      expect(promotedPage?.tier).toBe('hot')

      // 4. Demote unused pages to cold
      for (let i = 1; i < 5; i++) {
        await pageStore.updatePage(fileId, i, { tier: 'cold' })
      }

      const coldPages = await pageStore.getPagesByTier('cold')
      expect(coldPages.length).toBe(4)

      // 5. Delete file and all its pages
      await pageStore.deletePagesForFile(fileId)

      const remainingPages = await pageStore.getPagesForFile(fileId)
      expect(remainingPages.length).toBe(0)
    })
  })

  describe('getTotalFileSize()', () => {
    it('should calculate total file size from all pages', async () => {
      const fileId = sql.createFile('/total-size.bin')

      await pageStore.createPage({
        fileId,
        pageNumber: 0,
        pageKey: 'blob:total:page0',
        size: 2 * 1024 * 1024,
        lastAccessAt: Date.now(),
      })

      await pageStore.createPage({
        fileId,
        pageNumber: 1,
        pageKey: 'blob:total:page1',
        size: 2 * 1024 * 1024,
        lastAccessAt: Date.now(),
      })

      await pageStore.createPage({
        fileId,
        pageNumber: 2,
        pageKey: 'blob:total:page2',
        size: 500000, // Last chunk is smaller
        lastAccessAt: Date.now(),
      })

      const totalSize = await pageStore.getTotalFileSize(fileId)
      expect(totalSize).toBe(2 * 1024 * 1024 + 2 * 1024 * 1024 + 500000)
    })
  })

  describe('getPageKeysForFile()', () => {
    it('should return all page keys in order', async () => {
      const fileId = sql.createFile('/page-keys.bin')

      for (let i = 0; i < 3; i++) {
        await pageStore.createPage({
          fileId,
          pageNumber: i,
          pageKey: `blob:keys:page${i}`,
          size: 1024,
          lastAccessAt: Date.now(),
        })
      }

      const keys = await pageStore.getPageKeysForFile(fileId)
      expect(keys).toEqual([
        'blob:keys:page0',
        'blob:keys:page1',
        'blob:keys:page2',
      ])
    })
  })
})
