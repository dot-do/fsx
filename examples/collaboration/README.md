# Real-time Collaborative Editing with fsx

This example demonstrates a real-time collaborative editing system using fsx for document storage and file watching for change synchronization.

## Use Case

Collaborative editing systems need to:
- Store documents with multiple users accessing simultaneously
- Track changes and maintain version history
- Synchronize changes across clients in real-time
- Handle conflicts when multiple users edit simultaneously

fsx provides the filesystem primitives and file watching capabilities needed for building collaborative features.

## Features

- **Document Storage**: Store documents as files with fsx
- **Change Tracking**: Track edits with timestamps and user attribution
- **File Watching**: Detect changes and notify connected clients
- **Version History**: Maintain document versions over time
- **Conflict Resolution**: Handle concurrent edits gracefully

## Quick Start

```bash
# Install dependencies
npm install

# Run the collaboration server
npm start

# Open multiple browser tabs to simulate collaboration
# Connect via WebSocket to ws://localhost:8787/ws
```

## Code Overview

### document.ts

Document management with change tracking:

```typescript
import { createFs } from 'fsx.do'

const fs = createFs()

// Create a collaborative document
await fs.mkdir('/docs', { recursive: true })
await fs.writeFile('/docs/meeting-notes.json', JSON.stringify({
  id: 'meeting-notes',
  content: '# Meeting Notes\n\n',
  version: 1,
  lastModified: Date.now(),
  collaborators: ['alice', 'bob'],
}))

// Watch for changes
fs.watch('/docs/meeting-notes.json', (event, filename) => {
  // Broadcast changes to connected clients
  broadcastUpdate(filename)
})
```

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Collaboration Server                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │
│  │   Client A   │    │   Client B   │    │   Client C   │   │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘   │
│         │                   │                   │            │
│         └─────────────┬─────┴─────────────┬─────┘            │
│                       │                   │                  │
│                       ▼                   ▼                  │
│              ┌────────────────────────────────┐              │
│              │      WebSocket Hub             │              │
│              └────────────────┬───────────────┘              │
│                               │                              │
│                               ▼                              │
│              ┌────────────────────────────────┐              │
│              │     Document Manager           │              │
│              │     (fsx filesystem)           │              │
│              └────────────────────────────────┘              │
│                               │                              │
│                               ▼                              │
│              ┌────────────────────────────────┐              │
│              │   /docs/                       │              │
│              │   ├── document-1.json          │              │
│              │   ├── document-2.json          │              │
│              │   └── .versions/               │              │
│              │       ├── document-1-v1.json   │              │
│              │       └── document-1-v2.json   │              │
│              └────────────────────────────────┘              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Key APIs Used

| API | Purpose |
|-----|---------|
| `writeFile(path, data)` | Save document changes |
| `readFile(path, encoding)` | Load document content |
| `watch(path, callback)` | Detect file changes |
| `copyFile(src, dest)` | Create version snapshots |
| `readdir(path)` | List documents/versions |
| `stat(path)` | Get modification times |

## Project Structure

```
collaboration/
├── README.md           # This file
├── package.json        # Dependencies
├── document.ts         # Document management
├── session.ts          # User session handling
├── sync.ts             # Change synchronization
└── server.ts           # WebSocket server
```

## Protocol

### Client -> Server Messages

```typescript
// Join a document
{ type: 'join', documentId: 'meeting-notes', userId: 'alice' }

// Send an edit
{ type: 'edit', documentId: 'meeting-notes', operation: {...}, version: 5 }

// Request document state
{ type: 'sync', documentId: 'meeting-notes' }

// Leave document
{ type: 'leave', documentId: 'meeting-notes' }
```

### Server -> Client Messages

```typescript
// Document state
{ type: 'state', documentId: 'meeting-notes', content: '...', version: 5 }

// Remote edit from another user
{ type: 'remote-edit', documentId: 'meeting-notes', operation: {...}, userId: 'bob' }

// User joined
{ type: 'user-joined', documentId: 'meeting-notes', userId: 'bob' }

// User left
{ type: 'user-left', documentId: 'meeting-notes', userId: 'bob' }
```

## Conflict Resolution

The system uses Operational Transformation (OT) for conflict resolution:

1. Each edit includes the document version it was based on
2. Server transforms concurrent operations to maintain consistency
3. Transformed operations are broadcast to all clients
4. Clients apply remote operations and transform local pending operations

## Production Deployment

Deploy to Cloudflare Workers with Durable Objects:

```typescript
// Each document gets its own Durable Object
// Providing strong consistency and real-time coordination

export class DocumentDO extends DurableObject {
  private fs: FSx

  constructor(state: DurableObjectState, env: Env) {
    super(state, env)
    this.fs = new FsModule(state)
  }

  async fetch(request: Request) {
    // Handle WebSocket upgrade for real-time collaboration
    const upgradeHeader = request.headers.get('Upgrade')
    if (upgradeHeader === 'websocket') {
      return this.handleWebSocket(request)
    }
    // Handle REST API for document operations
    return this.handleRest(request)
  }
}
```

## Related

- [fsx.do Documentation](https://fsx.do)
- [Operational Transformation](https://en.wikipedia.org/wiki/Operational_transformation)
- [Cloudflare Durable Objects WebSockets](https://developers.cloudflare.com/durable-objects/api/websockets/)
