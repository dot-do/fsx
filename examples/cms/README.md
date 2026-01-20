# Simple CMS with fsx Storage

This example demonstrates a simple Content Management System (CMS) that uses fsx to store and manage content at the edge.

## Use Case

Content management systems need to:
- Store articles, pages, and media assets
- Organize content in a hierarchical structure
- Track content metadata and versions
- Support drafts and publishing workflows

fsx provides the filesystem primitives to build a lightweight, edge-native CMS.

## Features

- **Content Storage**: Store articles as Markdown/JSON files
- **Media Management**: Upload and serve images and assets
- **Hierarchical Organization**: Categories and nested pages
- **Version History**: Track content changes over time
- **Draft/Published States**: Publishing workflow support

## Quick Start

```bash
# Install dependencies
npm install

# Run the CMS server
npm start

# Access the CMS
# GET  /api/content/:path  - Read content
# POST /api/content/:path  - Create/update content
# GET  /api/list/:path     - List contents
# DELETE /api/content/:path - Delete content
```

## Code Overview

### cms.ts

The main CMS implementation:

```typescript
import { createFs } from 'fsx.do'

const fs = createFs()

// Initialize CMS structure
await fs.mkdir('/content/posts', { recursive: true })
await fs.mkdir('/content/pages', { recursive: true })
await fs.mkdir('/media/images', { recursive: true })

// Create a new post
await fs.writeFile('/content/posts/hello-world.json', JSON.stringify({
  title: 'Hello World',
  slug: 'hello-world',
  content: '# Hello World\n\nWelcome to my blog!',
  status: 'published',
  createdAt: Date.now(),
}))

// List all posts
const posts = await fs.readdir('/content/posts')
```

### Content Structure

```
/content/
├── posts/
│   ├── hello-world.json
│   ├── second-post.json
│   └── drafts/
│       └── wip-article.json
├── pages/
│   ├── about.json
│   └── contact.json
└── _meta.json

/media/
├── images/
│   ├── hero.jpg
│   └── avatar.png
└── documents/
    └── resume.pdf
```

### Key APIs Used

| API | Purpose |
|-----|---------|
| `mkdir(path, { recursive: true })` | Create content directories |
| `writeFile(path, data)` | Save content files |
| `readFile(path, 'utf-8')` | Load content |
| `readdir(path)` | List content items |
| `copyFile(src, dest)` | Publish drafts |
| `unlink(path)` | Delete content |
| `stat(path)` | Get content metadata |

## Project Structure

```
cms/
├── README.md           # This file
├── package.json        # Dependencies
├── cms.ts              # Main CMS implementation
├── content.ts          # Content management
├── media.ts            # Media/asset handling
└── server.ts           # HTTP API server
```

## API Endpoints

### Content Operations

```bash
# Create/update content
curl -X POST http://localhost:8787/api/content/posts/hello \
  -H "Content-Type: application/json" \
  -d '{"title": "Hello", "body": "World"}'

# Read content
curl http://localhost:8787/api/content/posts/hello

# List contents
curl http://localhost:8787/api/list/posts

# Delete content
curl -X DELETE http://localhost:8787/api/content/posts/hello
```

### Media Operations

```bash
# Upload media
curl -X POST http://localhost:8787/api/media/images/photo.jpg \
  --data-binary @photo.jpg

# Get media
curl http://localhost:8787/api/media/images/photo.jpg
```

## Production Deployment

Deploy to Cloudflare Workers with Durable Objects:

```typescript
// wrangler.toml
[durable_objects]
bindings = [
  { name = "CMS", class_name = "ContentDO" }
]

// index.ts
import { FileSystemDO } from 'fsx.do'

export class ContentDO extends FileSystemDO {
  // Extend with custom CMS logic
}
```

Each site or tenant gets its own isolated content store.

## Related

- [fsx.do Documentation](https://fsx.do)
- [MDX Content](https://mdxjs.com/)
- [Cloudflare Workers](https://workers.cloudflare.com/)
