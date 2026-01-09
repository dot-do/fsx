import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ContentAddressableFS, CASStorage, CASObject, ObjectType } from './content-addressable-fs'
import { sha1 } from './hash'
import { createGitObject } from './git-object'
import { compress, decompress } from './compression'
import { hashToPath } from './path-mapping'

/**
 * Mock storage implementation for testing
 */
class MockCASStorage implements CASStorage {
  public objects: Map<string, Uint8Array> = new Map()

  async write(path: string, data: Uint8Array): Promise<void> {
    this.objects.set(path, data)
  }

  async get(path: string): Promise<{ data: Uint8Array } | null> {
    const data = this.objects.get(path)
    if (!data) return null
    return { data }
  }

  async exists(path: string): Promise<boolean> {
    return this.objects.has(path)
  }

  async delete(path: string): Promise<void> {
    this.objects.delete(path)
  }

  clear(): void {
    this.objects.clear()
  }
}

/**
 * Helper to store a git object directly in mock storage (bypassing CAS)
 * Used for testing getObject
 */
async function storeObjectDirectly(
  storage: MockCASStorage,
  type: string,
  content: Uint8Array
): Promise<string> {
  const gitObject = createGitObject(type, content)
  const compressed = await compress(gitObject)
  const hash = await sha1(gitObject)
  const path = hashToPath(hash)
  await storage.write(path, compressed)
  return hash
}

describe('ContentAddressableFS', () => {
  let storage: MockCASStorage
  let cas: ContentAddressableFS
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  beforeEach(() => {
    storage = new MockCASStorage()
    cas = new ContentAddressableFS(storage)
  })

  describe('constructor', () => {
    it('should create an instance with storage', () => {
      expect(cas).toBeInstanceOf(ContentAddressableFS)
    })
  })

  describe('putObject', () => {
    describe('Basic Storage', () => {
      it('should store a blob and return 40-char SHA-1 hash', async () => {
        const content = encoder.encode('hello')
        const hash = await cas.putObject(content, 'blob')

        expect(hash).toHaveLength(40)
        expect(hash).toMatch(/^[a-f0-9]{40}$/)
      })

      it('should store content at correct path', async () => {
        const content = encoder.encode('test content')
        const hash = await cas.putObject(content, 'blob')

        const expectedPath = hashToPath(hash)
        expect(storage.objects.has(expectedPath)).toBe(true)
      })

      it('should store compressed git object format', async () => {
        const content = encoder.encode('hello')
        const hash = await cas.putObject(content, 'blob')

        const path = hashToPath(hash)
        const storedData = storage.objects.get(path)!

        // Should start with zlib header (0x78)
        expect(storedData[0]).toBe(0x78)

        // Decompress and verify git object format
        const decompressed = await decompress(storedData)
        const nullIndex = decompressed.indexOf(0x00)
        const header = decoder.decode(decompressed.slice(0, nullIndex))
        expect(header).toBe('blob 5')
      })

      it('should store tree object', async () => {
        const treeContent = new Uint8Array([
          ...encoder.encode('100644 file.txt\0'),
          // 20-byte SHA placeholder
          ...new Array(20).fill(0xaa),
        ])
        const hash = await cas.putObject(treeContent, 'tree')

        expect(hash).toHaveLength(40)
        expect(storage.objects.size).toBe(1)
      })

      it('should store commit object', async () => {
        const commitContent = encoder.encode(
          'tree 0000000000000000000000000000000000000000\n' +
            'author Test <test@test.com> 1234567890 +0000\n' +
            'committer Test <test@test.com> 1234567890 +0000\n\n' +
            'Initial commit'
        )
        const hash = await cas.putObject(commitContent, 'commit')

        expect(hash).toHaveLength(40)
        expect(storage.objects.size).toBe(1)
      })

      it('should store tag object', async () => {
        const tagContent = encoder.encode(
          'object 0000000000000000000000000000000000000000\n' +
            'type commit\n' +
            'tag v1.0.0\n' +
            'tagger Test <test@test.com> 1234567890 +0000\n\n' +
            'Release v1.0.0'
        )
        const hash = await cas.putObject(tagContent, 'tag')

        expect(hash).toHaveLength(40)
        expect(storage.objects.size).toBe(1)
      })
    })

    describe('Hash Verification', () => {
      it('should match known git hash for "hello" blob', async () => {
        // echo -n "hello" | git hash-object --stdin
        const content = encoder.encode('hello')
        const hash = await cas.putObject(content, 'blob')

        expect(hash).toBe('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0')
      })

      it('should match known git hash for empty blob', async () => {
        // git hash-object -t blob /dev/null
        const content = new Uint8Array([])
        const hash = await cas.putObject(content, 'blob')

        expect(hash).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
      })

      it('should produce same hash for same content (deterministic)', async () => {
        const content = encoder.encode('test content')

        const hash1 = await cas.putObject(content, 'blob')
        storage.clear()
        const hash2 = await cas.putObject(content, 'blob')

        expect(hash1).toBe(hash2)
      })

      it('should produce different hash for different content', async () => {
        const hash1 = await cas.putObject(encoder.encode('content one'), 'blob')
        const hash2 = await cas.putObject(encoder.encode('content two'), 'blob')

        expect(hash1).not.toBe(hash2)
      })
    })

    describe('Error Handling', () => {
      it('should throw error for invalid type', async () => {
        const content = encoder.encode('test')

        await expect(cas.putObject(content, 'invalid' as ObjectType)).rejects.toThrow()
      })
    })

    describe('Edge Cases', () => {
      it('should handle empty content', async () => {
        const content = new Uint8Array([])
        const hash = await cas.putObject(content, 'blob')

        expect(hash).toHaveLength(40)
      })

      it('should handle binary content with null bytes', async () => {
        const content = new Uint8Array([0x00, 0x00, 0x00, 0xff, 0xfe])
        const hash = await cas.putObject(content, 'blob')

        expect(hash).toHaveLength(40)
      })

      it('should handle large content (1MB)', async () => {
        const size = 1024 * 1024
        const content = new Uint8Array(size)
        for (let i = 0; i < size; i++) {
          content[i] = i % 256
        }

        const hash = await cas.putObject(content, 'blob')
        expect(hash).toHaveLength(40)
      })
    })
  })

  describe('getObject', () => {
    describe('Basic Retrieval', () => {
      it('should retrieve a stored blob object', async () => {
        const content = encoder.encode('hello world')
        const hash = await storeObjectDirectly(storage, 'blob', content)

        const result = await cas.getObject(hash)

        expect(result).not.toBeNull()
        expect(result!.type).toBe('blob')
        expect(result!.data).toEqual(content)
      })

      it('should retrieve a stored tree object', async () => {
        const treeContent = new Uint8Array([
          ...encoder.encode('100644 file.txt\0'),
          ...new Array(20).fill(0xbb),
        ])
        const hash = await storeObjectDirectly(storage, 'tree', treeContent)

        const result = await cas.getObject(hash)

        expect(result).not.toBeNull()
        expect(result!.type).toBe('tree')
        expect(result!.data).toEqual(treeContent)
      })

      it('should retrieve a stored commit object', async () => {
        const commitContent = encoder.encode(
          'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n' +
            'author Test <test@test.com> 1234567890 +0000\n' +
            'committer Test <test@test.com> 1234567890 +0000\n\n' +
            'Test commit'
        )
        const hash = await storeObjectDirectly(storage, 'commit', commitContent)

        const result = await cas.getObject(hash)

        expect(result).not.toBeNull()
        expect(result!.type).toBe('commit')
        expect(result!.data).toEqual(commitContent)
      })

      it('should return null for non-existent object', async () => {
        const nonExistentHash = 'a'.repeat(40)

        const result = await cas.getObject(nonExistentHash)

        expect(result).toBeNull()
      })
    })

    describe('Hash Format Handling', () => {
      it('should accept lowercase SHA-1 hash', async () => {
        const content = encoder.encode('lowercase test')
        const hash = await storeObjectDirectly(storage, 'blob', content)

        const result = await cas.getObject(hash.toLowerCase())

        expect(result).not.toBeNull()
        expect(result!.data).toEqual(content)
      })

      it('should accept uppercase SHA-1 hash', async () => {
        const content = encoder.encode('uppercase test')
        const hash = await storeObjectDirectly(storage, 'blob', content)

        const result = await cas.getObject(hash.toUpperCase())

        expect(result).not.toBeNull()
        expect(result!.data).toEqual(content)
      })

      it('should throw error for invalid hash - wrong length', async () => {
        await expect(cas.getObject('abc123')).rejects.toThrow(/invalid hash/i)
      })

      it('should throw error for invalid hash - non-hex characters', async () => {
        const invalidHash = 'z'.repeat(40)
        await expect(cas.getObject(invalidHash)).rejects.toThrow(/invalid hash/i)
      })

      it('should throw error for empty hash', async () => {
        await expect(cas.getObject('')).rejects.toThrow(/invalid hash/i)
      })
    })

    describe('Edge Cases', () => {
      it('should handle empty content object', async () => {
        const content = new Uint8Array([])
        const hash = await storeObjectDirectly(storage, 'blob', content)

        const result = await cas.getObject(hash)

        expect(result).not.toBeNull()
        expect(result!.type).toBe('blob')
        expect(result!.data.length).toBe(0)
      })

      it('should handle binary content with null bytes', async () => {
        const content = new Uint8Array([0x00, 0x01, 0x00, 0x02, 0xff])
        const hash = await storeObjectDirectly(storage, 'blob', content)

        const result = await cas.getObject(hash)

        expect(result).not.toBeNull()
        expect(result!.data).toEqual(content)
      })
    })
  })

  describe('hasObject', () => {
    describe('Basic Checks', () => {
      it('should return true for existing object', async () => {
        const content = encoder.encode('test')
        const hash = await cas.putObject(content, 'blob')

        const exists = await cas.hasObject(hash)

        expect(exists).toBe(true)
      })

      it('should return false for non-existing object', async () => {
        const nonExistentHash = 'a'.repeat(40)

        const exists = await cas.hasObject(nonExistentHash)

        expect(exists).toBe(false)
      })

      it('should return false for empty storage', async () => {
        const hash = 'b'.repeat(40)

        const exists = await cas.hasObject(hash)

        expect(exists).toBe(false)
      })
    })

    describe('Hash Format Handling', () => {
      it('should accept lowercase SHA-1 hash', async () => {
        const content = encoder.encode('lowercase check')
        const hash = await cas.putObject(content, 'blob')

        const exists = await cas.hasObject(hash.toLowerCase())

        expect(exists).toBe(true)
      })

      it('should accept uppercase SHA-1 hash', async () => {
        const content = encoder.encode('uppercase check')
        const hash = await cas.putObject(content, 'blob')

        const exists = await cas.hasObject(hash.toUpperCase())

        expect(exists).toBe(true)
      })

      it('should accept 64-char SHA-256 hash format', async () => {
        const hash = 'a'.repeat(64)

        // Should not throw for valid format (even if object doesn't exist)
        const exists = await cas.hasObject(hash)
        expect(exists).toBe(false)
      })

      it('should throw error for invalid hash length', async () => {
        await expect(cas.hasObject('abc123')).rejects.toThrow(/invalid hash/i)
      })

      it('should throw error for non-hex characters', async () => {
        const invalidHash = 'g'.repeat(40)
        await expect(cas.hasObject(invalidHash)).rejects.toThrow(/invalid hash/i)
      })
    })
  })

  describe('deleteObject', () => {
    describe('Basic Deletion', () => {
      it('should delete an existing object', async () => {
        const content = encoder.encode('to be deleted')
        const hash = await cas.putObject(content, 'blob')

        expect(await cas.hasObject(hash)).toBe(true)

        await cas.deleteObject(hash)

        expect(await cas.hasObject(hash)).toBe(false)
      })

      it('should not throw when deleting non-existent object', async () => {
        const nonExistentHash = 'a'.repeat(40)

        // Should not throw
        await expect(cas.deleteObject(nonExistentHash)).resolves.toBeUndefined()
      })

      it('should delete from correct path', async () => {
        const content = encoder.encode('delete path test')
        const hash = await cas.putObject(content, 'blob')
        const path = hashToPath(hash)

        expect(storage.objects.has(path)).toBe(true)

        await cas.deleteObject(hash)

        expect(storage.objects.has(path)).toBe(false)
      })
    })

    describe('Hash Format Handling', () => {
      it('should accept lowercase hash', async () => {
        const content = encoder.encode('lowercase delete')
        const hash = await cas.putObject(content, 'blob')

        await cas.deleteObject(hash.toLowerCase())

        expect(await cas.hasObject(hash)).toBe(false)
      })

      it('should accept uppercase hash', async () => {
        const content = encoder.encode('uppercase delete')
        const hash = await cas.putObject(content, 'blob')

        await cas.deleteObject(hash.toUpperCase())

        expect(await cas.hasObject(hash)).toBe(false)
      })

      it('should throw error for invalid hash', async () => {
        await expect(cas.deleteObject('invalid')).rejects.toThrow(/invalid hash/i)
      })
    })
  })

  describe('Round-trip', () => {
    it('should round-trip blob content correctly', async () => {
      const originalContent = encoder.encode('round-trip blob test')

      const hash = await cas.putObject(originalContent, 'blob')
      const result = await cas.getObject(hash)

      expect(result).not.toBeNull()
      expect(result!.type).toBe('blob')
      expect(result!.data).toEqual(originalContent)
    })

    it('should round-trip tree content correctly', async () => {
      const treeContent = new Uint8Array([
        ...encoder.encode('100644 test.txt\0'),
        ...new Array(20).fill(0xcc),
      ])

      const hash = await cas.putObject(treeContent, 'tree')
      const result = await cas.getObject(hash)

      expect(result).not.toBeNull()
      expect(result!.type).toBe('tree')
      expect(result!.data).toEqual(treeContent)
    })

    it('should round-trip commit content correctly', async () => {
      const commitContent = encoder.encode(
        'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n' +
          'parent 0000000000000000000000000000000000000000\n' +
          'author Test <t@t.com> 1000000000 +0000\n' +
          'committer Test <t@t.com> 1000000000 +0000\n\n' +
          'Test commit message\n\nWith multiple lines.'
      )

      const hash = await cas.putObject(commitContent, 'commit')
      const result = await cas.getObject(hash)

      expect(result).not.toBeNull()
      expect(result!.type).toBe('commit')
      expect(result!.data).toEqual(commitContent)
    })

    it('should round-trip tag content correctly', async () => {
      const tagContent = encoder.encode(
        'object 0000000000000000000000000000000000000000\n' +
          'type commit\n' +
          'tag v2.0.0\n' +
          'tagger Developer <dev@example.com> 1600000000 -0700\n\n' +
          'Version 2.0.0 release'
      )

      const hash = await cas.putObject(tagContent, 'tag')
      const result = await cas.getObject(hash)

      expect(result).not.toBeNull()
      expect(result!.type).toBe('tag')
      expect(result!.data).toEqual(tagContent)
    })

    it('should round-trip empty blob correctly', async () => {
      const emptyContent = new Uint8Array([])

      const hash = await cas.putObject(emptyContent, 'blob')
      const result = await cas.getObject(hash)

      expect(result).not.toBeNull()
      expect(result!.type).toBe('blob')
      expect(result!.data.length).toBe(0)
    })

    it('should round-trip binary content with all byte values', async () => {
      const content = new Uint8Array(256)
      for (let i = 0; i < 256; i++) {
        content[i] = i
      }

      const hash = await cas.putObject(content, 'blob')
      const result = await cas.getObject(hash)

      expect(result).not.toBeNull()
      expect(result!.data).toEqual(content)
    })
  })

  describe('Deduplication', () => {
    it('should not create duplicate storage for same content', async () => {
      const content = encoder.encode('duplicate content')

      await cas.putObject(content, 'blob')
      await cas.putObject(content, 'blob')

      // Should only have one object stored
      expect(storage.objects.size).toBe(1)
    })

    it('should return same hash for same content', async () => {
      const content = encoder.encode('same content hash')

      const hash1 = await cas.putObject(content, 'blob')
      const hash2 = await cas.putObject(content, 'blob')

      expect(hash1).toBe(hash2)
    })
  })

  describe('Integration with storage interface', () => {
    it('should call storage.write on putObject', async () => {
      const writeSpy = vi.spyOn(storage, 'write')
      const content = encoder.encode('storage write test')

      await cas.putObject(content, 'blob')

      expect(writeSpy).toHaveBeenCalledTimes(1)
      expect(writeSpy).toHaveBeenCalledWith(expect.stringMatching(/^objects\/[a-f0-9]{2}\/[a-f0-9]{38}$/), expect.any(Uint8Array))
    })

    it('should call storage.get on getObject', async () => {
      const content = encoder.encode('storage get test')
      const hash = await cas.putObject(content, 'blob')
      const getSpy = vi.spyOn(storage, 'get')

      await cas.getObject(hash)

      expect(getSpy).toHaveBeenCalledTimes(1)
      expect(getSpy).toHaveBeenCalledWith(hashToPath(hash))
    })

    it('should call storage.exists on hasObject', async () => {
      const existsSpy = vi.spyOn(storage, 'exists')
      const hash = 'a'.repeat(40)

      await cas.hasObject(hash)

      expect(existsSpy).toHaveBeenCalledTimes(1)
      expect(existsSpy).toHaveBeenCalledWith(hashToPath(hash))
    })

    it('should call storage.delete on deleteObject', async () => {
      const deleteSpy = vi.spyOn(storage, 'delete')
      const hash = 'b'.repeat(40)

      await cas.deleteObject(hash)

      expect(deleteSpy).toHaveBeenCalledTimes(1)
      expect(deleteSpy).toHaveBeenCalledWith(hashToPath(hash))
    })
  })
})
