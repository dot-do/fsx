/**
 * ExtentStorage and ExtentFormat Comprehensive Tests
 *
 * This test suite covers the extent-based storage system that packs
 * 4KB/8KB database pages into 2MB extents for ~500x cost reduction
 * on Cloudflare Durable Objects.
 *
 * @module storage/__tests__/extent-storage.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  // Extent Format exports
  buildExtent,
  parseExtentHeader,
  parseExtent,
  extractPage,
  validateExtent,
  getPageBitmap,
  isPagePresent,
  getPresentPageCount,
  getPresentPageIndices,
  isExtentCompressed,
  computeChecksum,
  calculateBitmapSize,
  calculateExtentSize,
  calculatePagesPerExtent,
  setPagePresent,
  clearPagePresent,
  isPagePresentInBitmap,
  countPresentPagesInBitmap,
  getExtentInfo,
  EXTENT_MAGIC,
  EXTENT_VERSION,
  EXTENT_HEADER_SIZE,
  EXTENT_FLAG_COMPRESSED,
  DEFAULT_PAGE_SIZE,
  DEFAULT_EXTENT_SIZE,
  type ExtentHeader,
} from '../extent-format.js'
import {
  ExtentStorage,
  createExtentStorage,
  type SqlStorageAdapter,
  type SqlResultSet,
  type ExtentStorageConfig,
} from '../extent-storage.js'
import type { BlobStorage, BlobWriteResult, BlobReadResult, BlobListResult } from '../interfaces.js'

// =============================================================================
// Mock Implementations
// =============================================================================

/**
 * In-memory BlobStorage mock for testing.
 */
class MemoryBlobStorage implements BlobStorage {
  private store = new Map<string, { data: Uint8Array; etag: string }>()

  async put(path: string, data: Uint8Array): Promise<BlobWriteResult> {
    const etag = `"${this.simpleHash(data)}"`
    this.store.set(path, { data: data.slice(), etag })
    return { etag, size: data.length }
  }

  async get(path: string): Promise<BlobReadResult | null> {
    const entry = this.store.get(path)
    if (!entry) return null
    return {
      data: entry.data.slice(),
      metadata: {
        size: entry.data.length,
        etag: entry.etag,
      },
    }
  }

  async delete(path: string): Promise<void> {
    this.store.delete(path)
  }

  async exists(path: string): Promise<boolean> {
    return this.store.has(path)
  }

  async list(): Promise<BlobListResult> {
    return {
      objects: [...this.store.entries()].map(([key, val]) => ({
        key,
        size: val.data.length,
        etag: val.etag,
        uploaded: new Date(),
      })),
      truncated: false,
    }
  }

  clear(): void {
    this.store.clear()
  }

  getKeys(): string[] {
    return [...this.store.keys()]
  }

  private simpleHash(data: Uint8Array): string {
    let hash = 0
    for (let i = 0; i < data.length; i++) {
      hash = ((hash << 5) - hash + data[i]!) | 0
    }
    return hash.toString(16)
  }
}

/**
 * In-memory SqlStorage mock for testing.
 */
class MemorySqlStorage implements SqlStorageAdapter {
  private tables: Map<string, Map<string, Record<string, unknown>>> = new Map()

  exec(query: string, params?: (string | number | null | Uint8Array | ArrayBuffer)[]): SqlResultSet {
    const normalizedQuery = query.trim().toUpperCase()

    if (normalizedQuery.startsWith('CREATE TABLE') || normalizedQuery.startsWith('CREATE INDEX')) {
      // Extract table name and create table
      const match = query.match(/CREATE\s+(?:TABLE|INDEX)(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)/i)
      if (match && normalizedQuery.startsWith('CREATE TABLE')) {
        const tableName = match[1]!.toLowerCase()
        if (!this.tables.has(tableName)) {
          this.tables.set(tableName, new Map())
        }
      }
      return { rows: [] }
    }

    // Skip comments
    if (normalizedQuery.startsWith('--')) {
      return { rows: [] }
    }

    if (normalizedQuery.startsWith('INSERT')) {
      return this.handleInsert(query, params)
    }

    if (normalizedQuery.startsWith('SELECT')) {
      return this.handleSelect(query, params)
    }

    if (normalizedQuery.startsWith('UPDATE')) {
      return this.handleUpdate(query, params)
    }

    if (normalizedQuery.startsWith('DELETE')) {
      return this.handleDelete(query, params)
    }

    return { rows: [] }
  }

  private handleInsert(
    query: string,
    params?: (string | number | null | Uint8Array | ArrayBuffer)[]
  ): SqlResultSet {
    // Parse table name and columns
    const match = query.match(
      /INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i
    )
    if (!match) return { rows: [] }

    const tableName = match[1]!.toLowerCase()
    const columns = match[2]!.split(',').map((c) => c.trim().toLowerCase())
    const valueParts = match[3]!.split(',').map((v) => v.trim())

    const table = this.tables.get(tableName)
    if (!table) {
      this.tables.set(tableName, new Map())
    }

    const row: Record<string, unknown> = {}
    let paramIndex = 0
    columns.forEach((col, i) => {
      const valuePart = valueParts[i]
      if (valuePart === '?') {
        row[col] = params?.[paramIndex++]
      } else {
        // Handle literal values like 0, NULL, etc.
        if (valuePart?.toUpperCase() === 'NULL') {
          row[col] = null
        } else if (/^\d+$/.test(valuePart || '')) {
          row[col] = parseInt(valuePart!, 10)
        } else {
          row[col] = valuePart
        }
      }
    })

    // Build primary key (assume first column or file_id + page_num for dirty_pages)
    let pk: string
    if (tableName === 'dirty_pages') {
      pk = `${row.file_id}:${row.page_num}`
    } else if (tableName === 'extents' && row.file_id !== undefined && row.extent_index !== undefined) {
      pk = `${row.file_id}:${row.extent_index}`
    } else {
      pk = String(row[columns[0]!])
    }

    this.tables.get(tableName)!.set(pk, row)
    return { rows: [], rowsAffected: 1 }
  }

  private handleSelect(
    query: string,
    params?: (string | number | null | Uint8Array | ArrayBuffer)[]
  ): SqlResultSet {
    // Parse table name
    const tableMatch = query.match(/FROM\s+(\w+)/i)
    if (!tableMatch) return { rows: [] }

    const tableName = tableMatch[1]!.toLowerCase()
    const table = this.tables.get(tableName)
    if (!table) return { rows: [] }

    let rows = [...table.values()]

    // Handle WHERE clause
    const whereMatch = query.match(/WHERE\s+(.+?)(?:ORDER|LIMIT|$)/i)
    if (whereMatch && params) {
      const conditions = whereMatch[1]!
      rows = rows.filter((row) => this.matchesConditions(row, conditions, params))
    }

    // Handle ORDER BY
    const orderMatch = query.match(/ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?/i)
    if (orderMatch) {
      const col = orderMatch[1]!.toLowerCase()
      const desc = orderMatch[2]?.toUpperCase() === 'DESC'
      rows.sort((a, b) => {
        const va = a[col] as number | string
        const vb = b[col] as number | string
        if (va < vb) return desc ? 1 : -1
        if (va > vb) return desc ? -1 : 1
        return 0
      })
    }

    // Handle LIMIT
    const limitMatch = query.match(/LIMIT\s+(\d+)/i)
    if (limitMatch) {
      rows = rows.slice(0, parseInt(limitMatch[1]!, 10))
    }

    // Handle COUNT(*)
    if (query.toUpperCase().includes('COUNT(*)')) {
      return { rows: [{ cnt: rows.length }] }
    }

    // Handle SUM
    const sumMatch = query.match(/SUM\((\w+)\)/i)
    if (sumMatch) {
      const col = sumMatch[1]!.toLowerCase()
      const total = rows.reduce((acc, row) => acc + ((row[col] as number) || 0), 0)
      return { rows: [{ cnt: rows.length, total }] }
    }

    // Handle DISTINCT
    if (query.toUpperCase().includes('DISTINCT')) {
      const selectMatch = query.match(/SELECT\s+DISTINCT\s+(\w+)/i)
      if (selectMatch) {
        const col = selectMatch[1]!.toLowerCase()
        const seen = new Set<unknown>()
        rows = rows.filter((row) => {
          if (seen.has(row[col])) return false
          seen.add(row[col])
          return true
        })
      }
    }

    return { rows: rows as Record<string, string | number | null | ArrayBuffer | Uint8Array>[] }
  }

  private handleUpdate(
    query: string,
    params?: (string | number | null | Uint8Array | ArrayBuffer)[]
  ): SqlResultSet {
    const tableMatch = query.match(/UPDATE\s+(\w+)/i)
    if (!tableMatch) return { rows: [] }

    const tableName = tableMatch[1]!.toLowerCase()
    const table = this.tables.get(tableName)
    if (!table) return { rows: [] }

    // Parse SET clause
    const setMatch = query.match(/SET\s+(.+?)\s+WHERE/i)
    if (!setMatch || !params) return { rows: [] }

    const setClauses = setMatch[1]!.split(',').map((s) => s.trim())
    const setColumns = setClauses.map((s) => s.split('=')[0]!.trim().toLowerCase())

    // Find param indices for SET and WHERE
    const totalSetParams = setColumns.length

    // Parse WHERE
    const whereMatch = query.match(/WHERE\s+(.+)$/i)
    if (!whereMatch) return { rows: [] }

    const whereParams = params.slice(totalSetParams)

    let rowsAffected = 0
    for (const [key, row] of table) {
      if (this.matchesConditions(row, whereMatch[1]!, whereParams)) {
        setColumns.forEach((col, i) => {
          row[col] = params[i]
        })
        table.set(key, row)
        rowsAffected++
      }
    }

    return { rows: [], rowsAffected }
  }

  private handleDelete(
    query: string,
    params?: (string | number | null | Uint8Array | ArrayBuffer)[]
  ): SqlResultSet {
    const tableMatch = query.match(/FROM\s+(\w+)/i)
    if (!tableMatch) return { rows: [] }

    const tableName = tableMatch[1]!.toLowerCase()
    const table = this.tables.get(tableName)
    if (!table) return { rows: [] }

    const whereMatch = query.match(/WHERE\s+(.+)$/i)
    if (!whereMatch || !params) {
      table.clear()
      return { rows: [] }
    }

    const toDelete: string[] = []
    for (const [key, row] of table) {
      if (this.matchesConditions(row, whereMatch[1]!, params)) {
        toDelete.push(key)
      }
    }

    toDelete.forEach((key) => table.delete(key))
    return { rows: [], rowsAffected: toDelete.length }
  }

  private matchesConditions(
    row: Record<string, unknown>,
    conditions: string,
    params: (string | number | null | Uint8Array | ArrayBuffer)[]
  ): boolean {
    // Split by AND
    const parts = conditions.split(/\s+AND\s+/i)
    let paramIndex = 0

    for (const part of parts) {
      const trimmed = part.trim()

      // Handle column = ?
      const eqMatch = trimmed.match(/(\w+)\s*=\s*\?/i)
      if (eqMatch) {
        const col = eqMatch[1]!.toLowerCase()
        const expected = params[paramIndex++]
        if (row[col] !== expected) return false
        continue
      }

      // Handle column <= ?
      const leMatch = trimmed.match(/(\w+)\s*<=\s*\?/i)
      if (leMatch) {
        const col = leMatch[1]!.toLowerCase()
        const expected = params[paramIndex++] as number
        if ((row[col] as number) > expected) return false
        continue
      }

      // Handle column > ?
      const gtMatch = trimmed.match(/(\w+)\s*>\s*\?/i)
      if (gtMatch) {
        const col = gtMatch[1]!.toLowerCase()
        const expected = params[paramIndex++] as number
        if ((row[col] as number) <= expected) return false
        continue
      }

      // Handle column < ?
      const ltMatch = trimmed.match(/(\w+)\s*<\s*\?/i)
      if (ltMatch) {
        const col = ltMatch[1]!.toLowerCase()
        const expected = params[paramIndex++] as number
        if ((row[col] as number) >= expected) return false
        continue
      }
    }

    return true
  }

  clear(): void {
    this.tables.clear()
  }

  getTableData(tableName: string): Map<string, Record<string, unknown>> | undefined {
    return this.tables.get(tableName)
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

function createTestPage(pageSize: number, fillValue: number): Uint8Array {
  const page = new Uint8Array(pageSize)
  page.fill(fillValue)
  return page
}

function createTestPageWithPattern(pageSize: number, pattern: number[]): Uint8Array {
  const page = new Uint8Array(pageSize)
  for (let i = 0; i < pageSize; i++) {
    page[i] = pattern[i % pattern.length]!
  }
  return page
}

// =============================================================================
// Extent Format Tests
// =============================================================================

describe('ExtentFormat', () => {
  describe('Constants', () => {
    it('should have correct magic number', () => {
      // "EXT1" as little-endian
      expect(EXTENT_MAGIC).toBe(0x31545845)
    })

    it('should have correct version', () => {
      expect(EXTENT_VERSION).toBe(1)
    })

    it('should have correct header size', () => {
      expect(EXTENT_HEADER_SIZE).toBe(64)
    })

    it('should have correct compression flag', () => {
      expect(EXTENT_FLAG_COMPRESSED).toBe(0x01)
    })

    it('should have correct default page size', () => {
      expect(DEFAULT_PAGE_SIZE).toBe(4096)
    })

    it('should have correct default extent size', () => {
      expect(DEFAULT_EXTENT_SIZE).toBe(2 * 1024 * 1024)
    })
  })

  describe('computeChecksum', () => {
    it('should compute FNV-1a 64-bit hash', () => {
      const data = new Uint8Array([1, 2, 3, 4, 5])
      const checksum = computeChecksum(data)
      expect(typeof checksum).toBe('bigint')
    })

    it('should produce different checksums for different data', () => {
      const data1 = new Uint8Array([1, 2, 3])
      const data2 = new Uint8Array([4, 5, 6])
      expect(computeChecksum(data1)).not.toBe(computeChecksum(data2))
    })

    it('should produce same checksum for same data', () => {
      const data1 = new Uint8Array([1, 2, 3, 4, 5])
      const data2 = new Uint8Array([1, 2, 3, 4, 5])
      expect(computeChecksum(data1)).toBe(computeChecksum(data2))
    })

    it('should handle empty data', () => {
      const data = new Uint8Array(0)
      const checksum = computeChecksum(data)
      // FNV-1a offset basis for empty input
      expect(checksum).toBe(0xcbf29ce484222325n)
    })
  })

  describe('buildExtent', () => {
    it('should build extent from contiguous pages', () => {
      const pages = new Map<number, Uint8Array>()
      pages.set(0, createTestPage(4096, 0x01))
      pages.set(1, createTestPage(4096, 0x02))
      pages.set(2, createTestPage(4096, 0x03))

      const extent = buildExtent(pages, 4096)

      expect(extent).toBeInstanceOf(Uint8Array)
      expect(extent.length).toBeGreaterThan(EXTENT_HEADER_SIZE)

      const header = parseExtentHeader(extent)
      expect(header.magic).toBe(EXTENT_MAGIC)
      expect(header.version).toBe(EXTENT_VERSION)
      expect(header.pageSize).toBe(4096)
      expect(header.pageCount).toBe(3)
    })

    it('should build sparse extent with non-contiguous pages', () => {
      const pages = new Map<number, Uint8Array>()
      pages.set(0, createTestPage(4096, 0x01))
      pages.set(5, createTestPage(4096, 0x05))
      pages.set(10, createTestPage(4096, 0x0a))

      const extent = buildExtent(pages, 4096)
      const header = parseExtentHeader(extent)

      // pageCount should be highest index + 1
      expect(header.pageCount).toBe(11)
      // extentSize should only include present pages
      expect(header.extentSize).toBe(3 * 4096)
    })

    it('should handle empty page map', () => {
      const pages = new Map<number, Uint8Array>()
      const extent = buildExtent(pages, 4096)

      expect(extent.length).toBe(EXTENT_HEADER_SIZE)

      const header = parseExtentHeader(extent)
      expect(header.pageCount).toBe(0)
      expect(header.extentSize).toBe(0)
    })

    it('should handle single page', () => {
      const pages = new Map<number, Uint8Array>()
      pages.set(0, createTestPage(4096, 0xff))

      const extent = buildExtent(pages, 4096)
      const header = parseExtentHeader(extent)

      expect(header.pageCount).toBe(1)
      expect(header.extentSize).toBe(4096)
    })

    it('should compute correct checksum', () => {
      const pages = new Map<number, Uint8Array>()
      pages.set(0, createTestPage(4096, 0xaa))
      pages.set(1, createTestPage(4096, 0xbb))

      const extent = buildExtent(pages, 4096)
      expect(validateExtent(extent)).toBe(true)
    })

    it('should set compression flag when requested', () => {
      const pages = new Map<number, Uint8Array>()
      pages.set(0, createTestPage(4096, 0x01))

      const extent = buildExtent(pages, 4096, { compress: true })
      const header = parseExtentHeader(extent)

      expect(header.flags & EXTENT_FLAG_COMPRESSED).toBe(EXTENT_FLAG_COMPRESSED)
    })

    it('should not set compression flag by default', () => {
      const pages = new Map<number, Uint8Array>()
      pages.set(0, createTestPage(4096, 0x01))

      const extent = buildExtent(pages, 4096)
      const header = parseExtentHeader(extent)

      expect(header.flags & EXTENT_FLAG_COMPRESSED).toBe(0)
    })

    it('should throw for invalid page size', () => {
      const pages = new Map<number, Uint8Array>()
      pages.set(0, new Uint8Array(4096))

      expect(() => buildExtent(pages, 0)).toThrow('Invalid pageSize')
      expect(() => buildExtent(pages, -1)).toThrow('Invalid pageSize')
    })

    it('should throw for mismatched page data size', () => {
      const pages = new Map<number, Uint8Array>()
      pages.set(0, new Uint8Array(2048)) // Wrong size

      expect(() => buildExtent(pages, 4096)).toThrow('Page 0 has size 2048, expected 4096')
    })

    it('should support 8KB pages for PostgreSQL', () => {
      const pages = new Map<number, Uint8Array>()
      pages.set(0, createTestPage(8192, 0x01))
      pages.set(1, createTestPage(8192, 0x02))

      const extent = buildExtent(pages, 8192)
      const header = parseExtentHeader(extent)

      expect(header.pageSize).toBe(8192)
      expect(header.pageCount).toBe(2)
      expect(header.extentSize).toBe(2 * 8192)
    })
  })

  describe('parseExtentHeader', () => {
    it('should parse valid extent header', () => {
      const pages = new Map<number, Uint8Array>()
      pages.set(0, createTestPage(4096, 0x01))

      const extent = buildExtent(pages, 4096)
      const header = parseExtentHeader(extent)

      expect(header.magic).toBe(EXTENT_MAGIC)
      expect(header.version).toBe(EXTENT_VERSION)
      expect(header.flags).toBe(0)
      expect(header.pageSize).toBe(4096)
      expect(header.pageCount).toBe(1)
      expect(header.extentSize).toBe(4096)
      expect(typeof header.checksum).toBe('bigint')
    })

    it('should throw for data too small', () => {
      const data = new Uint8Array(32) // Less than header size
      expect(() => parseExtentHeader(data)).toThrow('Extent data too small')
    })

    it('should throw for invalid magic', () => {
      const data = new Uint8Array(64)
      data[0] = 0xff // Invalid magic
      expect(() => parseExtentHeader(data)).toThrow('Invalid extent magic')
    })

    it('should throw for unsupported version', () => {
      const data = new Uint8Array(64)
      const view = new DataView(data.buffer)
      view.setUint32(0, EXTENT_MAGIC, true)
      view.setUint16(4, 99, true) // Invalid version
      expect(() => parseExtentHeader(data)).toThrow('Unsupported extent version')
    })
  })

  describe('parseExtent', () => {
    it('should parse complete extent structure', () => {
      const pages = new Map<number, Uint8Array>()
      pages.set(0, createTestPage(4096, 0x01))
      pages.set(2, createTestPage(4096, 0x03))

      const extent = buildExtent(pages, 4096)
      const parsed = parseExtent(extent)

      expect(parsed.header.pageCount).toBe(3)
      expect(parsed.bitmap.length).toBe(1) // ceil(3/8) = 1
      expect(parsed.pageData.length).toBe(2 * 4096)
      expect(parsed.isCompressed).toBe(false)
      expect(parsed.isSparse).toBe(true)
    })
  })

  describe('extractPage', () => {
    it('should extract page at given index', () => {
      const pages = new Map<number, Uint8Array>()
      pages.set(0, createTestPage(4096, 0x01))
      pages.set(1, createTestPage(4096, 0x02))
      pages.set(2, createTestPage(4096, 0x03))

      const extent = buildExtent(pages, 4096)

      const page0 = extractPage(extent, 0, 4096)
      expect(page0).not.toBeNull()
      expect(page0![0]).toBe(0x01)

      const page1 = extractPage(extent, 1, 4096)
      expect(page1).not.toBeNull()
      expect(page1![0]).toBe(0x02)

      const page2 = extractPage(extent, 2, 4096)
      expect(page2).not.toBeNull()
      expect(page2![0]).toBe(0x03)
    })

    it('should return null for missing page in sparse extent', () => {
      const pages = new Map<number, Uint8Array>()
      pages.set(0, createTestPage(4096, 0x01))
      pages.set(5, createTestPage(4096, 0x05))

      const extent = buildExtent(pages, 4096)

      // Pages 1-4 are missing
      expect(extractPage(extent, 1, 4096)).toBeNull()
      expect(extractPage(extent, 2, 4096)).toBeNull()
      expect(extractPage(extent, 3, 4096)).toBeNull()
      expect(extractPage(extent, 4, 4096)).toBeNull()

      // Pages 0 and 5 exist
      expect(extractPage(extent, 0, 4096)).not.toBeNull()
      expect(extractPage(extent, 5, 4096)).not.toBeNull()
    })

    it('should return null for index out of range', () => {
      const pages = new Map<number, Uint8Array>()
      pages.set(0, createTestPage(4096, 0x01))

      const extent = buildExtent(pages, 4096)

      expect(extractPage(extent, -1, 4096)).toBeNull()
      expect(extractPage(extent, 100, 4096)).toBeNull()
    })

    it('should throw for page size mismatch', () => {
      const pages = new Map<number, Uint8Array>()
      pages.set(0, createTestPage(4096, 0x01))

      const extent = buildExtent(pages, 4096)

      expect(() => extractPage(extent, 0, 8192)).toThrow('Page size mismatch')
    })

    it('should preserve exact page data', () => {
      const pattern = [0x12, 0x34, 0x56, 0x78, 0xab, 0xcd, 0xef]
      const pages = new Map<number, Uint8Array>()
      pages.set(0, createTestPageWithPattern(4096, pattern))

      const extent = buildExtent(pages, 4096)
      const extracted = extractPage(extent, 0, 4096)

      expect(extracted).not.toBeNull()
      for (let i = 0; i < 4096; i++) {
        expect(extracted![i]).toBe(pattern[i % pattern.length])
      }
    })
  })

  describe('Page Bitmap Operations', () => {
    describe('getPageBitmap', () => {
      it('should return bitmap from extent', () => {
        const pages = new Map<number, Uint8Array>()
        pages.set(0, createTestPage(4096, 0x01))
        pages.set(7, createTestPage(4096, 0x07))

        const extent = buildExtent(pages, 4096)
        const bitmap = getPageBitmap(extent)

        expect(bitmap.length).toBe(1) // ceil(8/8) = 1
        // Bit 0 and bit 7 should be set
        expect(bitmap[0]).toBe(0b10000001)
      })

      it('should handle multiple bitmap bytes', () => {
        const pages = new Map<number, Uint8Array>()
        pages.set(0, createTestPage(4096, 0x00))
        pages.set(8, createTestPage(4096, 0x08))
        pages.set(15, createTestPage(4096, 0x0f))

        const extent = buildExtent(pages, 4096)
        const bitmap = getPageBitmap(extent)

        expect(bitmap.length).toBe(2) // ceil(16/8) = 2
        expect(bitmap[0]).toBe(0b00000001) // Page 0
        expect(bitmap[1]).toBe(0b10000001) // Pages 8 and 15
      })
    })

    describe('isPagePresent', () => {
      it('should return true for present pages', () => {
        const pages = new Map<number, Uint8Array>()
        pages.set(0, createTestPage(4096, 0x00))
        pages.set(5, createTestPage(4096, 0x05))

        const extent = buildExtent(pages, 4096)

        expect(isPagePresent(extent, 0)).toBe(true)
        expect(isPagePresent(extent, 5)).toBe(true)
      })

      it('should return false for missing pages', () => {
        const pages = new Map<number, Uint8Array>()
        pages.set(0, createTestPage(4096, 0x00))
        pages.set(5, createTestPage(4096, 0x05))

        const extent = buildExtent(pages, 4096)

        expect(isPagePresent(extent, 1)).toBe(false)
        expect(isPagePresent(extent, 2)).toBe(false)
        expect(isPagePresent(extent, 3)).toBe(false)
        expect(isPagePresent(extent, 4)).toBe(false)
      })

      it('should return false for out of range index', () => {
        const pages = new Map<number, Uint8Array>()
        pages.set(0, createTestPage(4096, 0x00))

        const extent = buildExtent(pages, 4096)

        expect(isPagePresent(extent, -1)).toBe(false)
        expect(isPagePresent(extent, 100)).toBe(false)
      })
    })

    describe('setPagePresent', () => {
      it('should set page bit in bitmap', () => {
        const bitmap = new Uint8Array(2)

        setPagePresent(bitmap, 0)
        expect(bitmap[0]).toBe(0b00000001)

        setPagePresent(bitmap, 7)
        expect(bitmap[0]).toBe(0b10000001)

        setPagePresent(bitmap, 8)
        expect(bitmap[1]).toBe(0b00000001)

        setPagePresent(bitmap, 15)
        expect(bitmap[1]).toBe(0b10000001)
      })
    })

    describe('clearPagePresent', () => {
      it('should clear page bit in bitmap', () => {
        const bitmap = new Uint8Array([0xff, 0xff])

        clearPagePresent(bitmap, 0)
        expect(bitmap[0]).toBe(0b11111110)

        clearPagePresent(bitmap, 7)
        expect(bitmap[0]).toBe(0b01111110)

        clearPagePresent(bitmap, 8)
        expect(bitmap[1]).toBe(0b11111110)
      })
    })

    describe('isPagePresentInBitmap', () => {
      it('should check standalone bitmap', () => {
        const bitmap = new Uint8Array([0b10000001, 0b00000001])

        expect(isPagePresentInBitmap(bitmap, 0)).toBe(true)
        expect(isPagePresentInBitmap(bitmap, 7)).toBe(true)
        expect(isPagePresentInBitmap(bitmap, 8)).toBe(true)
        expect(isPagePresentInBitmap(bitmap, 1)).toBe(false)
        expect(isPagePresentInBitmap(bitmap, 9)).toBe(false)
      })

      it('should return false for out of range', () => {
        const bitmap = new Uint8Array([0xff])
        expect(isPagePresentInBitmap(bitmap, 8)).toBe(false)
        expect(isPagePresentInBitmap(bitmap, 100)).toBe(false)
      })
    })

    describe('countPresentPagesInBitmap', () => {
      it('should count bits using Brian Kernighan algorithm', () => {
        expect(countPresentPagesInBitmap(new Uint8Array([0b00000000]))).toBe(0)
        expect(countPresentPagesInBitmap(new Uint8Array([0b00000001]))).toBe(1)
        expect(countPresentPagesInBitmap(new Uint8Array([0b11111111]))).toBe(8)
        expect(countPresentPagesInBitmap(new Uint8Array([0b10101010]))).toBe(4)
        expect(countPresentPagesInBitmap(new Uint8Array([0b11111111, 0b11111111]))).toBe(16)
      })
    })
  })

  describe('Extent Validation', () => {
    describe('validateExtent', () => {
      it('should return true for valid extent', () => {
        const pages = new Map<number, Uint8Array>()
        pages.set(0, createTestPage(4096, 0x01))
        pages.set(1, createTestPage(4096, 0x02))

        const extent = buildExtent(pages, 4096)
        expect(validateExtent(extent)).toBe(true)
      })

      it('should return false for corrupted checksum', () => {
        const pages = new Map<number, Uint8Array>()
        pages.set(0, createTestPage(4096, 0x01))

        const extent = buildExtent(pages, 4096)

        // Corrupt the data section
        extent[EXTENT_HEADER_SIZE + 10] = 0xff

        expect(validateExtent(extent)).toBe(false)
      })

      it('should return false for truncated data', () => {
        const pages = new Map<number, Uint8Array>()
        pages.set(0, createTestPage(4096, 0x01))

        const extent = buildExtent(pages, 4096)
        const truncated = extent.slice(0, 100) // Way too short

        expect(validateExtent(truncated)).toBe(false)
      })

      it('should return false for invalid magic', () => {
        const data = new Uint8Array(128)
        data[0] = 0xff
        expect(validateExtent(data)).toBe(false)
      })

      it('should handle empty extent', () => {
        const pages = new Map<number, Uint8Array>()
        const extent = buildExtent(pages, 4096)
        expect(validateExtent(extent)).toBe(true)
      })
    })

    describe('Invalid Extent Detection', () => {
      it('should detect wrong magic number', () => {
        const data = new Uint8Array(EXTENT_HEADER_SIZE)
        const view = new DataView(data.buffer)
        view.setUint32(0, 0x12345678, true) // Wrong magic

        expect(() => parseExtentHeader(data)).toThrow('Invalid extent magic')
      })

      it('should detect wrong version', () => {
        const data = new Uint8Array(EXTENT_HEADER_SIZE)
        const view = new DataView(data.buffer)
        view.setUint32(0, EXTENT_MAGIC, true)
        view.setUint16(4, 5, true) // Wrong version

        expect(() => parseExtentHeader(data)).toThrow('Unsupported extent version')
      })
    })
  })

  describe('Utility Functions', () => {
    describe('getPresentPageCount', () => {
      it('should count present pages in extent', () => {
        const pages = new Map<number, Uint8Array>()
        pages.set(0, createTestPage(4096, 0x00))
        pages.set(5, createTestPage(4096, 0x05))
        pages.set(10, createTestPage(4096, 0x0a))

        const extent = buildExtent(pages, 4096)
        expect(getPresentPageCount(extent)).toBe(3)
      })
    })

    describe('getPresentPageIndices', () => {
      it('should return indices of present pages', () => {
        const pages = new Map<number, Uint8Array>()
        pages.set(0, createTestPage(4096, 0x00))
        pages.set(5, createTestPage(4096, 0x05))
        pages.set(10, createTestPage(4096, 0x0a))

        const extent = buildExtent(pages, 4096)
        const indices = getPresentPageIndices(extent)

        expect(indices).toEqual([0, 5, 10])
      })
    })

    describe('isExtentCompressed', () => {
      it('should return true for compressed extent', () => {
        const pages = new Map<number, Uint8Array>()
        pages.set(0, createTestPage(4096, 0x01))

        const extent = buildExtent(pages, 4096, { compress: true })
        expect(isExtentCompressed(extent)).toBe(true)
      })

      it('should return false for uncompressed extent', () => {
        const pages = new Map<number, Uint8Array>()
        pages.set(0, createTestPage(4096, 0x01))

        const extent = buildExtent(pages, 4096)
        expect(isExtentCompressed(extent)).toBe(false)
      })
    })

    describe('calculateBitmapSize', () => {
      it('should calculate correct bitmap size', () => {
        expect(calculateBitmapSize(1)).toBe(1)
        expect(calculateBitmapSize(8)).toBe(1)
        expect(calculateBitmapSize(9)).toBe(2)
        expect(calculateBitmapSize(16)).toBe(2)
        expect(calculateBitmapSize(512)).toBe(64)
      })
    })

    describe('calculateExtentSize', () => {
      it('should calculate total extent size', () => {
        // 64 header + 1 bitmap (8 pages) + 8 pages * 4096
        const size = calculateExtentSize(8, 8, 4096)
        expect(size).toBe(64 + 1 + 8 * 4096)
      })

      it('should handle sparse extents', () => {
        // 64 header + 2 bitmap (16 slots) + 3 present pages * 4096
        const size = calculateExtentSize(16, 3, 4096)
        expect(size).toBe(64 + 2 + 3 * 4096)
      })
    })

    describe('calculatePagesPerExtent', () => {
      it('should calculate max pages for 2MB extent with 4KB pages', () => {
        const maxPages = calculatePagesPerExtent(2 * 1024 * 1024, 4096)
        // Approximately 512 pages
        expect(maxPages).toBeGreaterThanOrEqual(500)
        expect(maxPages).toBeLessThanOrEqual(512)
      })

      it('should calculate max pages for 2MB extent with 8KB pages', () => {
        const maxPages = calculatePagesPerExtent(2 * 1024 * 1024, 8192)
        // Approximately 256 pages
        expect(maxPages).toBeGreaterThanOrEqual(250)
        expect(maxPages).toBeLessThanOrEqual(256)
      })
    })

    describe('getExtentInfo', () => {
      it('should return extent info without full parse', () => {
        const pages = new Map<number, Uint8Array>()
        pages.set(0, createTestPage(4096, 0x00))
        pages.set(5, createTestPage(4096, 0x05))

        const extent = buildExtent(pages, 4096, { compress: true })
        const info = getExtentInfo(extent)

        expect(info.header.pageCount).toBe(6)
        expect(info.bitmapSize).toBe(1)
        expect(info.isSparse).toBe(true)
        expect(info.isCompressed).toBe(true)
        expect(info.presentPageCount).toBe(2)
      })
    })
  })
})

// =============================================================================
// ExtentStorage Tests
// =============================================================================

describe('ExtentStorage', () => {
  let blobStorage: MemoryBlobStorage
  let sqlStorage: MemorySqlStorage
  let storage: ExtentStorage

  beforeEach(async () => {
    blobStorage = new MemoryBlobStorage()
    sqlStorage = new MemorySqlStorage()

    storage = new ExtentStorage({
      pageSize: 4096,
      extentSize: 2 * 1024 * 1024,
      compression: 'none',
      backend: blobStorage,
      sql: sqlStorage,
      autoFlush: false, // Disable for controlled testing
    })

    await storage.init()
  })

  afterEach(() => {
    blobStorage.clear()
    sqlStorage.clear()
  })

  describe('Initialization', () => {
    it('should initialize storage and create tables', async () => {
      const freshSqlStorage = new MemorySqlStorage()
      const newStorage = new ExtentStorage({
        pageSize: 4096,
        extentSize: 2 * 1024 * 1024,
        compression: 'none',
        backend: new MemoryBlobStorage(),
        sql: freshSqlStorage,
      })

      await newStorage.init()

      // Tables should exist (they are created on init)
      // After init, the tables Map will have entries if CREATE TABLE was processed
      // Our mock creates them when CREATE TABLE is called
      await newStorage.writePage('test.db', 0, createTestPage(4096, 0x01))
      expect(freshSqlStorage.getTableData('extent_files')).toBeDefined()
      expect(freshSqlStorage.getTableData('dirty_pages')).toBeDefined()
    })

    it('should be idempotent', async () => {
      await storage.init()
      await storage.init()
      await storage.init()
      // No error should occur
    })

    it('should throw if operation called before init', () => {
      const uninitStorage = new ExtentStorage({
        pageSize: 4096,
        extentSize: 2 * 1024 * 1024,
        compression: 'none',
        backend: blobStorage,
        sql: new MemorySqlStorage(),
      })

      expect(() => uninitStorage.readPageSync('test.db', 0)).toThrow('not initialized')
    })
  })

  describe('writePage', () => {
    it('should buffer page in dirty pages', async () => {
      const page = createTestPage(4096, 0xaa)
      await storage.writePage('test.db', 0, page)

      const dirtyPages = sqlStorage.getTableData('dirty_pages')
      expect(dirtyPages?.size).toBe(1)
    })

    it('should buffer multiple pages', async () => {
      await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
      await storage.writePage('test.db', 1, createTestPage(4096, 0x02))
      await storage.writePage('test.db', 2, createTestPage(4096, 0x03))

      const dirtyPages = sqlStorage.getTableData('dirty_pages')
      expect(dirtyPages?.size).toBe(3)
    })

    it('should update existing dirty page on overwrite', async () => {
      await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
      await storage.writePage('test.db', 0, createTestPage(4096, 0xff))

      const dirtyPages = sqlStorage.getTableData('dirty_pages')
      expect(dirtyPages?.size).toBe(1)

      const page = await storage.readPage('test.db', 0)
      expect(page![0]).toBe(0xff)
    })

    it('should create file metadata on first write', async () => {
      await storage.writePage('test.db', 0, createTestPage(4096, 0x01))

      const files = sqlStorage.getTableData('extent_files')
      expect(files?.has('test.db')).toBe(true)
    })

    it('should update file size', async () => {
      await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
      expect(await storage.getFileSize('test.db')).toBe(4096)

      await storage.writePage('test.db', 9, createTestPage(4096, 0x0a))
      expect(await storage.getFileSize('test.db')).toBe(10 * 4096)
    })

    it('should throw for wrong page size', async () => {
      const wrongSize = new Uint8Array(2048)
      await expect(storage.writePage('test.db', 0, wrongSize)).rejects.toThrow('Invalid page size')
    })

    it('should auto-flush when threshold reached', async () => {
      const autoFlushStorage = new ExtentStorage({
        pageSize: 4096,
        extentSize: 2 * 1024 * 1024,
        compression: 'none',
        backend: blobStorage,
        sql: sqlStorage,
        autoFlush: true,
        flushThreshold: 5,
      })
      await autoFlushStorage.init()

      // Write 4 pages (below threshold)
      for (let i = 0; i < 4; i++) {
        await autoFlushStorage.writePage('test.db', i, createTestPage(4096, i))
      }

      // Should still have dirty pages
      let dirtyCount = sqlStorage.getTableData('dirty_pages')?.size ?? 0
      expect(dirtyCount).toBeGreaterThan(0)

      // Write 5th page (reaches threshold)
      await autoFlushStorage.writePage('test.db', 4, createTestPage(4096, 4))

      // After auto-flush, dirty pages should be cleared
      dirtyCount = sqlStorage.getTableData('dirty_pages')?.size ?? 0
      expect(dirtyCount).toBe(0)
    })
  })

  describe('readPage', () => {
    it('should read from dirty buffer first', async () => {
      await storage.writePage('test.db', 0, createTestPage(4096, 0xaa))

      const page = await storage.readPage('test.db', 0)
      expect(page).not.toBeNull()
      expect(page![0]).toBe(0xaa)
    })

    it('should read from flushed extent', async () => {
      await storage.writePage('test.db', 0, createTestPage(4096, 0xbb))
      await storage.flush()

      const page = await storage.readPage('test.db', 0)
      expect(page).not.toBeNull()
      expect(page![0]).toBe(0xbb)
    })

    it('should return null for non-existent page', async () => {
      const page = await storage.readPage('test.db', 999)
      expect(page).toBeNull()
    })

    it('should return null for non-existent file', async () => {
      const page = await storage.readPage('nonexistent.db', 0)
      expect(page).toBeNull()
    })

    it('should prioritize dirty buffer over flushed extent', async () => {
      // Write and flush
      await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
      await storage.flush()

      // Overwrite in dirty buffer
      await storage.writePage('test.db', 0, createTestPage(4096, 0xff))

      const page = await storage.readPage('test.db', 0)
      expect(page![0]).toBe(0xff)
    })
  })

  describe('flush', () => {
    it('should pack pages into extent', async () => {
      await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
      await storage.writePage('test.db', 1, createTestPage(4096, 0x02))
      await storage.writePage('test.db', 2, createTestPage(4096, 0x03))

      await storage.flush()

      // Dirty pages should be cleared
      const dirtyPages = sqlStorage.getTableData('dirty_pages')
      expect(dirtyPages?.size ?? 0).toBe(0)

      // Extent should be created in blob storage
      const keys = blobStorage.getKeys()
      expect(keys.length).toBe(1)
      expect(keys[0]).toContain('extent/')
    })

    it('should write to blob storage', async () => {
      await storage.writePage('test.db', 0, createTestPage(4096, 0xaa))
      await storage.flush()

      const keys = blobStorage.getKeys()
      expect(keys.length).toBe(1)

      const result = await blobStorage.get(keys[0]!)
      expect(result).not.toBeNull()
      expect(validateExtent(result!.data)).toBe(true)
    })

    it('should update extent metadata in SQL', async () => {
      await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
      await storage.flush()

      const extents = sqlStorage.getTableData('extents')
      expect(extents?.size).toBe(1)
    })

    it('should handle multiple files', async () => {
      await storage.writePage('db1.sqlite', 0, createTestPage(4096, 0x01))
      await storage.writePage('db2.sqlite', 0, createTestPage(4096, 0x02))
      await storage.flush()

      const keys = blobStorage.getKeys()
      expect(keys.length).toBe(2)
    })

    it('should handle sparse page indices within same extent', async () => {
      await storage.writePage('test.db', 0, createTestPage(4096, 0x00))
      await storage.writePage('test.db', 5, createTestPage(4096, 0x05))
      await storage.writePage('test.db', 10, createTestPage(4096, 0x0a))

      await storage.flush()

      // All pages should be in one extent
      const keys = blobStorage.getKeys()
      expect(keys.length).toBe(1)

      // Verify we can read them all back
      const page0 = await storage.readPage('test.db', 0)
      const page5 = await storage.readPage('test.db', 5)
      const page10 = await storage.readPage('test.db', 10)

      expect(page0![0]).toBe(0x00)
      expect(page5![0]).toBe(0x05)
      expect(page10![0]).toBe(0x0a)

      // Non-existent pages should return null
      expect(await storage.readPage('test.db', 1)).toBeNull()
      expect(await storage.readPage('test.db', 7)).toBeNull()
    })

    it('should do nothing for empty dirty buffer', async () => {
      await storage.flush()
      const keys = blobStorage.getKeys()
      expect(keys.length).toBe(0)
    })
  })

  describe('File Operations', () => {
    describe('getFileSize', () => {
      it('should return 0 for non-existent file', async () => {
        const size = await storage.getFileSize('nonexistent.db')
        expect(size).toBe(0)
      })

      it('should return correct size after writes', async () => {
        await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
        expect(await storage.getFileSize('test.db')).toBe(4096)

        await storage.writePage('test.db', 99, createTestPage(4096, 0x99))
        expect(await storage.getFileSize('test.db')).toBe(100 * 4096)
      })
    })

    describe('listFiles', () => {
      it('should list all files', async () => {
        await storage.writePage('db1.sqlite', 0, createTestPage(4096, 0x01))
        await storage.writePage('db2.sqlite', 0, createTestPage(4096, 0x02))
        await storage.writePage('db3.sqlite', 0, createTestPage(4096, 0x03))

        const files = await storage.listFiles()
        expect(files.length).toBe(3)
        expect(files).toContain('db1.sqlite')
        expect(files).toContain('db2.sqlite')
        expect(files).toContain('db3.sqlite')
      })

      it('should return empty array when no files', async () => {
        const files = await storage.listFiles()
        expect(files).toEqual([])
      })
    })

    describe('deleteFile', () => {
      it('should delete file and its extents', async () => {
        await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
        await storage.flush()

        await storage.deleteFile('test.db')

        const files = await storage.listFiles()
        expect(files).not.toContain('test.db')

        const page = await storage.readPage('test.db', 0)
        expect(page).toBeNull()
      })

      it('should delete dirty pages', async () => {
        await storage.writePage('test.db', 0, createTestPage(4096, 0x01))

        await storage.deleteFile('test.db')

        const dirtyPages = sqlStorage.getTableData('dirty_pages')
        expect(dirtyPages?.size ?? 0).toBe(0)
      })

      it('should delete blobs from storage', async () => {
        await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
        await storage.flush()

        const keysBefore = blobStorage.getKeys()
        expect(keysBefore.length).toBe(1)

        await storage.deleteFile('test.db')

        const keysAfter = blobStorage.getKeys()
        expect(keysAfter.length).toBe(0)
      })
    })

    describe('truncate', () => {
      it('should extend file size when truncating larger', async () => {
        await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
        expect(await storage.getFileSize('test.db')).toBe(4096)

        await storage.truncate('test.db', 10 * 4096)
        expect(await storage.getFileSize('test.db')).toBe(10 * 4096)
      })

      it('should remove pages beyond truncation point', async () => {
        await storage.writePage('test.db', 0, createTestPage(4096, 0x00))
        await storage.writePage('test.db', 5, createTestPage(4096, 0x05))
        await storage.writePage('test.db', 10, createTestPage(4096, 0x0a))

        // Truncate to 3 pages (indices 0, 1, 2)
        await storage.truncate('test.db', 3 * 4096)

        // Page 0 should still exist
        const page0 = await storage.readPage('test.db', 0)
        expect(page0).not.toBeNull()

        // Pages 5 and 10 should be gone
        const page5 = await storage.readPage('test.db', 5)
        const page10 = await storage.readPage('test.db', 10)
        expect(page5).toBeNull()
        expect(page10).toBeNull()
      })

      it('should handle truncate to zero', async () => {
        await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
        await storage.writePage('test.db', 1, createTestPage(4096, 0x02))

        await storage.truncate('test.db', 0)

        expect(await storage.getFileSize('test.db')).toBe(0)
        expect(await storage.readPage('test.db', 0)).toBeNull()
      })
    })
  })

  describe('Edge Cases', () => {
    describe('Empty file', () => {
      it('should handle file with no pages', async () => {
        const size = await storage.getFileSize('empty.db')
        expect(size).toBe(0)

        const page = await storage.readPage('empty.db', 0)
        expect(page).toBeNull()
      })
    })

    describe('Single page file', () => {
      it('should handle file with single page', async () => {
        await storage.writePage('single.db', 0, createTestPage(4096, 0xaa))
        await storage.flush()

        const page = await storage.readPage('single.db', 0)
        expect(page).not.toBeNull()
        expect(page![0]).toBe(0xaa)
      })
    })

    describe('Sparse pages (non-contiguous)', () => {
      it('should handle widely sparse page indices', async () => {
        await storage.writePage('sparse.db', 0, createTestPage(4096, 0x00))
        await storage.writePage('sparse.db', 100, createTestPage(4096, 0x64))
        await storage.writePage('sparse.db', 500, createTestPage(4096, 0xf4))

        await storage.flush()

        expect((await storage.readPage('sparse.db', 0))![0]).toBe(0x00)
        expect((await storage.readPage('sparse.db', 100))![0]).toBe(0x64)
        expect((await storage.readPage('sparse.db', 500))![0]).toBe(0xf4)

        // Middle pages should be null
        expect(await storage.readPage('sparse.db', 50)).toBeNull()
        expect(await storage.readPage('sparse.db', 250)).toBeNull()
      })
    })

    describe('Large file spanning multiple extents', () => {
      it('should handle pages in different extents', async () => {
        // With 2MB extents and 4KB pages, ~512 pages per extent
        // Write pages that span two extents
        await storage.writePage('large.db', 0, createTestPage(4096, 0x00))
        await storage.writePage('large.db', 510, createTestPage(4096, 0xfe))
        await storage.writePage('large.db', 520, createTestPage(4096, 0x08)) // Second extent

        await storage.flush()

        expect((await storage.readPage('large.db', 0))![0]).toBe(0x00)
        expect((await storage.readPage('large.db', 510))![0]).toBe(0xfe)
        expect((await storage.readPage('large.db', 520))![0]).toBe(0x08)
      })
    })
  })

  describe('Performance/Cost Tests', () => {
    it('should have reasonable extent count for 100MB file', async () => {
      // 100MB / 2MB per extent = 50 extents (not 25,000 individual page operations)
      const pagesPerExtent = calculatePagesPerExtent(2 * 1024 * 1024, 4096)
      const totalPages = Math.ceil((100 * 1024 * 1024) / 4096) // ~25,600 pages
      const expectedExtents = Math.ceil(totalPages / pagesPerExtent)

      // Should be around 50 extents, not 25,000
      expect(expectedExtents).toBeLessThan(60)
      expect(expectedExtents).toBeGreaterThan(40)
    })

    it('should pack pages efficiently', () => {
      const pagesPerExtent = calculatePagesPerExtent(2 * 1024 * 1024, 4096)

      // Should fit approximately 512 pages
      expect(pagesPerExtent).toBeGreaterThanOrEqual(500)
      expect(pagesPerExtent).toBeLessThanOrEqual(512)
    })

    it('should verify extent count matches page distribution', async () => {
      // Write pages that span 3 extents
      const pagesPerExtent = calculatePagesPerExtent(2 * 1024 * 1024, 4096)

      // First extent (pages 0-pagesPerExtent)
      await storage.writePage('test.db', 0, createTestPage(4096, 0x00))

      // Second extent
      await storage.writePage('test.db', pagesPerExtent + 1, createTestPage(4096, 0x01))

      // Third extent
      await storage.writePage('test.db', 2 * pagesPerExtent + 1, createTestPage(4096, 0x02))

      await storage.flush()

      const stats = await storage.getStats()
      expect(stats.totalExtents).toBe(3)
    })
  })

  describe('Sync Operations', () => {
    describe('readPageSync', () => {
      it('should read from dirty buffer synchronously', async () => {
        await storage.writePage('test.db', 0, createTestPage(4096, 0xcc))

        const page = storage.readPageSync('test.db', 0)
        expect(page).not.toBeNull()
        expect(page![0]).toBe(0xcc)
      })

      it('should return null when extent not in cache', async () => {
        await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
        await storage.flush()
        storage.clearCache()

        // Without preloading, sync read should return null
        const page = storage.readPageSync('test.db', 0)
        expect(page).toBeNull()
      })

      it('should read from cached extent', async () => {
        await storage.writePage('test.db', 0, createTestPage(4096, 0xdd))
        await storage.flush()

        // Preload to cache
        await storage.preloadExtents('test.db')

        const page = storage.readPageSync('test.db', 0)
        expect(page).not.toBeNull()
        expect(page![0]).toBe(0xdd)
      })
    })

    describe('writePageSync', () => {
      it('should write to dirty buffer synchronously', () => {
        storage.writePageSync('test.db', 0, createTestPage(4096, 0xee))

        const page = storage.readPageSync('test.db', 0)
        expect(page).not.toBeNull()
        expect(page![0]).toBe(0xee)
      })

      it('should throw for wrong page size', () => {
        expect(() => storage.writePageSync('test.db', 0, new Uint8Array(2048))).toThrow(
          'Invalid page size'
        )
      })
    })
  })

  describe('Cache Management', () => {
    it('should cache extent after read', async () => {
      await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
      await storage.flush()

      // First async read populates cache
      await storage.readPage('test.db', 0)

      // Sync read should now work
      const page = storage.readPageSync('test.db', 0)
      expect(page).not.toBeNull()
    })

    it('should clear cache on clearCache()', async () => {
      await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
      await storage.flush()
      await storage.readPage('test.db', 0)

      storage.clearCache()

      // Sync read should fail now
      const page = storage.readPageSync('test.db', 0)
      expect(page).toBeNull()
    })

    it('should preload extents into cache', async () => {
      await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
      await storage.writePage('test.db', 1, createTestPage(4096, 0x02))
      await storage.flush()

      await storage.preloadExtents('test.db')

      // Both pages should be readable synchronously
      expect(storage.readPageSync('test.db', 0)).not.toBeNull()
      expect(storage.readPageSync('test.db', 1)).not.toBeNull()
    })
  })

  describe('Statistics', () => {
    it('should return correct stats', async () => {
      await storage.writePage('db1.sqlite', 0, createTestPage(4096, 0x01))
      await storage.writePage('db1.sqlite', 1, createTestPage(4096, 0x02))
      await storage.writePage('db2.sqlite', 0, createTestPage(4096, 0x03))

      let stats = await storage.getStats()
      expect(stats.totalFiles).toBe(2)
      expect(stats.totalDirtyPages).toBe(3)
      expect(stats.totalExtents).toBe(0)

      await storage.flush()

      stats = await storage.getStats()
      expect(stats.totalFiles).toBe(2)
      expect(stats.totalDirtyPages).toBe(0)
      expect(stats.totalExtents).toBe(2)
    })
  })
})

// =============================================================================
// createExtentStorage Factory Tests
// =============================================================================

describe('createExtentStorage', () => {
  it('should create and initialize storage', async () => {
    const blobStorage = new MemoryBlobStorage()
    const sqlStorage = new MemorySqlStorage()

    const storage = await createExtentStorage({
      pageSize: 4096,
      extentSize: 2 * 1024 * 1024,
      compression: 'none',
      backend: blobStorage,
      sql: sqlStorage,
    })

    // Should be ready to use immediately
    await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
    const page = await storage.readPage('test.db', 0)
    expect(page).not.toBeNull()
  })

  it('should use default values', async () => {
    const blobStorage = new MemoryBlobStorage()
    const sqlStorage = new MemorySqlStorage()

    const storage = await createExtentStorage({
      pageSize: 4096,
      extentSize: 2 * 1024 * 1024,
      compression: 'none',
      backend: blobStorage,
      sql: sqlStorage,
    })

    // Verify it works with defaults
    await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
    await storage.flush()

    const keys = blobStorage.getKeys()
    expect(keys.some((k) => k.startsWith('extent/'))).toBe(true)
  })

  it('should support custom extent prefix', async () => {
    const blobStorage = new MemoryBlobStorage()
    const sqlStorage = new MemorySqlStorage()

    const storage = await createExtentStorage({
      pageSize: 4096,
      extentSize: 2 * 1024 * 1024,
      compression: 'none',
      backend: blobStorage,
      sql: sqlStorage,
      extentPrefix: 'custom/prefix/',
    })

    await storage.writePage('test.db', 0, createTestPage(4096, 0x01))
    await storage.flush()

    const keys = blobStorage.getKeys()
    expect(keys.some((k) => k.startsWith('custom/prefix/'))).toBe(true)
  })

  it('should support 8KB page size for PostgreSQL', async () => {
    const blobStorage = new MemoryBlobStorage()
    const sqlStorage = new MemorySqlStorage()

    const storage = await createExtentStorage({
      pageSize: 8192,
      extentSize: 2 * 1024 * 1024,
      compression: 'none',
      backend: blobStorage,
      sql: sqlStorage,
    })

    await storage.writePage('postgres.db', 0, createTestPage(8192, 0x01))
    await storage.flush()

    const page = await storage.readPage('postgres.db', 0)
    expect(page).not.toBeNull()
    expect(page!.length).toBe(8192)
    expect(page![0]).toBe(0x01)
  })
})
