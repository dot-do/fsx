/**
 * Media Management Module
 *
 * Handles uploading, storing, and serving media files.
 */

import { FSx, ENOENT } from 'fsx.do'

interface MediaMetadata {
  filename: string
  category: string
  mimeType: string
  size: number
  uploadedAt: number
  width?: number
  height?: number
  alt?: string
}

/**
 * Manages media files in the filesystem
 */
export class MediaManager {
  private fs: FSx
  private basePath: string

  constructor(fs: FSx, basePath: string) {
    this.fs = fs
    this.basePath = basePath
  }

  /**
   * Upload a media file
   */
  async upload(
    category: string,
    filename: string,
    data: Uint8Array | string,
    metadata?: Partial<MediaMetadata>
  ): Promise<string> {
    const path = this.getPath(category, filename)
    const metaPath = this.getMetaPath(category, filename)

    // Write file content
    await this.fs.writeFile(path, data)

    // Write metadata
    const meta: MediaMetadata = {
      filename,
      category,
      mimeType: metadata?.mimeType ?? this.getMimeType(filename),
      size: typeof data === 'string' ? data.length : data.byteLength,
      uploadedAt: Date.now(),
      width: metadata?.width,
      height: metadata?.height,
      alt: metadata?.alt,
    }

    await this.fs.writeFile(metaPath, JSON.stringify(meta, null, 2))

    return path
  }

  /**
   * Get a media file
   */
  async get(category: string, filename: string): Promise<Uint8Array | string> {
    const path = this.getPath(category, filename)
    return this.fs.readFile(path)
  }

  /**
   * Get media file as a stream (for large files)
   */
  async getStream(category: string, filename: string): Promise<ReadableStream<Uint8Array>> {
    const path = this.getPath(category, filename)
    return this.fs.createReadStream(path)
  }

  /**
   * Get media metadata
   */
  async getMetadata(category: string, filename: string): Promise<MediaMetadata | null> {
    const metaPath = this.getMetaPath(category, filename)

    try {
      const data = await this.fs.readFile(metaPath, 'utf-8')
      return JSON.parse(data as string)
    } catch (error) {
      if (error instanceof ENOENT) {
        // Try to generate metadata from file stats
        try {
          const path = this.getPath(category, filename)
          const stats = await this.fs.stat(path)
          return {
            filename,
            category,
            mimeType: this.getMimeType(filename),
            size: stats.size,
            uploadedAt: stats.mtime.getTime(),
          }
        } catch {
          return null
        }
      }
      throw error
    }
  }

  /**
   * Update media metadata
   */
  async updateMetadata(
    category: string,
    filename: string,
    updates: Partial<MediaMetadata>
  ): Promise<MediaMetadata> {
    const existing = await this.getMetadata(category, filename)
    if (!existing) {
      throw new Error(`Media not found: ${filename}`)
    }

    const updated: MediaMetadata = {
      ...existing,
      ...updates,
      filename, // Preserve filename
      category, // Preserve category
    }

    const metaPath = this.getMetaPath(category, filename)
    await this.fs.writeFile(metaPath, JSON.stringify(updated, null, 2))

    return updated
  }

  /**
   * Delete a media file
   */
  async delete(category: string, filename: string): Promise<void> {
    const path = this.getPath(category, filename)
    const metaPath = this.getMetaPath(category, filename)

    await this.fs.unlink(path)

    try {
      await this.fs.unlink(metaPath)
    } catch {
      // Metadata file might not exist
    }
  }

  /**
   * List media files in a category
   */
  async list(category: string): Promise<string[]> {
    const dirPath = `${this.basePath}/${category}`

    try {
      const files = await this.fs.readdir(dirPath)
      // Filter out metadata files
      return (files as string[]).filter(f => !f.endsWith('.meta.json'))
    } catch (error) {
      if (error instanceof ENOENT) {
        return []
      }
      throw error
    }
  }

  /**
   * List media files with metadata
   */
  async listWithMetadata(category: string): Promise<MediaMetadata[]> {
    const files = await this.list(category)
    const results: MediaMetadata[] = []

    for (const file of files) {
      const meta = await this.getMetadata(category, file)
      if (meta) {
        results.push(meta)
      }
    }

    return results
  }

  /**
   * Move a media file to a different category
   */
  async move(
    fromCategory: string,
    toCategory: string,
    filename: string
  ): Promise<string> {
    const fromPath = this.getPath(fromCategory, filename)
    const toPath = this.getPath(toCategory, filename)
    const fromMetaPath = this.getMetaPath(fromCategory, filename)
    const toMetaPath = this.getMetaPath(toCategory, filename)

    // Move main file
    await this.fs.rename(fromPath, toPath)

    // Move metadata file if it exists
    try {
      await this.fs.rename(fromMetaPath, toMetaPath)

      // Update category in metadata
      const meta = await this.getMetadata(toCategory, filename)
      if (meta) {
        await this.updateMetadata(toCategory, filename, { category: toCategory })
      }
    } catch {
      // Metadata file might not exist
    }

    return toPath
  }

  /**
   * Copy a media file
   */
  async copy(
    category: string,
    filename: string,
    newFilename: string
  ): Promise<string> {
    const sourcePath = this.getPath(category, filename)
    const destPath = this.getPath(category, newFilename)

    await this.fs.copyFile(sourcePath, destPath)

    // Copy and update metadata
    const meta = await this.getMetadata(category, filename)
    if (meta) {
      await this.fs.writeFile(
        this.getMetaPath(category, newFilename),
        JSON.stringify({ ...meta, filename: newFilename, uploadedAt: Date.now() }, null, 2)
      )
    }

    return destPath
  }

  /**
   * Get total storage used by category
   */
  async getStorageUsed(category: string): Promise<number> {
    const files = await this.listWithMetadata(category)
    return files.reduce((total, file) => total + file.size, 0)
  }

  /**
   * Get total storage used across all categories
   */
  async getTotalStorageUsed(): Promise<number> {
    const categories = ['images', 'documents', 'uploads']
    let total = 0

    for (const category of categories) {
      total += await this.getStorageUsed(category)
    }

    return total
  }

  /**
   * Generate file path
   */
  private getPath(category: string, filename: string): string {
    return `${this.basePath}/${category}/${filename}`
  }

  /**
   * Generate metadata file path
   */
  private getMetaPath(category: string, filename: string): string {
    return `${this.basePath}/${category}/${filename}.meta.json`
  }

  /**
   * Determine MIME type from filename
   */
  private getMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase()

    const mimeTypes: Record<string, string> = {
      // Images
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',

      // Documents
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

      // Text
      txt: 'text/plain',
      md: 'text/markdown',
      html: 'text/html',
      css: 'text/css',
      js: 'text/javascript',
      json: 'application/json',
      xml: 'application/xml',

      // Archives
      zip: 'application/zip',
      gz: 'application/gzip',
      tar: 'application/x-tar',

      // Audio
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',

      // Video
      mp4: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
    }

    return mimeTypes[ext ?? ''] ?? 'application/octet-stream'
  }
}
