/**
 * Content Management Module
 *
 * Handles CRUD operations for content items (posts, pages, etc.)
 */

import { FSx, ENOENT } from 'fsx.do'

export interface ContentMetadata {
  slug: string
  type: 'post' | 'page' | 'category'
  status: 'draft' | 'published' | 'archived'
  createdAt: number
  updatedAt: number
  publishedAt?: number
  author: string
  tags?: string[]
  category?: string
}

export interface ContentItem extends ContentMetadata {
  title: string
  content: string
  excerpt?: string
  featuredImage?: string
}

/**
 * Manages content items in the filesystem
 */
export class ContentManager {
  private fs: FSx
  private basePath: string

  constructor(fs: FSx, basePath: string) {
    this.fs = fs
    this.basePath = basePath
  }

  /**
   * Create a new content item
   */
  async create(collection: string, slug: string, data: Partial<ContentItem>): Promise<ContentItem> {
    const path = this.getPath(collection, slug)
    const now = Date.now()

    const item: ContentItem = {
      slug,
      type: data.type ?? 'post',
      status: data.status ?? 'draft',
      title: data.title ?? 'Untitled',
      content: data.content ?? '',
      excerpt: data.excerpt ?? this.generateExcerpt(data.content ?? ''),
      author: data.author ?? 'anonymous',
      tags: data.tags ?? [],
      category: data.category,
      featuredImage: data.featuredImage,
      createdAt: now,
      updatedAt: now,
      publishedAt: data.status === 'published' ? now : undefined,
    }

    await this.fs.writeFile(path, JSON.stringify(item, null, 2))
    return item
  }

  /**
   * Get a content item by slug
   */
  async get(collection: string, slug: string): Promise<ContentItem | null> {
    const path = this.getPath(collection, slug)

    try {
      const data = await this.fs.readFile(path, 'utf-8')
      return JSON.parse(data as string)
    } catch (error) {
      if (error instanceof ENOENT) {
        return null
      }
      throw error
    }
  }

  /**
   * Update a content item
   */
  async update(collection: string, slug: string, data: Partial<ContentItem>): Promise<ContentItem> {
    const existing = await this.get(collection, slug)
    if (!existing) {
      throw new Error(`Content not found: ${slug}`)
    }

    const updated: ContentItem = {
      ...existing,
      ...data,
      slug: existing.slug, // Preserve slug
      createdAt: existing.createdAt, // Preserve creation time
      updatedAt: Date.now(),
    }

    // Set published time if transitioning to published
    if (data.status === 'published' && existing.status !== 'published') {
      updated.publishedAt = Date.now()
    }

    const path = this.getPath(collection, slug)
    await this.fs.writeFile(path, JSON.stringify(updated, null, 2))
    return updated
  }

  /**
   * Delete a content item
   */
  async delete(collection: string, slug: string): Promise<void> {
    const path = this.getPath(collection, slug)
    await this.fs.unlink(path)
  }

  /**
   * List all content items in a collection
   */
  async list(
    collection: string,
    options: { status?: string; limit?: number; offset?: number } = {}
  ): Promise<ContentItem[]> {
    const dirPath = `${this.basePath}/${collection}`

    try {
      const files = await this.fs.readdir(dirPath)
      const jsonFiles = (files as string[]).filter(f => f.endsWith('.json'))

      const items: ContentItem[] = []
      for (const file of jsonFiles) {
        try {
          const slug = file.replace('.json', '')
          const item = await this.get(collection, slug)
          if (item) {
            // Apply status filter
            if (options.status && item.status !== options.status) {
              continue
            }
            items.push(item)
          }
        } catch {
          // Skip files that can't be parsed
        }
      }

      // Sort by creation date (newest first)
      items.sort((a, b) => b.createdAt - a.createdAt)

      // Apply pagination
      const offset = options.offset ?? 0
      const limit = options.limit ?? items.length
      return items.slice(offset, offset + limit)
    } catch (error) {
      if (error instanceof ENOENT) {
        return []
      }
      throw error
    }
  }

  /**
   * Search content by query
   */
  async search(collection: string, query: string): Promise<ContentItem[]> {
    const items = await this.list(collection)
    const lowerQuery = query.toLowerCase()

    return items.filter(item =>
      item.title.toLowerCase().includes(lowerQuery) ||
      item.content.toLowerCase().includes(lowerQuery) ||
      item.excerpt?.toLowerCase().includes(lowerQuery) ||
      item.tags?.some(tag => tag.toLowerCase().includes(lowerQuery))
    )
  }

  /**
   * Get content by tag
   */
  async getByTag(collection: string, tag: string): Promise<ContentItem[]> {
    const items = await this.list(collection)
    return items.filter(item => item.tags?.includes(tag))
  }

  /**
   * Get content by category
   */
  async getByCategory(collection: string, category: string): Promise<ContentItem[]> {
    const items = await this.list(collection)
    return items.filter(item => item.category === category)
  }

  /**
   * Move content item to a different collection
   */
  async move(fromCollection: string, toCollection: string, slug: string): Promise<void> {
    const item = await this.get(fromCollection, slug)
    if (!item) {
      throw new Error(`Content not found: ${slug}`)
    }

    // Create in new collection
    await this.create(toCollection, slug, item)

    // Delete from old collection
    await this.delete(fromCollection, slug)
  }

  /**
   * Duplicate a content item
   */
  async duplicate(collection: string, slug: string, newSlug: string): Promise<ContentItem> {
    const item = await this.get(collection, slug)
    if (!item) {
      throw new Error(`Content not found: ${slug}`)
    }

    return this.create(collection, newSlug, {
      ...item,
      title: `${item.title} (Copy)`,
      status: 'draft',
    })
  }

  /**
   * Get collection statistics
   */
  async getStats(collection: string): Promise<{
    total: number
    published: number
    drafts: number
    archived: number
  }> {
    const items = await this.list(collection)

    return {
      total: items.length,
      published: items.filter(i => i.status === 'published').length,
      drafts: items.filter(i => i.status === 'draft').length,
      archived: items.filter(i => i.status === 'archived').length,
    }
  }

  /**
   * Generate file path for content item
   */
  private getPath(collection: string, slug: string): string {
    return `${this.basePath}/${collection}/${slug}.json`
  }

  /**
   * Generate excerpt from content
   */
  private generateExcerpt(content: string, maxLength: number = 160): string {
    // Remove markdown formatting
    const plain = content
      .replace(/#{1,6}\s+/g, '') // Headers
      .replace(/\*\*|__/g, '') // Bold
      .replace(/\*|_/g, '') // Italic
      .replace(/`{1,3}[^`]*`{1,3}/g, '') // Code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Links
      .replace(/\n+/g, ' ') // Newlines
      .trim()

    if (plain.length <= maxLength) {
      return plain
    }

    return plain.substring(0, maxLength - 3) + '...'
  }
}
