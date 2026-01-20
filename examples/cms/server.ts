/**
 * CMS HTTP Server
 *
 * Provides a REST API for the CMS using Hono.
 */

import { Hono } from 'hono'
import { CMS } from './cms.js'

const app = new Hono()
const cms = new CMS()

// Initialize CMS on startup
await cms.initialize()

// Health check
app.get('/', (c) => {
  return c.json({
    name: 'fsx CMS',
    version: '1.0.0',
    status: 'ok',
  })
})

// ============================================
// Posts API
// ============================================

// List posts
app.get('/api/posts', async (c) => {
  const status = c.req.query('status')
  const limit = parseInt(c.req.query('limit') ?? '20', 10)

  const posts = await cms.listPosts({ status, limit })
  return c.json({ posts })
})

// Get post
app.get('/api/posts/:slug', async (c) => {
  const slug = c.req.param('slug')
  const post = await cms.getPost(slug)

  if (!post) {
    return c.json({ error: 'Post not found' }, 404)
  }

  return c.json(post)
})

// Create post
app.post('/api/posts', async (c) => {
  const body = await c.req.json()
  const { slug, ...data } = body

  if (!slug) {
    return c.json({ error: 'Slug is required' }, 400)
  }

  const post = await cms.createPost(slug, data)
  return c.json(post, 201)
})

// Update post
app.put('/api/posts/:slug', async (c) => {
  const slug = c.req.param('slug')
  const data = await c.req.json()

  try {
    const post = await cms.updatePost(slug, data)
    return c.json(post)
  } catch (error) {
    return c.json({ error: (error as Error).message }, 404)
  }
})

// Delete post
app.delete('/api/posts/:slug', async (c) => {
  const slug = c.req.param('slug')

  try {
    await cms.deletePost(slug)
    return c.json({ deleted: true })
  } catch (error) {
    return c.json({ error: (error as Error).message }, 404)
  }
})

// ============================================
// Pages API
// ============================================

// List pages
app.get('/api/pages', async (c) => {
  const pages = await cms.listPages()
  return c.json({ pages })
})

// Get page
app.get('/api/pages/:slug', async (c) => {
  const slug = c.req.param('slug')
  const page = await cms.getPage(slug)

  if (!page) {
    return c.json({ error: 'Page not found' }, 404)
  }

  return c.json(page)
})

// Create page
app.post('/api/pages', async (c) => {
  const body = await c.req.json()
  const { slug, ...data } = body

  if (!slug) {
    return c.json({ error: 'Slug is required' }, 400)
  }

  const page = await cms.createPage(slug, data)
  return c.json(page, 201)
})

// Update page
app.put('/api/pages/:slug', async (c) => {
  const slug = c.req.param('slug')
  const data = await c.req.json()

  try {
    const page = await cms.updatePage(slug, data)
    return c.json(page)
  } catch (error) {
    return c.json({ error: (error as Error).message }, 404)
  }
})

// Delete page
app.delete('/api/pages/:slug', async (c) => {
  const slug = c.req.param('slug')

  try {
    await cms.deletePage(slug)
    return c.json({ deleted: true })
  } catch (error) {
    return c.json({ error: (error as Error).message }, 404)
  }
})

// ============================================
// Drafts API
// ============================================

// Save draft
app.post('/api/drafts', async (c) => {
  const body = await c.req.json()
  const { slug, ...data } = body

  if (!slug) {
    return c.json({ error: 'Slug is required' }, 400)
  }

  const draft = await cms.saveDraft(slug, data)
  return c.json(draft, 201)
})

// Publish draft
app.post('/api/drafts/:slug/publish', async (c) => {
  const slug = c.req.param('slug')

  try {
    const published = await cms.publishDraft(slug)
    return c.json(published)
  } catch (error) {
    return c.json({ error: (error as Error).message }, 404)
  }
})

// ============================================
// Media API
// ============================================

// List media
app.get('/api/media/:category', async (c) => {
  const category = c.req.param('category')
  const files = await cms.listMedia(category)
  return c.json({ files })
})

// Get media file
app.get('/api/media/:category/:filename', async (c) => {
  const category = c.req.param('category')
  const filename = c.req.param('filename')

  try {
    const data = await cms.getMedia(category, filename)
    // In a real implementation, set proper Content-Type header
    return c.body(data as unknown as BodyInit)
  } catch (error) {
    return c.json({ error: 'File not found' }, 404)
  }
})

// Upload media
app.post('/api/media/:category/:filename', async (c) => {
  const category = c.req.param('category')
  const filename = c.req.param('filename')
  const body = await c.req.arrayBuffer()

  const path = await cms.uploadMedia(filename, new Uint8Array(body), category)
  return c.json({ path }, 201)
})

// Delete media
app.delete('/api/media/:category/:filename', async (c) => {
  const category = c.req.param('category')
  const filename = c.req.param('filename')

  try {
    await cms.deleteMedia(category, filename)
    return c.json({ deleted: true })
  } catch (error) {
    return c.json({ error: (error as Error).message }, 404)
  }
})

// ============================================
// Search API
// ============================================

app.get('/api/search', async (c) => {
  const query = c.req.query('q')

  if (!query) {
    return c.json({ error: 'Query parameter "q" is required' }, 400)
  }

  const results = await cms.search(query)
  return c.json({ results })
})

// ============================================
// Stats API
// ============================================

app.get('/api/stats', async (c) => {
  const stats = await cms.getStats()
  return c.json(stats)
})

// ============================================
// Export API
// ============================================

app.get('/api/export', async (c) => {
  const data = await cms.export()
  return c.json(data)
})

// Start server (for local development)
const port = parseInt(process.env.PORT ?? '8787', 10)
console.log(`CMS server starting on port ${port}...`)

// For Bun/Node.js local development
export default {
  port,
  fetch: app.fetch,
}

// If running directly with tsx/node
if (typeof Bun !== 'undefined') {
  // Running with Bun
  console.log(`CMS server running at http://localhost:${port}`)
} else {
  // Running with Node.js - use a simple HTTP server
  import('node:http').then(({ createServer }) => {
    createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`)
      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers as HeadersInit,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? req : undefined,
      })

      const response = await app.fetch(request)
      res.statusCode = response.status
      response.headers.forEach((value, key) => {
        res.setHeader(key, value)
      })
      res.end(await response.text())
    }).listen(port, () => {
      console.log(`CMS server running at http://localhost:${port}`)
    })
  })
}
