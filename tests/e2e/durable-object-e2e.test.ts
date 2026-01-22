/**
 * FileSystemDO E2E Tests using Miniflare (Direct API)
 *
 * These tests exercise the FileSystemDO using direct Miniflare instances,
 * which provides proper cleanup and avoids vitest-pool-workers isolated
 * storage issues.
 *
 * Tests cover:
 * - File operations through RPC
 * - Directory operations
 * - Symbolic links
 * - Blob management and deduplication
 * - Streaming endpoints
 * - Concurrent operations
 * - Error handling
 *
 * @module tests/e2e/durable-object-e2e
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Miniflare, Log, LogLevel } from 'miniflare'

// ============================================================================
// Miniflare Configuration
// ============================================================================

/**
 * Create a Miniflare instance configured for FileSystemDO testing.
 *
 * Uses a simplified FileSystemDO implementation that mirrors the real one
 * but uses DO storage (get/put) instead of SQLite for maximum compatibility.
 */
async function createMiniflare(): Promise<Miniflare> {
  const mf = new Miniflare({
    log: new Log(LogLevel.ERROR),
    modules: true,
    // Main entry point - routes to DO
    script: `
      export class FileSystemDO {
        constructor(state, env) {
          this.state = state;
          this.storage = state.storage;
          this.env = env;
          this.initialized = false;
        }

        async initialize() {
          if (this.initialized) return;

          // Check if root exists
          const root = await this.storage.get('file:/');
          if (!root) {
            const now = Date.now();
            await this.storage.put('file:/', {
              id: 'root',
              path: '/',
              name: '',
              type: 'directory',
              mode: 16877, // 0o040755 (directory with 755 perms)
              uid: 0,
              gid: 0,
              size: 0,
              atime: now,
              mtime: now,
              ctime: now,
              birthtime: now,
              nlink: 2,
              children: []
            });
          }

          this.initialized = true;
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

          // Handle streaming read
          if (url.pathname === '/stream/read' && request.method === 'POST') {
            return this.handleStreamRead(request);
          }

          // Handle streaming write
          if (url.pathname === '/stream/write' && request.method === 'POST') {
            return this.handleStreamWrite(request);
          }

          return new Response('Not Found', { status: 404 });
        }

        // Stream Read Handler with HTTP caching
        async handleStreamRead(request) {
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

            let data = new Uint8Array(0);
            if (file.blobId) {
              const blob = await this.storage.get('blob:' + file.blobId);
              if (blob && blob.data) {
                data = new Uint8Array(blob.data);
              }
            }

            // Generate ETag and Content-Type
            const etag = '"' + file.size + '-' + file.mtime + '"';
            const ext = path.split('.').pop()?.toLowerCase() || '';
            const mimeTypes = {
              'txt': 'text/plain',
              'json': 'application/json',
              'html': 'text/html',
              'css': 'text/css',
              'js': 'application/javascript'
            };
            const contentType = mimeTypes[ext] || 'application/octet-stream';

            // Handle If-None-Match
            const ifNoneMatch = request.headers.get('If-None-Match');
            if (ifNoneMatch && ifNoneMatch === etag) {
              return new Response(null, {
                status: 304,
                headers: {
                  'ETag': etag,
                  'Last-Modified': new Date(file.mtime).toUTCString()
                }
              });
            }

            // Handle Range requests
            const rangeHeader = request.headers.get('Range');
            if (rangeHeader) {
              const match = rangeHeader.match(/bytes=(\\d*)-(\\d*)/);
              if (match) {
                let start = match[1] ? parseInt(match[1]) : 0;
                let end = match[2] ? parseInt(match[2]) : data.length - 1;
                end = Math.min(end, data.length - 1);

                if (start >= data.length || start > end) {
                  return new Response(null, {
                    status: 416,
                    headers: { 'Content-Range': 'bytes */' + data.length }
                  });
                }

                const sliced = data.slice(start, end + 1);
                return new Response(sliced, {
                  status: 206,
                  headers: {
                    'Content-Type': contentType,
                    'Content-Length': String(sliced.length),
                    'Content-Range': 'bytes ' + start + '-' + end + '/' + data.length,
                    'Accept-Ranges': 'bytes',
                    'ETag': etag,
                    'Last-Modified': new Date(file.mtime).toUTCString()
                  }
                });
              }
            }

            return new Response(data, {
              status: 200,
              headers: {
                'Content-Type': contentType,
                'Content-Length': String(data.length),
                'Accept-Ranges': 'bytes',
                'ETag': etag,
                'Last-Modified': new Date(file.mtime).toUTCString()
              }
            });
          } catch (error) {
            return new Response(JSON.stringify({ code: 'UNKNOWN', message: error.message }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        }

        // Stream Write Handler
        async handleStreamWrite(request) {
          const path = request.headers.get('X-FSx-Path');
          if (!path) {
            return new Response(JSON.stringify({ code: 'EINVAL', message: 'path required' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }

          try {
            const data = new Uint8Array(await request.arrayBuffer());
            await this.writeFileInternal(path, data, {});
            return new Response(JSON.stringify({ success: true }), {
              headers: { 'Content-Type': 'application/json' }
            });
          } catch (error) {
            return new Response(JSON.stringify({
              code: error.code || 'UNKNOWN',
              message: error.message
            }), {
              status: error.code === 'ENOENT' ? 404 : 400,
              headers: { 'Content-Type': 'application/json' }
            });
          }
        }

        // Internal file write helper
        async writeFileInternal(path, bytes, options) {
          const now = Date.now();

          // Generate content hash for blob ID
          const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
          const hashArray = new Uint8Array(hashBuffer);
          const blobId = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');

          // Store or reuse blob
          const existingBlob = await this.storage.get('blob:' + blobId);
          if (!existingBlob) {
            await this.storage.put('blob:' + blobId, {
              id: blobId,
              data: Array.from(bytes),
              size: bytes.length,
              checksum: blobId,
              refCount: 1,
              tier: 'hot',
              createdAt: now
            });
          } else {
            existingBlob.refCount++;
            await this.storage.put('blob:' + blobId, existingBlob);
          }

          // Check if file exists
          const existingFile = await this.storage.get('file:' + path);

          if (existingFile) {
            // Update existing file
            if (existingFile.blobId && existingFile.blobId !== blobId) {
              const oldBlob = await this.storage.get('blob:' + existingFile.blobId);
              if (oldBlob) {
                oldBlob.refCount--;
                if (oldBlob.refCount <= 0) {
                  await this.storage.delete('blob:' + existingFile.blobId);
                } else {
                  await this.storage.put('blob:' + existingFile.blobId, oldBlob);
                }
              }
            }

            existingFile.blobId = blobId;
            existingFile.size = bytes.length;
            existingFile.mtime = now;
            existingFile.ctime = now;
            await this.storage.put('file:' + path, existingFile);
          } else {
            // Create new file
            const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
            const parent = await this.storage.get('file:' + parentPath);

            if (!parent && parentPath !== '/') {
              const error = new Error('no such file or directory');
              error.code = 'ENOENT';
              error.path = parentPath;
              throw error;
            }

            const name = path.substring(path.lastIndexOf('/') + 1);
            const mode = options.mode || 33188; // 0o100644 (file with 644 perms)

            await this.storage.put('file:' + path, {
              id: crypto.randomUUID(),
              path: path,
              name: name,
              parentPath: parentPath,
              type: 'file',
              mode: mode,
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

        // RPC Method Handler
        async handleMethod(method, params) {
          switch (method) {
            case 'writeFile': {
              let bytes;
              const data = params.data;

              if (params.encoding === 'base64' && typeof data === 'string') {
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

              return this.writeFileInternal(params.path, bytes, params);
            }

            case 'readFile': {
              const file = await this.storage.get('file:' + params.path);
              if (!file) {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = params.path;
                throw error;
              }

              if (file.type === 'directory') {
                const error = new Error('illegal operation on a directory');
                error.code = 'EISDIR';
                error.path = params.path;
                throw error;
              }

              let bytes = [];
              if (file.blobId) {
                const blob = await this.storage.get('blob:' + file.blobId);
                if (blob && blob.data) {
                  bytes = blob.data;
                }
              }

              if (params.encoding === 'utf-8' || params.encoding === 'utf8') {
                const text = new TextDecoder().decode(new Uint8Array(bytes));
                return { data: text, encoding: 'utf-8' };
              }

              // Return base64 encoded
              let binary = '';
              for (const byte of bytes) {
                binary += String.fromCharCode(byte);
              }
              return { data: btoa(binary), encoding: 'base64' };
            }

            case 'stat':
            case 'lstat': {
              const path = params.path;
              const file = await this.storage.get('file:' + path);

              if (!file) {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = path;
                throw error;
              }

              // For lstat, if it's a symlink, return symlink stats
              if (method === 'lstat' && file.type === 'symlink') {
                return {
                  dev: 0,
                  ino: 0,
                  mode: file.mode || 41471, // 0o120777 for symlink
                  nlink: file.nlink || 1,
                  uid: file.uid || 0,
                  gid: file.gid || 0,
                  rdev: 0,
                  size: file.size || 0,
                  blksize: 4096,
                  blocks: Math.ceil((file.size || 0) / 512),
                  atime: file.atime,
                  mtime: file.mtime,
                  ctime: file.ctime,
                  birthtime: file.birthtime
                };
              }

              // For stat (or lstat on non-symlinks), follow symlink if needed
              let targetFile = file;
              if (method === 'stat' && file.type === 'symlink' && file.target) {
                targetFile = await this.storage.get('file:' + file.target);
                if (!targetFile) {
                  const error = new Error('no such file or directory');
                  error.code = 'ENOENT';
                  error.path = file.target;
                  throw error;
                }
              }

              return {
                dev: 0,
                ino: 0,
                mode: targetFile.mode,
                nlink: targetFile.nlink || 1,
                uid: targetFile.uid || 0,
                gid: targetFile.gid || 0,
                rdev: 0,
                size: targetFile.size || 0,
                blksize: 4096,
                blocks: Math.ceil((targetFile.size || 0) / 512),
                atime: targetFile.atime,
                mtime: targetFile.mtime,
                ctime: targetFile.ctime,
                birthtime: targetFile.birthtime
              };
            }

            case 'mkdir': {
              const { path, recursive, mode } = params;
              const now = Date.now();
              const dirMode = mode || 16877; // 0o040755

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
                      id: crypto.randomUUID(),
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
                      if (!children.includes(part)) {
                        children.push(part);
                        parent.children = children;
                        await this.storage.put('file:' + parentPath, parent);
                      }
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
                  id: crypto.randomUUID(),
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
                  if (!children.includes(name)) {
                    children.push(name);
                    parent.children = children;
                    await this.storage.put('file:' + parentPath, parent);
                  }
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
                    path: childPath,
                    type: child ? child.type : 'file'
                  });
                }
                return entries;
              }

              return children;
            }

            case 'unlink': {
              const file = await this.storage.get('file:' + params.path);

              if (!file) {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = params.path;
                throw error;
              }

              if (file.type === 'directory') {
                const error = new Error('illegal operation on a directory');
                error.code = 'EISDIR';
                error.path = params.path;
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

              await this.storage.delete('file:' + params.path);
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

            case 'rm': {
              const { path, recursive, force } = params;
              const file = await this.storage.get('file:' + path);

              if (!file) {
                if (force) return { success: true };
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = path;
                throw error;
              }

              if (file.type === 'directory') {
                return this.handleMethod('rmdir', { path, recursive });
              } else {
                return this.handleMethod('unlink', { path });
              }
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
              const newParent = await this.storage.get('file:' + newParentPath);
              if (newParent) {
                const children = newParent.children || [];
                if (!children.includes(newName)) {
                  children.push(newName);
                  newParent.children = children;
                  await this.storage.put('file:' + newParentPath, newParent);
                }
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

              // Increment blob ref count
              if (srcFile.blobId) {
                const blob = await this.storage.get('blob:' + srcFile.blobId);
                if (blob) {
                  blob.refCount++;
                  await this.storage.put('blob:' + srcFile.blobId, blob);
                }
              }

              // Create destination
              const existingDest = await this.storage.get('file:' + dest);
              if (existingDest) {
                if (existingDest.blobId && existingDest.blobId !== srcFile.blobId) {
                  const oldBlob = await this.storage.get('blob:' + existingDest.blobId);
                  if (oldBlob) {
                    oldBlob.refCount--;
                    if (oldBlob.refCount <= 0) {
                      await this.storage.delete('blob:' + existingDest.blobId);
                    } else {
                      await this.storage.put('blob:' + existingDest.blobId, oldBlob);
                    }
                  }
                }
                existingDest.blobId = srcFile.blobId;
                existingDest.size = srcFile.size;
                existingDest.mtime = now;
                existingDest.ctime = now;
                await this.storage.put('file:' + dest, existingDest);
              } else {
                await this.storage.put('file:' + dest, {
                  id: crypto.randomUUID(),
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

                const destParent = await this.storage.get('file:' + destParentPath);
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

            case 'exists': {
              const file = await this.storage.get('file:' + params.path);
              return { exists: !!file };
            }

            case 'access': {
              const file = await this.storage.get('file:' + params.path);
              if (!file) {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = params.path;
                throw error;
              }
              return { success: true };
            }

            case 'chmod': {
              const file = await this.storage.get('file:' + params.path);
              if (!file) {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = params.path;
                throw error;
              }

              // Keep file type bits, update permission bits
              const fileTypeBits = file.mode & 0o170000;
              file.mode = fileTypeBits | (params.mode & 0o7777);
              file.ctime = Date.now();
              await this.storage.put('file:' + params.path, file);
              return { success: true };
            }

            case 'chown': {
              const file = await this.storage.get('file:' + params.path);
              if (!file) {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = params.path;
                throw error;
              }

              file.uid = params.uid;
              file.gid = params.gid;
              file.ctime = Date.now();
              await this.storage.put('file:' + params.path, file);
              return { success: true };
            }

            case 'utimes': {
              const file = await this.storage.get('file:' + params.path);
              if (!file) {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = params.path;
                throw error;
              }

              file.atime = typeof params.atime === 'number' ? params.atime : new Date(params.atime).getTime();
              file.mtime = typeof params.mtime === 'number' ? params.mtime : new Date(params.mtime).getTime();
              file.ctime = Date.now();
              await this.storage.put('file:' + params.path, file);
              return { success: true };
            }

            case 'symlink': {
              const now = Date.now();
              const path = params.path;
              const target = params.target;
              const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
              const name = path.substring(path.lastIndexOf('/') + 1);

              const existing = await this.storage.get('file:' + path);
              if (existing) {
                const error = new Error('file already exists');
                error.code = 'EEXIST';
                error.path = path;
                throw error;
              }

              await this.storage.put('file:' + path, {
                id: crypto.randomUUID(),
                path: path,
                name: name,
                parentPath: parentPath,
                type: 'symlink',
                mode: 41471, // 0o120777
                uid: 0,
                gid: 0,
                size: target.length,
                target: target,
                atime: now,
                mtime: now,
                ctime: now,
                birthtime: now,
                nlink: 1
              });

              const parent = await this.storage.get('file:' + parentPath);
              if (parent) {
                const children = parent.children || [];
                if (!children.includes(name)) {
                  children.push(name);
                  parent.children = children;
                  await this.storage.put('file:' + parentPath, parent);
                }
              }

              return { success: true };
            }

            case 'readlink': {
              const file = await this.storage.get('file:' + params.path);
              if (!file) {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = params.path;
                throw error;
              }

              if (file.type !== 'symlink') {
                const error = new Error('invalid argument');
                error.code = 'EINVAL';
                error.path = params.path;
                throw error;
              }

              return { target: file.target };
            }

            case 'truncate': {
              const file = await this.storage.get('file:' + params.path);
              if (!file) {
                const error = new Error('no such file or directory');
                error.code = 'ENOENT';
                error.path = params.path;
                throw error;
              }

              const length = params.length || 0;
              let bytes = [];

              if (file.blobId) {
                const blob = await this.storage.get('blob:' + file.blobId);
                if (blob && blob.data) {
                  bytes = blob.data.slice(0, length);
                }
              }

              // Pad with zeros if needed
              while (bytes.length < length) {
                bytes.push(0);
              }

              // Create new blob
              const newBytes = new Uint8Array(bytes);
              return this.writeFileInternal(params.path, newBytes, {});
            }

            case 'getBlobInfo': {
              let file;
              if (params.path) {
                file = await this.storage.get('file:' + params.path);
                if (!file || !file.blobId) {
                  const error = new Error('file not found or has no blob');
                  error.code = 'ENOENT';
                  error.path = params.path;
                  throw error;
                }
              }

              const blobId = params.blobId || file.blobId;
              const blob = await this.storage.get('blob:' + blobId);
              if (!blob) {
                const error = new Error('blob not found');
                error.code = 'ENOENT';
                throw error;
              }

              return {
                blobId: blobId,
                size: blob.size,
                tier: blob.tier || 'hot',
                checksum: blob.checksum,
                refCount: blob.refCount
              };
            }

            case 'getDedupStats': {
              // Count unique blobs and calculate savings
              const allData = await this.storage.list({ prefix: 'blob:' });
              let uniqueBlobs = 0;
              let totalSize = 0;
              let savedBytes = 0;

              for (const [key, blob] of allData) {
                if (blob.refCount > 0) {
                  uniqueBlobs++;
                  totalSize += blob.size || 0;
                  // Savings = (refCount - 1) * size (extra references don't store data)
                  if (blob.refCount > 1) {
                    savedBytes += (blob.refCount - 1) * (blob.size || 0);
                  }
                }
              }

              return {
                uniqueBlobs,
                savedBytes,
                totalPhysicalSize: totalSize,
                totalLogicalSize: totalSize + savedBytes
              };
            }

            case 'getTierStats': {
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
  })

  return mf
}

// ============================================================================
// Test Helpers
// ============================================================================

async function rpc<T = unknown>(mf: Miniflare, method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await mf.dispatchFetch('http://localhost/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })

  const result = await response.json()

  if (!response.ok) {
    const error = new Error((result as { message?: string }).message || 'RPC call failed')
    ;(error as Error & { code?: string; path?: string }).code = (result as { code?: string }).code
    ;(error as Error & { code?: string; path?: string }).path = (result as { path?: string }).path
    throw error
  }

  return result as T
}

// ============================================================================
// Basic File Operations
// ============================================================================

describe('FileSystemDO E2E - Basic File Operations', () => {
  let mf: Miniflare

  beforeEach(async () => {
    mf = await createMiniflare()
  })

  afterEach(async () => {
    await mf.dispose()
  })

  it('should write and read a text file', async () => {
    await rpc(mf, 'writeFile', { path: '/hello.txt', data: 'Hello, World!' })

    const result = await rpc<{ data: string; encoding: string }>(mf, 'readFile', {
      path: '/hello.txt',
      encoding: 'utf-8',
    })

    expect(result.data).toBe('Hello, World!')
    expect(result.encoding).toBe('utf-8')
  })

  it('should write and read binary data', async () => {
    const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe])
    const base64Data = btoa(String.fromCharCode(...binaryData))

    await rpc(mf, 'writeFile', { path: '/binary.bin', data: base64Data, encoding: 'base64' })

    const result = await rpc<{ data: string; encoding: string }>(mf, 'readFile', { path: '/binary.bin' })
    expect(result.encoding).toBe('base64')

    const decoded = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0))
    expect(decoded).toEqual(binaryData)
  })

  it('should delete a file', async () => {
    await rpc(mf, 'writeFile', { path: '/to-delete.txt', data: 'Delete me' })
    await rpc(mf, 'unlink', { path: '/to-delete.txt' })

    const exists = await rpc<{ exists: boolean }>(mf, 'exists', { path: '/to-delete.txt' })
    expect(exists.exists).toBe(false)
  })

  it('should rename a file', async () => {
    await rpc(mf, 'writeFile', { path: '/old-name.txt', data: 'Rename me' })
    await rpc(mf, 'rename', { oldPath: '/old-name.txt', newPath: '/new-name.txt' })

    const oldExists = await rpc<{ exists: boolean }>(mf, 'exists', { path: '/old-name.txt' })
    const newExists = await rpc<{ exists: boolean }>(mf, 'exists', { path: '/new-name.txt' })

    expect(oldExists.exists).toBe(false)
    expect(newExists.exists).toBe(true)

    const result = await rpc<{ data: string }>(mf, 'readFile', { path: '/new-name.txt', encoding: 'utf-8' })
    expect(result.data).toBe('Rename me')
  })

  it('should copy a file', async () => {
    await rpc(mf, 'writeFile', { path: '/source.txt', data: 'Copy me' })
    await rpc(mf, 'copyFile', { src: '/source.txt', dest: '/dest.txt' })

    const srcExists = await rpc<{ exists: boolean }>(mf, 'exists', { path: '/source.txt' })
    const destExists = await rpc<{ exists: boolean }>(mf, 'exists', { path: '/dest.txt' })

    expect(srcExists.exists).toBe(true)
    expect(destExists.exists).toBe(true)

    const result = await rpc<{ data: string }>(mf, 'readFile', { path: '/dest.txt', encoding: 'utf-8' })
    expect(result.data).toBe('Copy me')
  })

  it('should truncate a file', async () => {
    await rpc(mf, 'writeFile', { path: '/truncate.txt', data: 'x'.repeat(100) })
    await rpc(mf, 'truncate', { path: '/truncate.txt', length: 10 })

    const stats = await rpc<{ size: number }>(mf, 'stat', { path: '/truncate.txt' })
    expect(stats.size).toBe(10)
  })
})

// ============================================================================
// Directory Operations
// ============================================================================

describe('FileSystemDO E2E - Directory Operations', () => {
  let mf: Miniflare

  beforeEach(async () => {
    mf = await createMiniflare()
  })

  afterEach(async () => {
    await mf.dispose()
  })

  it('should create a directory', async () => {
    await rpc(mf, 'mkdir', { path: '/mydir' })

    const stats = await rpc<{ mode: number }>(mf, 'stat', { path: '/mydir' })
    // S_IFDIR = 0o040000
    expect((stats.mode & 0o170000) === 0o040000).toBe(true)
  })

  it('should create nested directories with recursive', async () => {
    await rpc(mf, 'mkdir', { path: '/a/b/c/d', recursive: true })

    for (const path of ['/a', '/a/b', '/a/b/c', '/a/b/c/d']) {
      const exists = await rpc<{ exists: boolean }>(mf, 'exists', { path })
      expect(exists.exists).toBe(true)
    }
  })

  it('should list directory contents', async () => {
    await rpc(mf, 'mkdir', { path: '/listdir' })
    await rpc(mf, 'writeFile', { path: '/listdir/file1.txt', data: 'c1' })
    await rpc(mf, 'writeFile', { path: '/listdir/file2.txt', data: 'c2' })
    await rpc(mf, 'mkdir', { path: '/listdir/subdir' })

    const entries = await rpc<string[]>(mf, 'readdir', { path: '/listdir' })
    expect(entries).toContain('file1.txt')
    expect(entries).toContain('file2.txt')
    expect(entries).toContain('subdir')
  })

  it('should list directory with file types', async () => {
    await rpc(mf, 'mkdir', { path: '/typed' })
    await rpc(mf, 'writeFile', { path: '/typed/file.txt', data: 'c' })
    await rpc(mf, 'mkdir', { path: '/typed/dir' })

    const entries = await rpc<Array<{ name: string; type: string }>>(mf, 'readdir', {
      path: '/typed',
      withFileTypes: true,
    })

    const fileEntry = entries.find((e) => e.name === 'file.txt')
    const dirEntry = entries.find((e) => e.name === 'dir')

    expect(fileEntry?.type).toBe('file')
    expect(dirEntry?.type).toBe('directory')
  })

  it('should remove empty directory', async () => {
    await rpc(mf, 'mkdir', { path: '/empty' })
    await rpc(mf, 'rmdir', { path: '/empty' })

    const exists = await rpc<{ exists: boolean }>(mf, 'exists', { path: '/empty' })
    expect(exists.exists).toBe(false)
  })

  it('should remove directory recursively', async () => {
    await rpc(mf, 'mkdir', { path: '/nested/child', recursive: true })
    await rpc(mf, 'writeFile', { path: '/nested/child/file.txt', data: 'content' })

    await rpc(mf, 'rmdir', { path: '/nested', recursive: true })

    const exists = await rpc<{ exists: boolean }>(mf, 'exists', { path: '/nested' })
    expect(exists.exists).toBe(false)
  })
})

// ============================================================================
// Symbolic Links
// ============================================================================

describe('FileSystemDO E2E - Symbolic Links', () => {
  let mf: Miniflare

  beforeEach(async () => {
    mf = await createMiniflare()
  })

  afterEach(async () => {
    await mf.dispose()
  })

  it('should create and read a symbolic link', async () => {
    await rpc(mf, 'writeFile', { path: '/target.txt', data: 'target content' })
    await rpc(mf, 'symlink', { target: '/target.txt', path: '/mylink' })

    const result = await rpc<{ target: string }>(mf, 'readlink', { path: '/mylink' })
    expect(result.target).toBe('/target.txt')
  })

  it('should differentiate stat and lstat for symlinks', async () => {
    await rpc(mf, 'writeFile', { path: '/lstat-target.txt', data: 'content' })
    await rpc(mf, 'symlink', { target: '/lstat-target.txt', path: '/lstat-link' })

    const statResult = await rpc<{ mode: number }>(mf, 'stat', { path: '/lstat-link' })
    // Should be regular file (follows symlink)
    expect((statResult.mode & 0o170000) === 0o100000).toBe(true)

    const lstatResult = await rpc<{ mode: number }>(mf, 'lstat', { path: '/lstat-link' })
    // Should be symlink
    expect((lstatResult.mode & 0o170000) === 0o120000).toBe(true)
  })
})

// ============================================================================
// File Permissions
// ============================================================================

describe('FileSystemDO E2E - Permissions', () => {
  let mf: Miniflare

  beforeEach(async () => {
    mf = await createMiniflare()
  })

  afterEach(async () => {
    await mf.dispose()
  })

  it('should change file permissions with chmod', async () => {
    await rpc(mf, 'writeFile', { path: '/chmod.txt', data: 'content' })
    await rpc(mf, 'chmod', { path: '/chmod.txt', mode: 0o600 })

    const stats = await rpc<{ mode: number }>(mf, 'stat', { path: '/chmod.txt' })
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('should change file ownership with chown', async () => {
    await rpc(mf, 'writeFile', { path: '/chown.txt', data: 'content' })
    await rpc(mf, 'chown', { path: '/chown.txt', uid: 1000, gid: 1000 })

    const stats = await rpc<{ uid: number; gid: number }>(mf, 'stat', { path: '/chown.txt' })
    expect(stats.uid).toBe(1000)
    expect(stats.gid).toBe(1000)
  })
})

// ============================================================================
// Blob Management
// ============================================================================

describe('FileSystemDO E2E - Blob Management', () => {
  let mf: Miniflare

  beforeEach(async () => {
    mf = await createMiniflare()
  })

  afterEach(async () => {
    await mf.dispose()
  })

  it('should deduplicate identical content', async () => {
    const content = 'Identical content for deduplication'

    await rpc(mf, 'writeFile', { path: '/dup1.txt', data: content })
    await rpc(mf, 'writeFile', { path: '/dup2.txt', data: content })

    const info1 = await rpc<{ blobId: string }>(mf, 'getBlobInfo', { path: '/dup1.txt' })
    const info2 = await rpc<{ blobId: string }>(mf, 'getBlobInfo', { path: '/dup2.txt' })

    // Same blob ID = deduplication working
    expect(info1.blobId).toBe(info2.blobId)
  })

  it('should track blob info', async () => {
    await rpc(mf, 'writeFile', { path: '/blob-info.txt', data: 'blob content' })

    const info = await rpc<{
      blobId: string
      size: number
      tier: string
      checksum: string
      refCount: number
    }>(mf, 'getBlobInfo', { path: '/blob-info.txt' })

    expect(info.blobId).toBeTruthy()
    expect(info.size).toBe('blob content'.length)
    expect(info.tier).toBe('hot')
    expect(info.refCount).toBeGreaterThanOrEqual(1)
  })

  it('should get dedup stats', async () => {
    // Write some files with duplicates
    await rpc(mf, 'writeFile', { path: '/file1.txt', data: 'same content' })
    await rpc(mf, 'writeFile', { path: '/file2.txt', data: 'same content' })
    await rpc(mf, 'writeFile', { path: '/file3.txt', data: 'different content' })

    const stats = await rpc<{
      uniqueBlobs: number
      savedBytes: number
      totalPhysicalSize: number
      totalLogicalSize: number
    }>(mf, 'getDedupStats')

    expect(stats.uniqueBlobs).toBe(2) // 'same content' and 'different content'
    expect(stats.savedBytes).toBeGreaterThan(0) // Dedup savings
  })
})

// ============================================================================
// Streaming Endpoints
// ============================================================================

describe('FileSystemDO E2E - Streaming Endpoints', () => {
  let mf: Miniflare

  beforeEach(async () => {
    mf = await createMiniflare()
  })

  afterEach(async () => {
    await mf.dispose()
  })

  it('should stream read a file with HTTP caching headers', async () => {
    await rpc(mf, 'writeFile', { path: '/stream.txt', data: 'Stream content' })

    const response = await mf.dispatchFetch('http://localhost/stream/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/stream.txt' }),
    })

    expect(response.ok).toBe(true)
    expect(response.headers.get('ETag')).toBeTruthy()
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')

    const text = await response.text()
    expect(text).toBe('Stream content')
  })

  it('should support HTTP Range requests', async () => {
    await rpc(mf, 'writeFile', { path: '/range.txt', data: '0123456789ABCDEF' })

    const response = await mf.dispatchFetch('http://localhost/stream/read', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Range: 'bytes=5-10',
      },
      body: JSON.stringify({ path: '/range.txt' }),
    })

    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toContain('bytes 5-10/')

    const text = await response.text()
    expect(text).toBe('56789A')
  })

  it('should support conditional requests (If-None-Match)', async () => {
    await rpc(mf, 'writeFile', { path: '/conditional.txt', data: 'content' })

    // First request to get ETag
    const first = await mf.dispatchFetch('http://localhost/stream/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/conditional.txt' }),
    })
    const etag = first.headers.get('ETag')
    await first.text() // Consume body

    // Second request with If-None-Match
    const second = await mf.dispatchFetch('http://localhost/stream/read', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'If-None-Match': etag!,
      },
      body: JSON.stringify({ path: '/conditional.txt' }),
    })

    expect(second.status).toBe(304) // Not Modified
  })

  it('should stream write a file', async () => {
    const response = await mf.dispatchFetch('http://localhost/stream/write', {
      method: 'POST',
      headers: { 'X-FSx-Path': '/stream-write.txt' },
      body: 'Stream write content',
    })

    expect(response.ok).toBe(true)

    const result = await rpc<{ data: string }>(mf, 'readFile', {
      path: '/stream-write.txt',
      encoding: 'utf-8',
    })
    expect(result.data).toBe('Stream write content')
  })
})

// ============================================================================
// Error Handling
// ============================================================================

describe('FileSystemDO E2E - Error Handling', () => {
  let mf: Miniflare

  beforeEach(async () => {
    mf = await createMiniflare()
  })

  afterEach(async () => {
    await mf.dispose()
  })

  it('should return ENOENT for missing files', async () => {
    await expect(rpc(mf, 'readFile', { path: '/nonexistent.txt' })).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('should return EISDIR when reading directory as file', async () => {
    await rpc(mf, 'mkdir', { path: '/isdir' })

    await expect(rpc(mf, 'readFile', { path: '/isdir' })).rejects.toMatchObject({
      code: 'EISDIR',
    })
  })

  it('should return ENOTDIR when reading file as directory', async () => {
    await rpc(mf, 'writeFile', { path: '/notdir.txt', data: 'content' })

    await expect(rpc(mf, 'readdir', { path: '/notdir.txt' })).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })

  it('should return ENOTEMPTY for non-empty directory', async () => {
    await rpc(mf, 'mkdir', { path: '/notempty' })
    await rpc(mf, 'writeFile', { path: '/notempty/file.txt', data: 'content' })

    await expect(rpc(mf, 'rmdir', { path: '/notempty' })).rejects.toMatchObject({
      code: 'ENOTEMPTY',
    })
  })
})

// ============================================================================
// Concurrent Operations
// ============================================================================

describe('FileSystemDO E2E - Concurrent Operations', () => {
  let mf: Miniflare

  beforeEach(async () => {
    mf = await createMiniflare()
  })

  afterEach(async () => {
    await mf.dispose()
  })

  it('should handle concurrent writes to different files', async () => {
    await rpc(mf, 'mkdir', { path: '/concurrent' })

    const writes = Array.from({ length: 10 }, (_, i) =>
      rpc(mf, 'writeFile', { path: `/concurrent/file-${i}.txt`, data: `Content ${i}` })
    )

    await Promise.all(writes)

    for (let i = 0; i < 10; i++) {
      const result = await rpc<{ data: string }>(mf, 'readFile', {
        path: `/concurrent/file-${i}.txt`,
        encoding: 'utf-8',
      })
      expect(result.data).toBe(`Content ${i}`)
    }
  })

  it('should handle concurrent reads', async () => {
    await rpc(mf, 'writeFile', { path: '/concurrent-read.txt', data: 'Concurrent content' })

    const reads = Array.from({ length: 10 }, () =>
      rpc<{ data: string }>(mf, 'readFile', { path: '/concurrent-read.txt', encoding: 'utf-8' })
    )

    const results = await Promise.all(reads)
    for (const result of results) {
      expect(result.data).toBe('Concurrent content')
    }
  })
})
