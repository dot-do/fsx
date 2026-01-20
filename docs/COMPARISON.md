# fsx vs Competitors: A Comparison Guide

This document provides a factual comparison between fsx and other real-time/storage platforms: PartyKit, Ably, and Firebase. Our goal is to help you understand when each solution is the right fit for your use case.

## Quick Comparison Matrix

| Feature | fsx | PartyKit | Ably | Firebase RTDB |
|---------|-----|----------|------|---------------|
| **Primary Focus** | Filesystem API | Real-time collaboration | Pub/sub messaging | Real-time sync |
| **API Paradigm** | POSIX filesystem | WebSocket/Rooms | Channels/Messages | JSON tree |
| **Storage Model** | Files & directories | Durable Object state | Message history | JSON documents |
| **Edge Deployment** | Cloudflare Workers | Cloudflare Workers | Global PoPs | Google Cloud |
| **Offline Support** | Via sync patterns | Limited | Message buffering | Built-in |
| **Large File Support** | Yes (R2 tier) | No | No | No |
| **Streaming** | ReadStream/WriteStream | WebSocket streams | Pub/sub streams | Listeners |

---

## fsx vs PartyKit

### Overview

- **fsx**: A POSIX-compatible filesystem for Cloudflare Workers, providing familiar file operations (read, write, mkdir, chmod) at the edge.
- **PartyKit**: A platform for building real-time multiplayer collaborative applications, now owned by Cloudflare.

### Real-time Capabilities

| Aspect | fsx | PartyKit |
|--------|-----|----------|
| **Real-time paradigm** | File watching (`fs.watch`) | WebSocket rooms |
| **Collaboration model** | File-based state | CRDT/Yjs integration |
| **Connection type** | HTTP/RPC calls | Persistent WebSocket |
| **Broadcasting** | N/A | Built-in to rooms |
| **Presence** | Via file metadata | Native presence API |

**PartyKit excels at**: Multi-user cursors, collaborative editing, live reactions, multiplayer games, shared whiteboards.

**fsx excels at**: AI agent workspaces, config management, file processing pipelines, content storage, asset management.

### File System Abstraction

| Capability | fsx | PartyKit |
|------------|-----|----------|
| Directories | Full hierarchy | N/A |
| File metadata | stat, chmod, chown | N/A |
| Symlinks | Yes | N/A |
| Streaming I/O | ReadStream/WriteStream | N/A |
| Large files | Up to 5GB (R2) | Limited to DO state |
| POSIX compliance | 3,000+ tests | N/A |

PartyKit stores state in Durable Objects but does not expose a filesystem API. If you need to organize data hierarchically with proper file semantics, fsx is the better choice.

### Pricing Model

| Aspect | fsx | PartyKit |
|--------|-----|----------|
| **Billing unit** | Durable Object ops + R2 storage | Durable Object ops |
| **Per-connection cost** | N/A (stateless calls) | Per WebSocket connection |
| **Storage pricing** | R2 rates ($0.015/GB/mo) | DO storage rates |
| **Free tier** | Cloudflare Workers Free | Cloudflare Workers Free |

### When to Choose

**Choose fsx when:**
- Building AI agents that need persistent workspace storage
- Migrating Node.js file-based code to the edge
- Need hierarchical file organization with permissions
- Working with large files or binary data
- Want familiar POSIX semantics

**Choose PartyKit when:**
- Building collaborative editing tools
- Need real-time presence and cursors
- Multiplayer games or interactive experiences
- Require CRDT/Yjs integration
- WebSocket-first architecture

---

## fsx vs Ably

### Overview

- **fsx**: A persistent filesystem API for storing and organizing data at the edge.
- **Ably**: An enterprise pub/sub messaging platform for real-time communication at scale.

### Pub/Sub vs File-Based Approach

| Aspect | fsx | Ably |
|--------|-----|------|
| **Data model** | Persistent files | Transient messages |
| **Communication** | Request/response | Publish/subscribe |
| **Delivery guarantee** | Persistent storage | At-least-once delivery |
| **Message history** | Full file history | Configurable retention |
| **Scalability** | Per-DO isolation | Millions of connections |

**Ably's pub/sub model**: Publishers send messages to channels, subscribers receive them. Messages are ephemeral by default with optional persistence.

**fsx's file model**: Data is written to files and persisted. Readers fetch current state. Changes can be watched via `fs.watch`.

### Use Cases

| Use Case | Best Fit |
|----------|----------|
| Chat applications | Ably |
| Live notifications | Ably |
| Real-time dashboards | Ably |
| AI agent workspaces | fsx |
| Content management | fsx |
| Log/data processing | fsx |
| Config management | fsx |
| Event streaming | Ably |
| IoT telemetry | Ably |
| File uploads/downloads | fsx |

### Architecture Differences

**Ably:**
- Centralized message broker
- Global Points of Presence
- Protocol support: WebSocket, MQTT, HTTP, SSE
- Enterprise SLAs (99.999% uptime)
- Sub-50ms global latency

**fsx:**
- Distributed (per-Durable Object)
- Runs on Cloudflare's edge (300+ locations)
- Protocol: HTTP/RPC
- Zero cold starts
- Microsecond latency for hot tier

### Pricing Comparison

| Metric | fsx | Ably |
|--------|-----|------|
| **Messages** | N/A (file ops) | $2.50/million |
| **Connections** | N/A | $1.00/million minutes |
| **Storage** | R2: $0.015/GB/mo | Message history add-on |
| **Free tier** | Cloudflare free plan | 6M messages/mo |

### When to Choose

**Choose fsx when:**
- Need persistent data storage, not just messaging
- Building file-centric applications
- Working with large files or binaries
- AI workloads requiring workspace isolation
- Already on Cloudflare infrastructure

**Choose Ably when:**
- Building chat or live notification systems
- Need guaranteed message delivery at scale
- Require enterprise SLAs and support
- Multi-protocol support is important
- Fan-out to millions of subscribers

---

## fsx vs Firebase

### Overview

- **fsx**: A POSIX filesystem on Cloudflare's edge, with tiered storage (SQLite + R2).
- **Firebase Realtime Database**: A NoSQL cloud database storing data as a synchronized JSON tree.

### Realtime Database vs fsx

| Feature | fsx | Firebase RTDB |
|---------|-----|---------------|
| **Data structure** | Files & directories | JSON tree |
| **Query model** | File paths | JSON path queries |
| **Real-time sync** | `fs.watch` | Automatic sync |
| **Offline support** | Manual implementation | Built-in persistence |
| **Conflict resolution** | Last-write-wins | Automatic merge |
| **Multi-client sync** | N/A (isolated DOs) | All clients sync |

**Firebase strengths**: Automatic data synchronization across all connected clients, built-in offline persistence, seamless conflict resolution.

**fsx strengths**: Familiar POSIX API, hierarchical file organization, Unix permissions, large file support, edge-first deployment.

### Storage Capabilities

| Capability | fsx | Firebase |
|------------|-----|----------|
| **Max item size** | 5GB (R2) | 10MB per write |
| **Total storage** | Unlimited (R2) | 1GB (free), scalable |
| **File streaming** | Yes | No |
| **Binary data** | Native support | Base64 encoding |
| **Directories** | Native hierarchy | Simulated via paths |
| **Permissions** | Unix chmod/chown | Security rules |

**Note**: Firebase also offers Cloud Storage for Firebase for file storage (images, videos, etc.), which is separate from the Realtime Database and built on Google Cloud Storage.

### Security Model

| Aspect | fsx | Firebase |
|--------|-----|----------|
| **Auth integration** | Custom (DO-level) | Firebase Auth |
| **Access control** | Unix permissions | Declarative rules |
| **Path validation** | Built-in | Rule expressions |
| **Per-user isolation** | DO per user | Shared database |

### Deployment Model

| Aspect | fsx | Firebase |
|--------|-----|----------|
| **Infrastructure** | Cloudflare edge | Google Cloud |
| **Regions** | 300+ edge locations | Multi-region |
| **Cold starts** | Zero (Durable Objects) | N/A (always-on) |
| **Vendor** | Cloudflare | Google |

### When to Choose

**Choose fsx when:**
- Need a true filesystem abstraction
- Building for Cloudflare Workers ecosystem
- Working with large files or binary data
- Want per-instance isolation (AI agents, sandboxes)
- Migrating file-based applications to edge

**Choose Firebase when:**
- Building mobile-first applications
- Need built-in authentication flow
- Want automatic multi-client synchronization
- Offline-first is a core requirement
- Already in Google Cloud ecosystem

---

## fsx Unique Advantages

### 1. POSIX-Compatible API

fsx implements the Node.js `fs` API, making it immediately familiar to millions of developers:

```typescript
import fs from 'fsx.do'

await fs.writeFile('/config.json', JSON.stringify(config))
await fs.mkdir('/uploads', { recursive: true })
const files = await fs.readdir('/uploads')
const stats = await fs.stat('/config.json')
```

No new APIs to learn. Your existing mental model of filesystems applies directly.

### 2. Durable Object Architecture

Each fsx instance runs in its own Durable Object, providing:

- **Strong consistency**: Single-threaded execution guarantees
- **Global singleton**: One instance worldwide, automatically located near users
- **Zero cold starts**: Durable Objects stay warm
- **Isolation**: Each agent/user gets their own filesystem

### 3. Edge-First Design

fsx runs on Cloudflare's network of 300+ data centers:

- **Low latency**: Compute near users globally
- **No origin servers**: No central database to bottleneck
- **Automatic scaling**: Cloudflare handles infrastructure
- **Cost effective**: Pay only for what you use

### 4. Tiered Storage

Intelligent routing between storage tiers:

```
Hot Tier (SQLite)     Warm Tier (R2)
- Metadata            - Large files (>1MB)
- Small files         - Binary blobs
- Microsecond access  - Cost-effective
```

You write files normally; fsx automatically picks the right tier.

### 5. Unix Semantics

Full Unix filesystem features rarely found in cloud storage:

- **Symbolic links**: `fs.symlink()`, `fs.readlink()`
- **Hard links**: `fs.link()`
- **Permissions**: `fs.chmod()`, `fs.chown()`
- **Timestamps**: `fs.utimes()`
- **File watching**: `fs.watch()`

### 6. AI Agent Ready

fsx was designed for AI agent workspaces:

- Each agent gets an isolated filesystem
- Scales to millions of concurrent agents
- Familiar interface for LLM-generated code
- Persistent storage across requests

---

## Summary

| Solution | Best For |
|----------|----------|
| **fsx** | AI agents, file-based workloads, edge computing, POSIX compatibility |
| **PartyKit** | Real-time collaboration, multiplayer, WebSocket-first apps |
| **Ably** | Pub/sub messaging, chat, notifications, enterprise scale |
| **Firebase** | Mobile apps, offline-first, multi-client sync, Google ecosystem |

Each platform serves different needs. The right choice depends on your specific requirements:

- Need a **filesystem**? Choose **fsx**
- Need **real-time collaboration**? Choose **PartyKit**
- Need **pub/sub messaging**? Choose **Ably**
- Need **automatic sync** for mobile? Choose **Firebase**

---

## References

- [fsx.do Documentation](https://fsx.do)
- [PartyKit Documentation](https://docs.partykit.io/)
- [Ably Pub/Sub](https://ably.com/pubsub)
- [Ably Pricing](https://ably.com/pricing)
- [Firebase Realtime Database](https://firebase.google.com/docs/database)
- [Cloud Storage for Firebase](https://firebase.google.com/docs/storage)
- [Cloudflare acquires PartyKit](https://blog.cloudflare.com/cloudflare-acquires-partykit/)
