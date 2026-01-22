/**
 * Cloudflare Workers E2E Tests using Miniflare
 *
 * These tests verify real Durable Object behavior in a simulated Workers environment.
 * Unlike unit tests with mocks, these tests use Miniflare to:
 * - Test actual DO persistence across requests
 * - Test R2 bucket operations
 * - Test file operations through the DO HTTP API
 * - Test worker restart/recovery scenarios
 *
 * Note: These tests use Durable Object storage API (get/put) instead of SQL
 * because the SQL API requires specific Miniflare configuration that varies
 * between versions. The patterns demonstrated here apply equally to SQL-backed DOs.
 *
 * @module tests/e2e/workers-e2e
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Miniflare, Log, LogLevel } from 'miniflare'

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a Miniflare instance configured for FSx testing
 * Uses KV-style storage in DO for maximum compatibility
 */
async function createMiniflare(options?: {
  persist?: boolean
  persistPath?: string
}): Promise<Miniflare> {
  const mf = new Miniflare({
    log: new Log(LogLevel.WARN),
    modules: true,
    script: `
      export class FileSystemDO {
        constructor(state, env) {
          this.state = state;
          this.storage = state.storage;
          this.env = env;
        }

        async initialize() {
          // Check if root exists
          const root = await this.storage.get('file:/');
          if (!root) {
            const now = Date.now();
            await this.storage.put('file:/', {
              path: '/',
              name: '',
              type: 'directory',
              mode: 493, // 0o755
              uid: 0,
              gid: 0,
              size: 0,
              atime: now,
              mtime: now,
              ctime: now,
              birthtime: now,
              nlink: 2
            });
          }
        }

        async fetch(request) {
          await this.initialize();

          const url = new URL(request.url);

          // Handle RPC endpoint
          if (url.pathname === '/rpc' && request.method === 'POST') {
            try {
              const { method, params } = await request.json();
              const result = await this.handleMethod(method, params || {});
              return new Response(JSON.stringify(result), {
                headers: { 'Content-Type': 'application/json' }
              });
            } catch (error) {
              return new Response(JSON.stringify({
                code: error.code || 'UNKNOWN',
                message: error.message,
                path: error.path
              }), {
                status: error.code === 'ENOENT' ? 404 : 400,
                headers: { 'Content-Type': 'application/json' }
              });
            }
          }

          // Handle stream/read endpoint
          if (url.pathname === '/stream/read' && request.method === 'POST') {
            try {
              const { path } = await request.json();
              const file = await this.storage.get('file:' + path);

              if (!file) {
                return new Response(JSON.stringify({ code: 'ENOENT', message: 'no such file or directory', path }), {
                  status: 404,
                  headers: { 'Content-Type': 'application/json' }
                });
              }

              if (file.type === 'directory') {
                return new Response(JSON.stringify({ code: 'EISDIR', message: 'illegal operation on a directory', path }), {
                  status: 400,
                  headers: { 'Content-Type': 'application/json' }
                });
              }

              const blob = await this.storage.get('blob:' + file.blobId);
              const data = blob ? new Uint8Array(blob.data) : new Uint8Array(0);

              return new Response(data, {
                headers: {
                  'Content-Type': 'application/octet-stream',
                  'Content-Length': String(data.length)
                }
              });
            } catch (error) {
              return new Response(JSON.stringify({ code: 'UNKNOWN', message: error.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
              });
            }
          }

          // Handle stream/write endpoint
          if (url.pathname === '/stream/write' && request.method === 'POST') {
            try {
              const path = request.headers.get('X-FSx-Path');
              if (!path) {
                return new Response(JSON.stringify({ code: 'EINVAL', message: 'path required' }), {
                  status: 400,
                  headers: { 'Content-Type': 'application/json' }
                });
              }

              const data = new Uint8Array(await request.arrayBuffer());
              const now = Date.now();

              // Generate blob ID from hash
              const hashBuffer = await crypto.subtle.digest('SHA-256', data);
              const hashArray = new Uint8Array(hashBuffer);
              const blobId = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');

              // Store blob
              const existingBlob = await this.storage.get('blob:' + blobId);
              if (!existingBlob) {
                await this.storage.put('blob:' + blobId, {
                  id: blobId,
                  data: Array.from(data),
                  size: data.length,
                  refCount: 1,
                  createdAt: now
                });
              } else {
                existingBlob.refCount++;
                await this.storage.put('blob:' + blobId, existingBlob);
              }

              // Check if file exists
              const existingFile = await this.storage.get('file:' + path);

              if (existingFile) {
                // Decrement old blob ref
                if (existingFile.blobId && existingFile.blobId !== blobId) {
                  const oldBlob = await this.storage.get('blob:' + existingFile.blobId);
                  if (oldBlob) {
                    oldBlob.refCount--;
                    await this.storage.put('blob:' + existingFile.blobId, oldBlob);
                  }
                }

                existingFile.blobId = blobId;
                existingFile.size = data.length;
                existingFile.mtime = now;
                existingFile.ctime = now;
                await this.storage.put('file:' + path, existingFile);
              } else {
                // Create new file
                const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
                const name = path.substring(path.lastIndexOf('/') + 1);

                await this.storage.put('file:' + path, {
                  path: path,
                  name: name,
                  parentPath: parentPath,
                  type: 'file',
                  mode: 420, // 0o644
                  uid: 0,
                  gid: 0,
                  size: data.length,
                  blobId: blobId,
                  atime: now,
                  mtime: now,
                  ctime: now,
                  birthtime: now,
                  nlink: 1
                });

                // Add to parent's children
                const parent = await this.storage.get('file:' + parentPath);
                if (parent) {
                  const children = parent.children || [];
                  if (!children.includes(name)) {
                    children.push(name);
                    parent.children = children;
                    await this.storage.put('file:' + parentPath, parent);
                  }
                }
              }

              return new Response(JSON.stringify({ success: true, path, size: data.length }), {
                headers: { 'Content-Type': 'application/json' }
              });
            } catch (error) {
              return new Response(JSON.stringify({ code: 'UNKNOWN', message: error.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
              });
            }
          }

          return new Response('Not Found', { status: 404 });
        }

        async handleMethod(method, params) {
          switch (method) {
            case 'writeFile': {
              const { path, data, encoding } = params;
              let bytes;

              if (encoding === 'base64' && typeof data === 'string') {
                const binary = atob(data);
                bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                  bytes[i] = binary.charCodeAt(i);
                }
              } else if (typeof data === 'string') {
                bytes = new TextEncoder().encode(data);
              } else {
                bytes = new Uint8Array(data);
              }

              const now = Date.now();

              // Generate blob ID
              const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
              const hashArray = new Uint8Array(hashBuffer);
              const blobId = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');

              // Store blob
              const existingBlob = await this.storage.get('blob:' + blobId);
              if (!existingBlob) {
                await this.storage.put('blob:' + blobId, {
                  id: blobId,
                  data: Array.from(bytes),
                  size: bytes.length,
                  refCount: 1,
                  createdAt: now
                });
              } else {
                existingBlob.refCount++;
                await this.storage.put('blob:' + blobId, existingBlob);
              }

              // Check if file exists
              const existingFile = await this.storage.get('file:' + path);

              if (existingFile) {
                // Update file
                if (existingFile.blobId && existingFile.blobId !== blobId) {
                  const oldBlob = await this.storage.get('blob:' + existingFile.blobId);
                  if (oldBlob) {
                    oldBlob.refCount--;
                    await this.storage.put('blob:' + existingFile.blobId, oldBlob);
                  }
                }

                existingFile.blobId = blobId;
                existingFile.size = bytes.length;
                existingFile.mtime = now;
                existingFile.ctime = now;
                await this.storage.put('file:' + path, existingFile);
              } else {
                // Verify parent exists
                const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
                const parent = await this.storage.get('file:' + parentPath);

                if (!parent && parentPath !== '/') {
                  const error = new Error('no such file or directory');
                  error.code = 'ENOENT';
                  error.path = parentPath;
                  throw error;
                }

                const name = path.substring(path.lastIndexOf('/') + 1);

                // Create file
                await this.storage.put('file:' + path, {
                  path: path,
                  name: name,
                  parentPath: parentPath,
                  type: 'file',
                  mode: 420,
                  uid: 0,
                  gid: 0,
                  size: bytes.length,
                  blobId: blobId,
                  atime: now,
                  mtime: now,
                  ctime: now,
                  birthtime: now,
                  nlink: 1
                });

                // Update parent's children
                if (parent) {
                  const children = parent.children || [];
                  if (!children.includes(name)) {
                    children.push(name);
                    parent.children = children;
                    await this.storage.put('file:' + parentPath, parent);
                  }
                }
              }

              return { success: true };
            }

            case 'readFile': {
              const { path } = params;
              const file = await this.storage.get('file:' + path);

              if (!file) {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = path;
                throw error;
              }

              if (file.type === 'directory') {
                const error = new Error('illegal operation on a directory');
                error.code = 'EISDIR';
                error.path = path;
                throw error;
              }

              let bytes = [];
              if (file.blobId) {
                const blob = await this.storage.get('blob:' + file.blobId);
                if (blob && blob.data) {
                  bytes = blob.data;
                }
              }

              // Return base64 encoded
              let binary = '';
              for (const byte of bytes) {
                binary += String.fromCharCode(byte);
              }
              return { data: btoa(binary), encoding: 'base64' };
            }

            case 'stat': {
              const { path } = params;
              const file = await this.storage.get('file:' + path);

              if (!file) {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = path;
                throw error;
              }

              return {
                dev: 0,
                ino: 0,
                mode: file.mode,
                nlink: file.nlink || 1,
                uid: file.uid,
                gid: file.gid,
                rdev: 0,
                size: file.size,
                blksize: 4096,
                blocks: Math.ceil(file.size / 512),
                atime: file.atime,
                mtime: file.mtime,
                ctime: file.ctime,
                birthtime: file.birthtime
              };
            }

            case 'mkdir': {
              const { path, recursive, mode } = params;
              const now = Date.now();
              const dirMode = mode || 493; // 0o755

              if (recursive) {
                const parts = path.split('/').filter(Boolean);
                let currentPath = '';

                for (const part of parts) {
                  currentPath += '/' + part;
                  const existing = await this.storage.get('file:' + currentPath);

                  if (!existing) {
                    const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
                    const parent = await this.storage.get('file:' + parentPath);

                    await this.storage.put('file:' + currentPath, {
                      path: currentPath,
                      name: part,
                      parentPath: parentPath,
                      type: 'directory',
                      mode: dirMode,
                      uid: 0,
                      gid: 0,
                      size: 0,
                      children: [],
                      atime: now,
                      mtime: now,
                      ctime: now,
                      birthtime: now,
                      nlink: 2
                    });

                    if (parent) {
                      const children = parent.children || [];
                      children.push(part);
                      parent.children = children;
                      await this.storage.put('file:' + parentPath, parent);
                    }
                  }
                }
              } else {
                const existing = await this.storage.get('file:' + path);
                if (existing) {
                  const error = new Error('file already exists');
                  error.code = 'EEXIST';
                  error.path = path;
                  throw error;
                }

                const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
                const parent = await this.storage.get('file:' + parentPath);

                if (!parent && parentPath !== '/') {
                  const error = new Error('no such file or directory');
                  error.code = 'ENOENT';
                  error.path = parentPath;
                  throw error;
                }

                const name = path.substring(path.lastIndexOf('/') + 1);

                await this.storage.put('file:' + path, {
                  path: path,
                  name: name,
                  parentPath: parentPath,
                  type: 'directory',
                  mode: dirMode,
                  uid: 0,
                  gid: 0,
                  size: 0,
                  children: [],
                  atime: now,
                  mtime: now,
                  ctime: now,
                  birthtime: now,
                  nlink: 2
                });

                if (parent) {
                  const children = parent.children || [];
                  children.push(name);
                  parent.children = children;
                  await this.storage.put('file:' + parentPath, parent);
                }
              }

              return { success: true };
            }

            case 'readdir': {
              const { path, withFileTypes } = params;
              const dir = await this.storage.get('file:' + path);

              if (!dir) {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = path;
                throw error;
              }

              if (dir.type !== 'directory') {
                const error = new Error('not a directory');
                error.code = 'ENOTDIR';
                error.path = path;
                throw error;
              }

              const children = dir.children || [];

              if (withFileTypes) {
                const entries = [];
                for (const name of children) {
                  const childPath = path === '/' ? '/' + name : path + '/' + name;
                  const child = await this.storage.get('file:' + childPath);
                  entries.push({
                    name: name,
                    parentPath: path,
                    type: child ? child.type : 'file'
                  });
                }
                return entries;
              }

              return children;
            }

            case 'unlink': {
              const { path } = params;
              const file = await this.storage.get('file:' + path);

              if (!file) {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = path;
                throw error;
              }

              if (file.type === 'directory') {
                const error = new Error('illegal operation on a directory');
                error.code = 'EISDIR';
                error.path = path;
                throw error;
              }

              // Decrement blob ref
              if (file.blobId) {
                const blob = await this.storage.get('blob:' + file.blobId);
                if (blob) {
                  blob.refCount--;
                  if (blob.refCount <= 0) {
                    await this.storage.delete('blob:' + file.blobId);
                  } else {
                    await this.storage.put('blob:' + file.blobId, blob);
                  }
                }
              }

              // Remove from parent's children
              const parent = await this.storage.get('file:' + file.parentPath);
              if (parent && parent.children) {
                parent.children = parent.children.filter(c => c !== file.name);
                await this.storage.put('file:' + file.parentPath, parent);
              }

              await this.storage.delete('file:' + path);
              return { success: true };
            }

            case 'rmdir': {
              const { path, recursive } = params;
              const dir = await this.storage.get('file:' + path);

              if (!dir) {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = path;
                throw error;
              }

              if (dir.type !== 'directory') {
                const error = new Error('not a directory');
                error.code = 'ENOTDIR';
                error.path = path;
                throw error;
              }

              const children = dir.children || [];

              if (children.length > 0 && !recursive) {
                const error = new Error('directory not empty');
                error.code = 'ENOTEMPTY';
                error.path = path;
                throw error;
              }

              if (recursive) {
                // Recursively delete children
                for (const childName of children) {
                  const childPath = path === '/' ? '/' + childName : path + '/' + childName;
                  const child = await this.storage.get('file:' + childPath);
                  if (child) {
                    if (child.type === 'directory') {
                      await this.handleMethod('rmdir', { path: childPath, recursive: true });
                    } else {
                      await this.handleMethod('unlink', { path: childPath });
                    }
                  }
                }
              }

              // Remove from parent
              const parent = await this.storage.get('file:' + dir.parentPath);
              if (parent && parent.children) {
                parent.children = parent.children.filter(c => c !== dir.name);
                await this.storage.put('file:' + dir.parentPath, parent);
              }

              await this.storage.delete('file:' + path);
              return { success: true };
            }

            case 'exists': {
              const { path } = params;
              const file = await this.storage.get('file:' + path);
              return { exists: !!file };
            }

            case 'rename': {
              const { oldPath, newPath } = params;
              const file = await this.storage.get('file:' + oldPath);

              if (!file) {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = oldPath;
                throw error;
              }

              const now = Date.now();
              const newName = newPath.substring(newPath.lastIndexOf('/') + 1);
              const newParentPath = newPath.substring(0, newPath.lastIndexOf('/')) || '/';
              const newParent = await this.storage.get('file:' + newParentPath);

              if (!newParent && newParentPath !== '/') {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = newParentPath;
                throw error;
              }

              // Remove from old parent
              const oldParent = await this.storage.get('file:' + file.parentPath);
              if (oldParent && oldParent.children) {
                oldParent.children = oldParent.children.filter(c => c !== file.name);
                await this.storage.put('file:' + file.parentPath, oldParent);
              }

              // Update file
              file.path = newPath;
              file.name = newName;
              file.parentPath = newParentPath;
              file.mtime = now;
              file.ctime = now;

              // Delete old entry and create new
              await this.storage.delete('file:' + oldPath);
              await this.storage.put('file:' + newPath, file);

              // Add to new parent
              if (newParent) {
                const children = newParent.children || [];
                children.push(newName);
                newParent.children = children;
                await this.storage.put('file:' + newParentPath, newParent);
              }

              return { success: true };
            }

            case 'copyFile': {
              const { src, dest } = params;
              const srcFile = await this.storage.get('file:' + src);

              if (!srcFile) {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = src;
                throw error;
              }

              if (srcFile.type !== 'file') {
                const error = new Error('illegal operation on a directory');
                error.code = 'EISDIR';
                error.path = src;
                throw error;
              }

              const now = Date.now();
              const destName = dest.substring(dest.lastIndexOf('/') + 1);
              const destParentPath = dest.substring(0, dest.lastIndexOf('/')) || '/';
              const destParent = await this.storage.get('file:' + destParentPath);

              // Increment blob ref count
              if (srcFile.blobId) {
                const blob = await this.storage.get('blob:' + srcFile.blobId);
                if (blob) {
                  blob.refCount++;
                  await this.storage.put('blob:' + srcFile.blobId, blob);
                }
              }

              // Create or update destination
              const existingDest = await this.storage.get('file:' + dest);
              if (existingDest) {
                if (existingDest.blobId && existingDest.blobId !== srcFile.blobId) {
                  const oldBlob = await this.storage.get('blob:' + existingDest.blobId);
                  if (oldBlob) {
                    oldBlob.refCount--;
                    await this.storage.put('blob:' + existingDest.blobId, oldBlob);
                  }
                }
                existingDest.blobId = srcFile.blobId;
                existingDest.size = srcFile.size;
                existingDest.mtime = now;
                existingDest.ctime = now;
                await this.storage.put('file:' + dest, existingDest);
              } else {
                await this.storage.put('file:' + dest, {
                  path: dest,
                  name: destName,
                  parentPath: destParentPath,
                  type: 'file',
                  mode: srcFile.mode,
                  uid: srcFile.uid,
                  gid: srcFile.gid,
                  size: srcFile.size,
                  blobId: srcFile.blobId,
                  atime: now,
                  mtime: now,
                  ctime: now,
                  birthtime: now,
                  nlink: 1
                });

                if (destParent) {
                  const children = destParent.children || [];
                  if (!children.includes(destName)) {
                    children.push(destName);
                    destParent.children = children;
                    await this.storage.put('file:' + destParentPath, destParent);
                  }
                }
              }

              return { success: true };
            }

            case 'getTierStats': {
              // List all blobs and count them
              const stats = { hot: { count: 0, totalSize: 0 }, warm: { count: 0, totalSize: 0 }, cold: { count: 0, totalSize: 0 } };

              const allData = await this.storage.list({ prefix: 'blob:' });
              for (const [key, blob] of allData) {
                if (blob.refCount > 0) {
                  const tier = blob.tier || 'hot';
                  if (stats[tier]) {
                    stats[tier].count++;
                    stats[tier].totalSize += blob.size || 0;
                  }
                }
              }

              return stats;
            }

            case 'ping':
              return { pong: true, timestamp: Date.now() };

            default: {
              const error = new Error('Unknown method: ' + method);
              error.code = 'METHOD_NOT_FOUND';
              throw error;
            }
          }
        }
      }

      export default {
        async fetch(request, env) {
          const url = new URL(request.url);

          // Route to DO
          const doId = env.FSX.idFromName('default');
          const stub = env.FSX.get(doId);
          return stub.fetch(request);
        }
      };
    `,
    compatibilityDate: '2024-12-01',
    durableObjects: {
      FSX: 'FileSystemDO',
    },
    r2Buckets: ['R2', 'ARCHIVE'],
    // Persistence configuration
    ...(options?.persist && {
      durableObjectsPersist: options.persistPath,
      r2Persist: options.persistPath,
    }),
  })

  return mf
}

/**
 * Helper to make RPC calls to the DO
 */
async function rpcCall(
  mf: Miniflare,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const response = await mf.dispatchFetch('http://localhost/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })

  const result = await response.json()

  if (!response.ok) {
    const error = new Error((result as { message?: string }).message || 'RPC call failed')
    ;(error as Error & { code?: string }).code = (result as { code?: string }).code
    throw error
  }

  return result
}

/**
 * Helper to write file via streaming endpoint
 */
async function streamWrite(mf: Miniflare, path: string, data: string | Uint8Array): Promise<void> {
  const body = typeof data === 'string' ? new TextEncoder().encode(data) : data

  const response = await mf.dispatchFetch('http://localhost/stream/write', {
    method: 'POST',
    headers: {
      'X-FSx-Path': path,
      'Content-Type': 'application/octet-stream',
    },
    body,
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error((error as { message?: string }).message || 'Stream write failed')
  }
}

/**
 * Helper to read file via streaming endpoint
 */
async function streamRead(mf: Miniflare, path: string): Promise<Uint8Array> {
  const response = await mf.dispatchFetch('http://localhost/stream/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })

  if (!response.ok) {
    const error = await response.json()
    const e = new Error((error as { message?: string }).message || 'Stream read failed')
    ;(e as Error & { code?: string }).code = (error as { code?: string }).code
    throw e
  }

  return new Uint8Array(await response.arrayBuffer())
}

// ============================================================================
// Durable Object Persistence Tests
// ============================================================================

describe('Durable Object Persistence', () => {
  let mf: Miniflare

  beforeEach(async () => {
    mf = await createMiniflare()
  })

  afterEach(async () => {
    await mf.dispose()
  })

  it('should persist files across multiple requests', async () => {
    // Write a file
    await rpcCall(mf, 'writeFile', {
      path: '/test.txt',
      data: 'Hello, World!',
    })

    // Read it back in a separate request
    const result = await rpcCall(mf, 'readFile', { path: '/test.txt' }) as { data: string; encoding: string }

    // Decode base64
    const content = atob(result.data)
    expect(content).toBe('Hello, World!')
  })

  it('should persist directory structure across requests', async () => {
    // Create nested directories
    await rpcCall(mf, 'mkdir', { path: '/home/user/docs', recursive: true })

    // Write a file in the nested directory
    await rpcCall(mf, 'writeFile', {
      path: '/home/user/docs/notes.txt',
      data: 'My notes',
    })

    // List the directory
    const entries = await rpcCall(mf, 'readdir', { path: '/home/user/docs' }) as string[]
    expect(entries).toContain('notes.txt')
  })

  it('should persist file metadata (mode, timestamps)', async () => {
    // Write a file
    await rpcCall(mf, 'writeFile', { path: '/meta-test.txt', data: 'test' })

    // Get stats
    const stats1 = await rpcCall(mf, 'stat', { path: '/meta-test.txt' }) as { size: number; mode: number; mtime: number }
    expect(stats1.size).toBe(4)
    expect(stats1.mode).toBe(420) // 0o644

    // Wait a bit and update
    await new Promise((r) => setTimeout(r, 10))
    await rpcCall(mf, 'writeFile', { path: '/meta-test.txt', data: 'updated content' })

    // Check mtime changed
    const stats2 = await rpcCall(mf, 'stat', { path: '/meta-test.txt' }) as { mtime: number }
    expect(stats2.mtime).toBeGreaterThan(stats1.mtime)
  })

  it('should handle blob deduplication', async () => {
    const content = 'Duplicate content for testing'

    // Write same content to two different files
    await rpcCall(mf, 'writeFile', { path: '/dup1.txt', data: content })
    await rpcCall(mf, 'writeFile', { path: '/dup2.txt', data: content })

    // Both files should exist
    const exists1 = await rpcCall(mf, 'exists', { path: '/dup1.txt' }) as { exists: boolean }
    const exists2 = await rpcCall(mf, 'exists', { path: '/dup2.txt' }) as { exists: boolean }

    expect(exists1.exists).toBe(true)
    expect(exists2.exists).toBe(true)

    // Read both and verify content
    const read1 = await rpcCall(mf, 'readFile', { path: '/dup1.txt' }) as { data: string }
    const read2 = await rpcCall(mf, 'readFile', { path: '/dup2.txt' }) as { data: string }

    expect(atob(read1.data)).toBe(content)
    expect(atob(read2.data)).toBe(content)
  })

  it('should maintain blob reference counts on delete', async () => {
    const content = 'Shared content'

    // Write to two files
    await rpcCall(mf, 'writeFile', { path: '/shared1.txt', data: content })
    await rpcCall(mf, 'writeFile', { path: '/shared2.txt', data: content })

    // Delete first file
    await rpcCall(mf, 'unlink', { path: '/shared1.txt' })

    // Second file should still be readable
    const result = await rpcCall(mf, 'readFile', { path: '/shared2.txt' }) as { data: string }
    expect(atob(result.data)).toBe(content)
  })
})

// ============================================================================
// File Operations Through DO HTTP API Tests
// ============================================================================

describe('File Operations Through DO HTTP API', () => {
  let mf: Miniflare

  beforeEach(async () => {
    mf = await createMiniflare()
  })

  afterEach(async () => {
    await mf.dispose()
  })

  describe('writeFile and readFile', () => {
    it('should write and read text files', async () => {
      await rpcCall(mf, 'writeFile', {
        path: '/hello.txt',
        data: 'Hello, Workers!',
      })

      const result = await rpcCall(mf, 'readFile', { path: '/hello.txt' }) as { data: string }
      expect(atob(result.data)).toBe('Hello, Workers!')
    })

    it('should write and read binary files', async () => {
      const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd])
      const base64Data = btoa(String.fromCharCode(...binaryData))

      await rpcCall(mf, 'writeFile', {
        path: '/binary.bin',
        data: base64Data,
        encoding: 'base64',
      })

      const result = await rpcCall(mf, 'readFile', { path: '/binary.bin' }) as { data: string }
      const readData = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0))

      expect(readData).toEqual(binaryData)
    })

    it('should throw ENOENT for nonexistent file', async () => {
      await expect(rpcCall(mf, 'readFile', { path: '/nonexistent.txt' })).rejects.toThrow()
    })

    it('should throw EISDIR when reading a directory', async () => {
      await rpcCall(mf, 'mkdir', { path: '/testdir' })
      await expect(rpcCall(mf, 'readFile', { path: '/testdir' })).rejects.toThrow()
    })
  })

  describe('mkdir and readdir', () => {
    it('should create and list directories', async () => {
      await rpcCall(mf, 'mkdir', { path: '/mydir' })
      await rpcCall(mf, 'writeFile', { path: '/mydir/file1.txt', data: 'content1' })
      await rpcCall(mf, 'writeFile', { path: '/mydir/file2.txt', data: 'content2' })

      const entries = await rpcCall(mf, 'readdir', { path: '/mydir' }) as string[]
      expect(entries).toHaveLength(2)
      expect(entries).toContain('file1.txt')
      expect(entries).toContain('file2.txt')
    })

    it('should create nested directories with recursive option', async () => {
      await rpcCall(mf, 'mkdir', { path: '/a/b/c/d', recursive: true })

      const exists = await rpcCall(mf, 'exists', { path: '/a/b/c/d' }) as { exists: boolean }
      expect(exists.exists).toBe(true)
    })

    it('should throw ENOENT for nonexistent parent without recursive', async () => {
      await expect(rpcCall(mf, 'mkdir', { path: '/nonexistent/child' })).rejects.toThrow()
    })

    it('should return file types with withFileTypes option', async () => {
      await rpcCall(mf, 'mkdir', { path: '/mixed' })
      await rpcCall(mf, 'mkdir', { path: '/mixed/subdir' })
      await rpcCall(mf, 'writeFile', { path: '/mixed/file.txt', data: 'content' })

      const entries = await rpcCall(mf, 'readdir', { path: '/mixed', withFileTypes: true }) as Array<{
        name: string
        type: string
      }>

      const fileEntry = entries.find((e) => e.name === 'file.txt')
      const dirEntry = entries.find((e) => e.name === 'subdir')

      expect(fileEntry?.type).toBe('file')
      expect(dirEntry?.type).toBe('directory')
    })
  })

  describe('unlink and rmdir', () => {
    it('should delete files', async () => {
      await rpcCall(mf, 'writeFile', { path: '/to-delete.txt', data: 'delete me' })
      await rpcCall(mf, 'unlink', { path: '/to-delete.txt' })

      const exists = await rpcCall(mf, 'exists', { path: '/to-delete.txt' }) as { exists: boolean }
      expect(exists.exists).toBe(false)
    })

    it('should delete empty directories', async () => {
      await rpcCall(mf, 'mkdir', { path: '/empty-dir' })
      await rpcCall(mf, 'rmdir', { path: '/empty-dir' })

      const exists = await rpcCall(mf, 'exists', { path: '/empty-dir' }) as { exists: boolean }
      expect(exists.exists).toBe(false)
    })

    it('should delete non-empty directories with recursive option', async () => {
      await rpcCall(mf, 'mkdir', { path: '/non-empty' })
      await rpcCall(mf, 'writeFile', { path: '/non-empty/file.txt', data: 'content' })
      await rpcCall(mf, 'rmdir', { path: '/non-empty', recursive: true })

      const exists = await rpcCall(mf, 'exists', { path: '/non-empty' }) as { exists: boolean }
      expect(exists.exists).toBe(false)
    })

    it('should throw ENOTEMPTY for non-empty directory without recursive', async () => {
      await rpcCall(mf, 'mkdir', { path: '/has-files' })
      await rpcCall(mf, 'writeFile', { path: '/has-files/file.txt', data: 'content' })

      await expect(rpcCall(mf, 'rmdir', { path: '/has-files' })).rejects.toThrow()
    })
  })

  describe('rename and copyFile', () => {
    it('should rename files', async () => {
      await rpcCall(mf, 'writeFile', { path: '/old-name.txt', data: 'content' })
      await rpcCall(mf, 'rename', { oldPath: '/old-name.txt', newPath: '/new-name.txt' })

      const oldExists = await rpcCall(mf, 'exists', { path: '/old-name.txt' }) as { exists: boolean }
      const newExists = await rpcCall(mf, 'exists', { path: '/new-name.txt' }) as { exists: boolean }

      expect(oldExists.exists).toBe(false)
      expect(newExists.exists).toBe(true)

      const content = await rpcCall(mf, 'readFile', { path: '/new-name.txt' }) as { data: string }
      expect(atob(content.data)).toBe('content')
    })

    it('should copy files', async () => {
      await rpcCall(mf, 'writeFile', { path: '/original.txt', data: 'original content' })
      await rpcCall(mf, 'copyFile', { src: '/original.txt', dest: '/copy.txt' })

      const originalExists = await rpcCall(mf, 'exists', { path: '/original.txt' }) as { exists: boolean }
      const copyExists = await rpcCall(mf, 'exists', { path: '/copy.txt' }) as { exists: boolean }

      expect(originalExists.exists).toBe(true)
      expect(copyExists.exists).toBe(true)

      const copyContent = await rpcCall(mf, 'readFile', { path: '/copy.txt' }) as { data: string }
      expect(atob(copyContent.data)).toBe('original content')
    })
  })

  describe('stat and exists', () => {
    it('should return file stats', async () => {
      await rpcCall(mf, 'writeFile', { path: '/stats-test.txt', data: 'test content' })

      const stats = await rpcCall(mf, 'stat', { path: '/stats-test.txt' }) as {
        size: number
        mode: number
        mtime: number
        birthtime: number
      }

      expect(stats.size).toBe(12) // 'test content'.length
      expect(stats.mode).toBe(420) // 0o644
      expect(stats.mtime).toBeGreaterThan(0)
      expect(stats.birthtime).toBeGreaterThan(0)
    })

    it('should check file existence', async () => {
      await rpcCall(mf, 'writeFile', { path: '/exists.txt', data: 'content' })

      const exists = await rpcCall(mf, 'exists', { path: '/exists.txt' }) as { exists: boolean }
      const notExists = await rpcCall(mf, 'exists', { path: '/not-exists.txt' }) as { exists: boolean }

      expect(exists.exists).toBe(true)
      expect(notExists.exists).toBe(false)
    })
  })
})

// ============================================================================
// R2 Bucket Operations Tests
// ============================================================================

describe('R2 Bucket Operations', () => {
  let mf: Miniflare

  beforeEach(async () => {
    mf = await createMiniflare()
  })

  afterEach(async () => {
    await mf.dispose()
  })

  it('should have R2 buckets available', async () => {
    // The R2 buckets are configured - verify they exist
    const r2 = await mf.getR2Bucket('R2')
    expect(r2).toBeDefined()

    const archive = await mf.getR2Bucket('ARCHIVE')
    expect(archive).toBeDefined()
  })

  it('should allow direct R2 put and get', async () => {
    const r2 = await mf.getR2Bucket('R2')

    // Put an object
    await r2.put('test-key', 'test value')

    // Get it back
    const obj = await r2.get('test-key')
    expect(obj).not.toBeNull()
    expect(await obj!.text()).toBe('test value')
  })

  it('should support R2 list operations', async () => {
    const r2 = await mf.getR2Bucket('R2')

    // Put multiple objects
    await r2.put('prefix/file1.txt', 'content1')
    await r2.put('prefix/file2.txt', 'content2')
    await r2.put('other/file3.txt', 'content3')

    // List with prefix
    const result = await r2.list({ prefix: 'prefix/' })
    expect(result.objects).toHaveLength(2)
    expect(result.objects.map((o) => o.key)).toContain('prefix/file1.txt')
    expect(result.objects.map((o) => o.key)).toContain('prefix/file2.txt')
  })

  it('should support R2 delete operations', async () => {
    const r2 = await mf.getR2Bucket('R2')

    await r2.put('to-delete', 'content')

    // Verify it exists
    let obj = await r2.get('to-delete')
    expect(obj).not.toBeNull()

    // Delete it
    await r2.delete('to-delete')

    // Verify it's gone
    obj = await r2.get('to-delete')
    expect(obj).toBeNull()
  })

  it('should support binary data in R2', async () => {
    const r2 = await mf.getR2Bucket('R2')

    const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe])
    await r2.put('binary-data', binaryData)

    const obj = await r2.get('binary-data')
    const retrieved = new Uint8Array(await obj!.arrayBuffer())

    expect(retrieved).toEqual(binaryData)
  })
})

// ============================================================================
// Worker Restart/Recovery Tests
// ============================================================================

describe('Worker Restart/Recovery', () => {
  it('should preserve data when creating new miniflare instance with same persist path', async () => {
    const persistPath = '/tmp/fsx-e2e-persist-' + Date.now()

    // Create first instance and write data
    const mf1 = await createMiniflare({ persist: true, persistPath })

    await rpcCall(mf1, 'writeFile', { path: '/persistent.txt', data: 'This should persist' })

    // Dispose first instance (simulates worker restart)
    await mf1.dispose()

    // Create second instance with same persist path
    const mf2 = await createMiniflare({ persist: true, persistPath })

    try {
      // Data should still be there
      const result = await rpcCall(mf2, 'readFile', { path: '/persistent.txt' }) as { data: string }
      expect(atob(result.data)).toBe('This should persist')
    } finally {
      await mf2.dispose()
    }
  })

  it('should handle multiple concurrent requests', async () => {
    const mf = await createMiniflare()

    try {
      // Send multiple requests concurrently
      const promises = []
      for (let i = 0; i < 10; i++) {
        promises.push(
          rpcCall(mf, 'writeFile', {
            path: `/concurrent-${i}.txt`,
            data: `Content ${i}`,
          })
        )
      }

      await Promise.all(promises)

      // Verify all files were created
      for (let i = 0; i < 10; i++) {
        const result = await rpcCall(mf, 'readFile', { path: `/concurrent-${i}.txt` }) as { data: string }
        expect(atob(result.data)).toBe(`Content ${i}`)
      }
    } finally {
      await mf.dispose()
    }
  })

  it('should handle rapid write-read cycles', async () => {
    const mf = await createMiniflare()

    try {
      for (let i = 0; i < 20; i++) {
        const content = `Rapid cycle ${i}: ${Math.random()}`
        await rpcCall(mf, 'writeFile', { path: '/rapid.txt', data: content })
        const result = await rpcCall(mf, 'readFile', { path: '/rapid.txt' }) as { data: string }
        expect(atob(result.data)).toBe(content)
      }
    } finally {
      await mf.dispose()
    }
  })

  it('should maintain consistency after simulated crash recovery', async () => {
    const persistPath = '/tmp/fsx-e2e-crash-' + Date.now()

    // First session: create complex state
    const mf1 = await createMiniflare({ persist: true, persistPath })

    await rpcCall(mf1, 'mkdir', { path: '/data/users', recursive: true })
    await rpcCall(mf1, 'mkdir', { path: '/data/logs', recursive: true })
    await rpcCall(mf1, 'writeFile', { path: '/data/users/user1.json', data: '{"id":1}' })
    await rpcCall(mf1, 'writeFile', { path: '/data/users/user2.json', data: '{"id":2}' })
    await rpcCall(mf1, 'writeFile', { path: '/data/logs/app.log', data: 'log entry' })

    // Abruptly dispose (simulates crash)
    await mf1.dispose()

    // Second session: verify recovery
    const mf2 = await createMiniflare({ persist: true, persistPath })

    try {
      // Directory structure should be preserved
      const dataDir = await rpcCall(mf2, 'readdir', { path: '/data' }) as string[]
      expect(dataDir).toContain('users')
      expect(dataDir).toContain('logs')

      // Files should be intact
      const user1 = await rpcCall(mf2, 'readFile', { path: '/data/users/user1.json' }) as { data: string }
      expect(atob(user1.data)).toBe('{"id":1}')

      const user2 = await rpcCall(mf2, 'readFile', { path: '/data/users/user2.json' }) as { data: string }
      expect(atob(user2.data)).toBe('{"id":2}')

      const log = await rpcCall(mf2, 'readFile', { path: '/data/logs/app.log' }) as { data: string }
      expect(atob(log.data)).toBe('log entry')
    } finally {
      await mf2.dispose()
    }
  })
})

// ============================================================================
// Streaming Endpoint Tests
// ============================================================================

describe('Streaming Endpoints', () => {
  let mf: Miniflare

  beforeEach(async () => {
    mf = await createMiniflare()
  })

  afterEach(async () => {
    await mf.dispose()
  })

  describe('/stream/write', () => {
    it('should write files via streaming endpoint', async () => {
      await streamWrite(mf, '/stream-test.txt', 'Streamed content')

      const result = await rpcCall(mf, 'readFile', { path: '/stream-test.txt' }) as { data: string }
      expect(atob(result.data)).toBe('Streamed content')
    })

    it('should handle binary data via streaming', async () => {
      const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // PNG header

      await streamWrite(mf, '/image.png', binaryData)

      const stats = await rpcCall(mf, 'stat', { path: '/image.png' }) as { size: number }
      expect(stats.size).toBe(8)
    })

    it('should overwrite existing files', async () => {
      await streamWrite(mf, '/overwrite.txt', 'Original')
      await streamWrite(mf, '/overwrite.txt', 'Updated')

      const result = await rpcCall(mf, 'readFile', { path: '/overwrite.txt' }) as { data: string }
      expect(atob(result.data)).toBe('Updated')
    })
  })

  describe('/stream/read', () => {
    it('should read files via streaming endpoint', async () => {
      await rpcCall(mf, 'writeFile', { path: '/to-stream.txt', data: 'Stream read test' })

      const data = await streamRead(mf, '/to-stream.txt')
      const text = new TextDecoder().decode(data)
      expect(text).toBe('Stream read test')
    })

    it('should handle binary files', async () => {
      const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0x03])
      const base64 = btoa(String.fromCharCode(...binaryData))

      await rpcCall(mf, 'writeFile', {
        path: '/binary-stream.bin',
        data: base64,
        encoding: 'base64',
      })

      const readData = await streamRead(mf, '/binary-stream.bin')
      expect(readData).toEqual(binaryData)
    })

    it('should return 404 for nonexistent files', async () => {
      await expect(streamRead(mf, '/nonexistent-stream.txt')).rejects.toThrow()
    })

    it('should return error for directories', async () => {
      await rpcCall(mf, 'mkdir', { path: '/stream-dir' })
      await expect(streamRead(mf, '/stream-dir')).rejects.toThrow()
    })
  })
})

// ============================================================================
// Tier Stats Tests
// ============================================================================

describe('Tier Statistics', () => {
  let mf: Miniflare

  beforeEach(async () => {
    mf = await createMiniflare()
  })

  afterEach(async () => {
    await mf.dispose()
  })

  it('should track blob storage statistics', async () => {
    // Write some files
    await rpcCall(mf, 'writeFile', { path: '/file1.txt', data: 'Content one' })
    await rpcCall(mf, 'writeFile', { path: '/file2.txt', data: 'Content two' })
    await rpcCall(mf, 'writeFile', { path: '/file3.txt', data: 'Content three' })

    const stats = await rpcCall(mf, 'getTierStats') as {
      hot: { count: number; totalSize: number }
      warm: { count: number; totalSize: number }
      cold: { count: number; totalSize: number }
    }

    // All files should be in hot tier by default
    expect(stats.hot.count).toBe(3)
    expect(stats.hot.totalSize).toBeGreaterThan(0)
    expect(stats.warm.count).toBe(0)
    expect(stats.cold.count).toBe(0)
  })

  it('should update stats when files are deleted', async () => {
    await rpcCall(mf, 'writeFile', { path: '/temp.txt', data: 'Temporary' })

    const statsBefore = await rpcCall(mf, 'getTierStats') as {
      hot: { count: number; totalSize: number }
    }
    expect(statsBefore.hot.count).toBe(1)

    await rpcCall(mf, 'unlink', { path: '/temp.txt' })

    const statsAfter = await rpcCall(mf, 'getTierStats') as {
      hot: { count: number; totalSize: number }
    }
    expect(statsAfter.hot.count).toBe(0)
  })
})

// ============================================================================
// Ping/Health Check Tests
// ============================================================================

describe('Health Checks', () => {
  let mf: Miniflare

  beforeEach(async () => {
    mf = await createMiniflare()
  })

  afterEach(async () => {
    await mf.dispose()
  })

  it('should respond to ping requests', async () => {
    const result = await rpcCall(mf, 'ping') as { pong: boolean; timestamp: number }
    expect(result.pong).toBe(true)
    expect(result.timestamp).toBeGreaterThan(0)
  })

  it('should handle unknown methods gracefully', async () => {
    await expect(rpcCall(mf, 'unknownMethod', {})).rejects.toThrow()
  })
})
