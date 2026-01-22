/**
 * FsBackend Interface
 *
 * The pluggable storage backend interface for @dotdo/fsx.
 * Implement this interface to create custom storage backends
 * (SQLite, R2, Memory, Node.js fs, etc.)
 *
 * @category Framework
 * @module backend
 */
// =============================================================================
// Memory Backend (for testing)
// =============================================================================
/**
 * In-memory filesystem backend for testing.
 *
 * @example
 * ```typescript
 * const backend = new MemoryBackend()
 * const fs = new FSx(backend)
 *
 * await fs.write('/test.txt', 'Hello')
 * const content = await fs.read('/test.txt', { encoding: 'utf-8' })
 * ```
 */
export class MemoryBackend {
    files = new Map();
    directories = new Set(['/']);
    /**
     * Normalize a path by resolving . and .., removing duplicate slashes,
     * and stripping trailing slashes (except for root).
     */
    normalizePath(path) {
        if (!path) {
            throw new Error('ENOENT: path cannot be empty');
        }
        // Handle double slashes by replacing with single slash
        path = path.replace(/\/+/g, '/');
        // Split and resolve . and ..
        const parts = path.split('/');
        const resolved = [];
        for (const part of parts) {
            if (part === '..') {
                resolved.pop();
            }
            else if (part !== '.' && part !== '') {
                resolved.push(part);
            }
        }
        // Reconstruct path
        let result = '/' + resolved.join('/');
        // Strip trailing slash (except for root)
        if (result !== '/' && result.endsWith('/')) {
            result = result.slice(0, -1);
        }
        return result;
    }
    /**
     * Get the parent directory of a path.
     */
    getParentDir(path) {
        const normalized = this.normalizePath(path);
        if (normalized === '/')
            return '/';
        const lastSlash = normalized.lastIndexOf('/');
        return lastSlash === 0 ? '/' : normalized.slice(0, lastSlash);
    }
    /**
     * Check if parent directory exists and path components are valid.
     * Returns error type or null if valid.
     */
    validatePath(path) {
        const normalized = this.normalizePath(path);
        if (normalized === '/')
            return null;
        const parts = normalized.split('/').filter(Boolean);
        let current = '';
        // Check all parent components
        for (let i = 0; i < parts.length - 1; i++) {
            current += '/' + parts[i];
            // If a file exists at this path, it's ENOTDIR
            if (this.files.has(current)) {
                return 'ENOTDIR';
            }
            // If neither file nor directory exists, it's ENOENT
            if (!this.directories.has(current)) {
                return 'ENOENT';
            }
        }
        return null;
    }
    async readFile(path) {
        const normalized = this.normalizePath(path);
        // Check if it's a directory first
        if (this.directories.has(normalized)) {
            throw new Error(`EISDIR: illegal operation on a directory: ${path}`);
        }
        const file = this.files.get(normalized);
        if (!file) {
            throw new Error(`ENOENT: no such file: ${path}`);
        }
        return file.data;
    }
    async writeFile(path, data, options) {
        const normalized = this.normalizePath(path);
        // Check if path is a directory
        if (this.directories.has(normalized)) {
            throw new Error(`EISDIR: illegal operation on a directory: ${path}`);
        }
        // Validate parent path
        const pathError = this.validatePath(normalized);
        if (pathError === 'ENOTDIR') {
            throw new Error(`ENOTDIR: not a directory: ${path}`);
        }
        if (pathError === 'ENOENT') {
            throw new Error(`ENOENT: no such file or directory: ${path}`);
        }
        const now = Date.now();
        const mode = options?.mode ?? 0o644;
        const existing = this.files.get(normalized);
        const ino = existing?.stats.ino ?? this.files.size + 1;
        const birthtimeMs = existing?.stats.birthtimeMs ?? now;
        this.files.set(normalized, {
            data,
            stats: {
                dev: 1,
                ino,
                mode: 0o100000 | mode, // S_IFREG | mode
                nlink: 1,
                uid: 0,
                gid: 0,
                rdev: 0,
                size: data.length,
                blksize: 4096,
                blocks: Math.ceil(data.length / 512),
                atimeMs: now,
                mtimeMs: now,
                ctimeMs: now,
                birthtimeMs,
            },
        });
        return { bytesWritten: data.length, tier: 'hot' };
    }
    async appendFile(path, data) {
        const normalized = this.normalizePath(path);
        const existing = this.files.get(normalized);
        if (existing) {
            const newData = new Uint8Array(existing.data.length + data.length);
            newData.set(existing.data);
            newData.set(data, existing.data.length);
            existing.data = newData;
            existing.stats.size = newData.length;
            existing.stats.mtimeMs = Date.now();
        }
        else {
            await this.writeFile(path, data);
        }
    }
    async unlink(path) {
        const normalized = this.normalizePath(path);
        // Check if it's a directory
        if (this.directories.has(normalized)) {
            throw new Error(`EISDIR: illegal operation on a directory: ${path}`);
        }
        if (!this.files.has(normalized)) {
            throw new Error(`ENOENT: no such file: ${path}`);
        }
        this.files.delete(normalized);
    }
    async rename(oldPath, newPath) {
        const normalizedOld = this.normalizePath(oldPath);
        const normalizedNew = this.normalizePath(newPath);
        // Check destination parent exists
        const destParent = this.getParentDir(normalizedNew);
        if (destParent !== '/' && !this.directories.has(destParent)) {
            throw new Error(`ENOENT: no such file or directory: ${newPath}`);
        }
        // Check if source is a directory
        if (this.directories.has(normalizedOld)) {
            // Rename directory
            const oldPrefix = normalizedOld === '/' ? '/' : normalizedOld + '/';
            // Collect all paths to rename
            const filesToRename = [];
            const dirsToRename = [];
            for (const [filePath, file] of this.files) {
                if (filePath.startsWith(oldPrefix)) {
                    const newFilePath = normalizedNew + filePath.slice(normalizedOld.length);
                    filesToRename.push({ old: filePath, new: newFilePath, file });
                }
            }
            for (const dirPath of this.directories) {
                if (dirPath === normalizedOld || dirPath.startsWith(oldPrefix)) {
                    const newDirPath = normalizedNew + dirPath.slice(normalizedOld.length);
                    dirsToRename.push({ old: dirPath, new: newDirPath });
                }
            }
            // Apply renames
            for (const { old, new: newPath, file } of filesToRename) {
                this.files.delete(old);
                this.files.set(newPath, file);
            }
            for (const { old, new: newPath } of dirsToRename) {
                this.directories.delete(old);
                this.directories.add(newPath);
            }
            return;
        }
        // Rename file
        const file = this.files.get(normalizedOld);
        if (!file) {
            throw new Error(`ENOENT: no such file: ${oldPath}`);
        }
        // Remove destination if it exists (overwrite)
        this.files.delete(normalizedNew);
        this.files.set(normalizedNew, file);
        this.files.delete(normalizedOld);
    }
    async copyFile(src, dest) {
        const normalizedSrc = this.normalizePath(src);
        const normalizedDest = this.normalizePath(dest);
        // Check if source is a directory
        if (this.directories.has(normalizedSrc)) {
            throw new Error(`EISDIR: illegal operation on a directory: ${src}`);
        }
        const file = this.files.get(normalizedSrc);
        if (!file) {
            throw new Error(`ENOENT: no such file: ${src}`);
        }
        // Check destination parent exists
        const destParent = this.getParentDir(normalizedDest);
        if (destParent !== '/' && !this.directories.has(destParent)) {
            throw new Error(`ENOENT: no such file or directory: ${dest}`);
        }
        const now = Date.now();
        this.files.set(normalizedDest, {
            data: new Uint8Array(file.data),
            stats: { ...file.stats, atimeMs: now, mtimeMs: now, ctimeMs: now },
        });
    }
    async mkdir(path, options) {
        const normalized = this.normalizePath(path);
        // Check if file exists at path
        if (this.files.has(normalized)) {
            throw new Error(`EEXIST: file exists: ${path}`);
        }
        if (options?.recursive) {
            // With recursive, we don't throw if directory exists
            if (this.directories.has(normalized)) {
                return;
            }
            const parts = normalized.split('/').filter(Boolean);
            let current = '';
            for (const part of parts) {
                current += '/' + part;
                // Check if a file exists in the path
                if (this.files.has(current)) {
                    throw new Error(`ENOTDIR: not a directory: ${current}`);
                }
                this.directories.add(current);
            }
        }
        else {
            // Non-recursive: check if already exists
            if (this.directories.has(normalized)) {
                throw new Error(`EEXIST: directory exists: ${path}`);
            }
            // Check parent exists and is valid
            const pathError = this.validatePath(normalized);
            if (pathError === 'ENOTDIR') {
                throw new Error(`ENOTDIR: not a directory: ${path}`);
            }
            if (pathError === 'ENOENT') {
                throw new Error(`ENOENT: no such file or directory: ${path}`);
            }
            this.directories.add(normalized);
        }
    }
    async rmdir(path, options) {
        const normalized = this.normalizePath(path);
        // Cannot remove root
        if (normalized === '/') {
            throw new Error('EPERM: operation not permitted: /');
        }
        // Check if it's a file
        if (this.files.has(normalized)) {
            throw new Error(`ENOTDIR: not a directory: ${path}`);
        }
        if (!this.directories.has(normalized)) {
            throw new Error(`ENOENT: no such directory: ${path}`);
        }
        // Check if directory is empty
        const prefix = normalized + '/';
        const hasChildren = [...this.files.keys(), ...this.directories].some((p) => p !== normalized && p.startsWith(prefix));
        if (hasChildren && !options?.recursive) {
            throw new Error(`ENOTEMPTY: directory not empty: ${path}`);
        }
        if (options?.recursive) {
            for (const file of this.files.keys()) {
                if (file.startsWith(prefix)) {
                    this.files.delete(file);
                }
            }
            for (const dir of this.directories) {
                if (dir.startsWith(prefix)) {
                    this.directories.delete(dir);
                }
            }
        }
        this.directories.delete(normalized);
    }
    async readdir(path, options) {
        const normalized = this.normalizePath(path);
        // Check if it's a file
        if (this.files.has(normalized)) {
            throw new Error(`ENOTDIR: not a directory: ${path}`);
        }
        // Check if directory exists
        if (!this.directories.has(normalized)) {
            throw new Error(`ENOENT: no such directory: ${path}`);
        }
        const prefix = normalized === '/' ? '/' : normalized + '/';
        const entries = new Set();
        // Find direct children
        for (const file of this.files.keys()) {
            if (file.startsWith(prefix)) {
                const relative = file.slice(prefix.length);
                const firstPart = relative.split('/')[0];
                if (firstPart)
                    entries.add(firstPart);
            }
        }
        for (const dir of this.directories) {
            if (dir.startsWith(prefix) && dir !== normalized) {
                const relative = dir.slice(prefix.length);
                const firstPart = relative.split('/')[0];
                if (firstPart)
                    entries.add(firstPart);
            }
        }
        if (options?.withFileTypes) {
            const { Dirent: DirentClass } = await import('./types.js');
            const result = [];
            for (const name of entries) {
                const fullPath = prefix + name;
                const isDir = this.directories.has(fullPath);
                result.push(new DirentClass(name, normalized, isDir ? 'directory' : 'file'));
            }
            return result;
        }
        return [...entries];
    }
    async stat(path) {
        const normalized = this.normalizePath(path);
        // Check if it's a file
        const file = this.files.get(normalized);
        if (file) {
            const { Stats } = await import('./types.js');
            return new Stats(file.stats);
        }
        // Check if it's a directory
        if (this.directories.has(normalized)) {
            const { Stats } = await import('./types.js');
            const now = Date.now();
            return new Stats({
                dev: 1,
                ino: 0,
                mode: 0o40755, // S_IFDIR | 0o755
                nlink: 2,
                uid: 0,
                gid: 0,
                rdev: 0,
                size: 4096,
                blksize: 4096,
                blocks: 8,
                atimeMs: now,
                mtimeMs: now,
                ctimeMs: now,
                birthtimeMs: now,
            });
        }
        throw new Error(`ENOENT: no such file or directory: ${path}`);
    }
    async lstat(path) {
        return this.stat(path);
    }
    async exists(path) {
        const normalized = this.normalizePath(path);
        return this.files.has(normalized) || this.directories.has(normalized);
    }
    async access(path, mode) {
        const normalized = this.normalizePath(path);
        // Check if path exists
        const file = this.files.get(normalized);
        const isDir = this.directories.has(normalized);
        if (!file && !isDir) {
            throw new Error(`ENOENT: no such file or directory: ${path}`);
        }
        // F_OK (0) only checks existence - we're done
        const F_OK = 0;
        const R_OK = 4;
        const W_OK = 2;
        const X_OK = 1;
        const checkMode = mode ?? F_OK;
        if (checkMode === F_OK) {
            return;
        }
        // Get the file mode for permission checking
        // For files, use the stored mode; for directories, default to 0o755
        const fileMode = file ? (file.stats.mode & 0o777) : 0o755;
        // Default user context (uid=0, gid=0 means root, has all permissions)
        // In a real implementation, this would come from the process context
        const uid = 0;
        const gid = 0;
        const fileUid = file?.stats.uid ?? 0;
        const fileGid = file?.stats.gid ?? 0;
        // Permission bit positions
        const OWNER_SHIFT = 6;
        const GROUP_SHIFT = 3;
        // OTHER_SHIFT = 0 (no shift needed)
        /**
         * Check if a specific permission is granted.
         * Follows POSIX semantics: check owner, then group, then other.
         */
        const hasPermission = (permBit) => {
            // Root (uid=0) has all permissions
            if (uid === 0)
                return true;
            // Check owner permissions if uid matches
            if (fileUid === uid) {
                return (fileMode & (permBit << OWNER_SHIFT)) !== 0;
            }
            // Check group permissions if gid matches
            if (fileGid === gid) {
                return (fileMode & (permBit << GROUP_SHIFT)) !== 0;
            }
            // Check other permissions
            return (fileMode & permBit) !== 0;
        };
        // Check read permission
        if ((checkMode & R_OK) !== 0) {
            if (!hasPermission(R_OK)) {
                throw new Error(`EACCES: permission denied: ${path}`);
            }
        }
        // Check write permission
        if ((checkMode & W_OK) !== 0) {
            if (!hasPermission(W_OK)) {
                throw new Error(`EACCES: permission denied: ${path}`);
            }
        }
        // Check execute permission
        if ((checkMode & X_OK) !== 0) {
            if (!hasPermission(X_OK)) {
                throw new Error(`EACCES: permission denied: ${path}`);
            }
        }
    }
    async chmod(path, mode) {
        const normalized = this.normalizePath(path);
        const file = this.files.get(normalized);
        if (file) {
            file.stats.mode = 0o100000 | (mode & 0o777); // S_IFREG | mode
            return;
        }
        if (this.directories.has(normalized)) {
            // Directories don't store stats in our simple implementation
            // but we accept the call
            return;
        }
        throw new Error(`ENOENT: no such file or directory: ${path}`);
    }
    async chown(path, uid, gid) {
        const normalized = this.normalizePath(path);
        const file = this.files.get(normalized);
        if (file) {
            file.stats.uid = uid;
            file.stats.gid = gid;
            return;
        }
        if (this.directories.has(normalized)) {
            // Directories don't store stats in our simple implementation
            return;
        }
        throw new Error(`ENOENT: no such file or directory: ${path}`);
    }
    async utimes(path, atime, mtime) {
        const normalized = this.normalizePath(path);
        const atimeMs = atime instanceof Date ? atime.getTime() : atime;
        const mtimeMs = mtime instanceof Date ? mtime.getTime() : mtime;
        const file = this.files.get(normalized);
        if (file) {
            file.stats.atimeMs = atimeMs;
            file.stats.mtimeMs = mtimeMs;
            return;
        }
        if (this.directories.has(normalized)) {
            // Directories don't store stats in our simple implementation
            return;
        }
        throw new Error(`ENOENT: no such file or directory: ${path}`);
    }
    async symlink(_target, _path) {
        throw new Error('Symlinks not supported in memory backend');
    }
    async link(_existingPath, _newPath) {
        throw new Error('Hard links not supported in memory backend');
    }
    async readlink(_path) {
        throw new Error('Symlinks not supported in memory backend');
    }
    async realpath(path) {
        const normalized = this.normalizePath(path);
        if (!this.files.has(normalized) && !this.directories.has(normalized)) {
            throw new Error(`ENOENT: no such file or directory: ${path}`);
        }
        return normalized;
    }
    async mkdtemp(prefix) {
        const random = Math.random().toString(36).substring(2, 8);
        const path = `${prefix}${random}`;
        await this.mkdir(path);
        return path;
    }
    async open(_path, _flags, _mode) {
        throw new Error('File handles not supported in basic MemoryBackend. Use MockBackend instead.');
    }
    // Optional tiering operations
    async getTier(path) {
        const normalized = this.normalizePath(path);
        if (!this.files.has(normalized)) {
            throw new Error(`ENOENT: no such file: ${path}`);
        }
        return 'hot';
    }
    async promote(_path, _tier) {
        // No-op for memory backend - everything is already "hot"
    }
    async demote(_path, _tier) {
        // No-op for memory backend
    }
}
//# sourceMappingURL=backend.js.map