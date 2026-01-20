/**
 * Simple CMS using fsx for content storage
 *
 * This example demonstrates a lightweight CMS that stores
 * content as files in an fsx filesystem.
 */

import { createFs, FSx, ENOENT, EEXIST } from 'fsx.do'
import { ContentManager, ContentItem, ContentMetadata } from './content.js'
import { MediaManager } from './media.js'

// CMS configuration
interface CMSConfig {
  contentPath: string
  mediaPath: string
  defaultAuthor: string
}

/**
 * Simple Content Management System
 */
export class CMS {
  private fs: FSx
  private content: ContentManager
  private media: MediaManager
  private config: CMSConfig

  constructor(config: Partial<CMSConfig> = {}) {
    this.fs = createFs()
    this.config = {
      contentPath: config.contentPath ?? '/content',
      mediaPath: config.mediaPath ?? '/media',
      defaultAuthor: config.defaultAuthor ?? 'anonymous',
    }

    this.content = new ContentManager(this.fs, this.config.contentPath)
    this.media = new MediaManager(this.fs, this.config.mediaPath)
  }

  /**
   * Initialize the CMS directory structure
   */
  async initialize(): Promise<void> {
    console.log('Initializing CMS...')

    // Create content directories
    await this.fs.mkdir(`${this.config.contentPath}/posts`, { recursive: true })
    await this.fs.mkdir(`${this.config.contentPath}/posts/drafts`, { recursive: true })
    await this.fs.mkdir(`${this.config.contentPath}/pages`, { recursive: true })
    await this.fs.mkdir(`${this.config.contentPath}/categories`, { recursive: true })

    // Create media directories
    await this.fs.mkdir(`${this.config.mediaPath}/images`, { recursive: true })
    await this.fs.mkdir(`${this.config.mediaPath}/documents`, { recursive: true })
    await this.fs.mkdir(`${this.config.mediaPath}/uploads`, { recursive: true })

    // Create site metadata file
    const metaPath = `${this.config.contentPath}/_site.json`
    try {
      await this.fs.stat(metaPath)
    } catch (error) {
      if (error instanceof ENOENT) {
        await this.fs.writeFile(metaPath, JSON.stringify({
          name: 'My Site',
          description: 'A simple CMS powered by fsx',
          createdAt: Date.now(),
        }, null, 2))
      }
    }

    console.log('CMS initialized')
  }

  /**
   * Create a new blog post
   */
  async createPost(slug: string, data: Partial<ContentItem>): Promise<ContentItem> {
    return this.content.create('posts', slug, {
      ...data,
      type: 'post',
      author: data.author ?? this.config.defaultAuthor,
    })
  }

  /**
   * Create a new page
   */
  async createPage(slug: string, data: Partial<ContentItem>): Promise<ContentItem> {
    return this.content.create('pages', slug, {
      ...data,
      type: 'page',
      author: data.author ?? this.config.defaultAuthor,
    })
  }

  /**
   * Get a post by slug
   */
  async getPost(slug: string): Promise<ContentItem | null> {
    return this.content.get('posts', slug)
  }

  /**
   * Get a page by slug
   */
  async getPage(slug: string): Promise<ContentItem | null> {
    return this.content.get('pages', slug)
  }

  /**
   * Update a post
   */
  async updatePost(slug: string, data: Partial<ContentItem>): Promise<ContentItem> {
    return this.content.update('posts', slug, data)
  }

  /**
   * Update a page
   */
  async updatePage(slug: string, data: Partial<ContentItem>): Promise<ContentItem> {
    return this.content.update('pages', slug, data)
  }

  /**
   * Delete a post
   */
  async deletePost(slug: string): Promise<void> {
    return this.content.delete('posts', slug)
  }

  /**
   * Delete a page
   */
  async deletePage(slug: string): Promise<void> {
    return this.content.delete('pages', slug)
  }

  /**
   * List all posts
   */
  async listPosts(options: { status?: string; limit?: number } = {}): Promise<ContentItem[]> {
    return this.content.list('posts', options)
  }

  /**
   * List all pages
   */
  async listPages(): Promise<ContentItem[]> {
    return this.content.list('pages')
  }

  /**
   * Save a post as draft
   */
  async saveDraft(slug: string, data: Partial<ContentItem>): Promise<ContentItem> {
    return this.content.create('posts/drafts', slug, {
      ...data,
      type: 'post',
      status: 'draft',
      author: data.author ?? this.config.defaultAuthor,
    })
  }

  /**
   * Publish a draft
   */
  async publishDraft(slug: string): Promise<ContentItem> {
    const draft = await this.content.get('posts/drafts', slug)
    if (!draft) {
      throw new Error(`Draft not found: ${slug}`)
    }

    // Create published version
    const published = await this.content.create('posts', slug, {
      ...draft,
      status: 'published',
      publishedAt: Date.now(),
    })

    // Remove draft
    await this.content.delete('posts/drafts', slug)

    return published
  }

  /**
   * Upload media
   */
  async uploadMedia(
    filename: string,
    data: Uint8Array | string,
    category: string = 'uploads'
  ): Promise<string> {
    return this.media.upload(category, filename, data)
  }

  /**
   * Get media file
   */
  async getMedia(category: string, filename: string): Promise<Uint8Array | string> {
    return this.media.get(category, filename)
  }

  /**
   * List media files
   */
  async listMedia(category: string): Promise<string[]> {
    return this.media.list(category)
  }

  /**
   * Delete media file
   */
  async deleteMedia(category: string, filename: string): Promise<void> {
    return this.media.delete(category, filename)
  }

  /**
   * Search content by query
   */
  async search(query: string): Promise<ContentItem[]> {
    const posts = await this.listPosts()
    const pages = await this.listPages()
    const all = [...posts, ...pages]

    const lowerQuery = query.toLowerCase()
    return all.filter(item =>
      item.title.toLowerCase().includes(lowerQuery) ||
      item.content.toLowerCase().includes(lowerQuery) ||
      item.tags?.some(tag => tag.toLowerCase().includes(lowerQuery))
    )
  }

  /**
   * Get site statistics
   */
  async getStats(): Promise<{
    posts: number
    pages: number
    drafts: number
    media: number
  }> {
    const [posts, pages, drafts, images, documents, uploads] = await Promise.all([
      this.content.list('posts'),
      this.content.list('pages'),
      this.content.list('posts/drafts'),
      this.media.list('images'),
      this.media.list('documents'),
      this.media.list('uploads'),
    ])

    return {
      posts: posts.length,
      pages: pages.length,
      drafts: drafts.length,
      media: images.length + documents.length + uploads.length,
    }
  }

  /**
   * Export all content as JSON
   */
  async export(): Promise<{
    posts: ContentItem[]
    pages: ContentItem[]
    media: string[]
  }> {
    const [posts, pages, images, documents, uploads] = await Promise.all([
      this.listPosts(),
      this.listPages(),
      this.listMedia('images'),
      this.listMedia('documents'),
      this.listMedia('uploads'),
    ])

    return {
      posts,
      pages,
      media: [...images, ...documents, ...uploads],
    }
  }
}

// Main execution
async function main() {
  const cms = new CMS({
    defaultAuthor: 'Admin',
  })

  await cms.initialize()

  // Create some sample content
  console.log('\n--- Creating sample content ---\n')

  await cms.createPost('hello-world', {
    title: 'Hello World',
    content: `# Hello World

Welcome to my blog! This is my first post powered by fsx.

## What is fsx?

fsx is a real filesystem for Cloudflare Workers. It provides:

- POSIX-compatible API
- Tiered storage (SQLite + R2)
- File watching
- And much more!

Stay tuned for more posts.
`,
    tags: ['introduction', 'fsx'],
  })

  await cms.createPost('getting-started', {
    title: 'Getting Started with fsx',
    content: `# Getting Started

This guide will help you get started with fsx.

\`\`\`typescript
import { createFs } from 'fsx.do'

const fs = createFs()
await fs.writeFile('/hello.txt', 'Hello!')
\`\`\`
`,
    tags: ['tutorial', 'fsx'],
  })

  await cms.createPage('about', {
    title: 'About Us',
    content: `# About

This is a demo CMS built with fsx.
`,
  })

  // List all content
  console.log('\n--- Current Content ---\n')

  const posts = await cms.listPosts()
  console.log(`Posts (${posts.length}):`)
  for (const post of posts) {
    console.log(`  - ${post.title} (${post.slug})`)
  }

  const pages = await cms.listPages()
  console.log(`\nPages (${pages.length}):`)
  for (const page of pages) {
    console.log(`  - ${page.title} (${page.slug})`)
  }

  // Search
  console.log('\n--- Search Results for "fsx" ---\n')
  const results = await cms.search('fsx')
  for (const result of results) {
    console.log(`  - ${result.title} (${result.type})`)
  }

  // Stats
  const stats = await cms.getStats()
  console.log('\n--- Site Statistics ---')
  console.log(`Posts: ${stats.posts}`)
  console.log(`Pages: ${stats.pages}`)
  console.log(`Drafts: ${stats.drafts}`)
  console.log(`Media: ${stats.media}`)
}

main().catch(console.error)
