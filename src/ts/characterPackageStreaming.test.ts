import { describe, expect, test, vi } from 'vitest'
import * as fflate from 'fflate'

vi.mock('./characterCards', () => ({ hubURL: '' }))
vi.mock('./globalApi.svelte', () => ({
    AppendableBuffer: class {
        chunks: Uint8Array[] = []
        append(data: Uint8Array) { this.chunks.push(data) }
        get buffer() {
            const total = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
            const result = new Uint8Array(total)
            let offset = 0
            for (const chunk of this.chunks) {
                result.set(chunk, offset)
                offset += chunk.byteLength
            }
            return result
        }
    },
    saveAsset: vi.fn(),
}))
vi.mock('./alert', () => ({ alertStore: { set: vi.fn() } }))
vi.mock('./parser/parser.svelte', () => ({ hasher: vi.fn() }))
vi.mock('./util', () => ({
    asBuffer: (data: Uint8Array) => data.buffer,
    Semaphore: class {
        async acquire() {}
        release() {}
    },
    sleep: async () => {},
}))

import { CharXWriter, type StreamingByteWriter } from './process/processzip'
import { consumeZipEntries, consumeZipEntry, readZipEntryBytes } from './process/zipStream'
import { encodePackageChatsJson, parsePackageChatsJson } from './storage/streamedJson'

class CollectingWriter implements StreamingByteWriter {
    chunks: Uint8Array[] = []
    closed = false

    write(data: Uint8Array): void {
        this.chunks.push(data.slice())
    }

    close(): void {
        this.closed = true
    }

    bytes(): Uint8Array {
        const total = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
        const result = new Uint8Array(total)
        let offset = 0
        for (const chunk of this.chunks) {
            result.set(chunk, offset)
            offset += chunk.byteLength
        }
        return result
    }
}

const chats = [
    {
        id: 'chat-a',
        name: 'First',
        message: [{ role: 'user', data: 'hello 🌱' }],
        note: '',
        localLore: [],
        fmIndex: -1,
    },
    {
        id: 'chat-b',
        name: 'Second',
        message: [{ role: 'char', data: 'world' }],
        note: 'kept',
        localLore: [],
        fmIndex: 0,
        bindedPersona: 'persona-a',
    },
]
const folders = [{ id: 'folder-a', name: 'Folder', folded: false }]

async function buildStreamedPackage(): Promise<{ bytes: Uint8Array, manifest: Record<string, unknown> }> {
    const sink = new CollectingWriter()
    const writer = new CharXWriter(sink)
    const nestedCharx = new Uint8Array([80, 75, 3, 4, 9, 8, 7, 6])
    const manifest = {
        type: 'risuCharacterPackage',
        version: 1,
        createdAt: '2026-08-03T00:00:00.000Z',
        character: { name: 'Fixture', file: 'character/Fixture.charx' },
        chats: { count: chats.length, file: 'chats/chats.json' },
    }

    await writer.writeEntry('character/Fixture.charx', async entry => {
        await entry.write(nestedCharx.subarray(0, 3))
        await entry.write(nestedCharx.subarray(3))
    })
    await writer.writeIterable('chats/chats.json', encodePackageChatsJson(chats, folders), 6)
    await writer.write('manifest.json', JSON.stringify(manifest, null, 2), 6)
    await writer.end()
    expect(sink.closed).toBe(true)
    return { bytes: sink.bytes(), manifest }
}

describe('streamed character-package interchange', () => {
    test('exported entries round-trip through the streaming import path', async () => {
        const { bytes, manifest } = await buildStreamedPackage()
        expect(Object.keys(fflate.unzipSync(bytes))).toEqual([
            'character/Fixture.charx',
            'chats/chats.json',
            'manifest.json',
        ])
        expect(new TextDecoder().decode(fflate.unzipSync(bytes)['manifest.json']))
            .toBe(JSON.stringify(manifest, null, 2))
        expect(new TextDecoder().decode(fflate.unzipSync(bytes)['chats/chats.json']))
            .toBe(JSON.stringify({ type: 'risuAllChats', ver: 2, data: chats, folders }, null, 2))
        const streamedNames: string[] = []
        const stats = await consumeZipEntries(bytes, new Set([
            'character/Fixture.charx',
            'chats/chats.json',
            'manifest.json',
        ]), async (name, stream) => {
            streamedNames.push(name)
            await readStream(stream)
        })
        expect({ streamedNames, stats }).toMatchObject({
            streamedNames: ['character/Fixture.charx', 'chats/chats.json', 'manifest.json'],
            stats: { entriesStarted: 3, entriesCompleted: 3, maxActiveEntries: 1 },
        })

        const manifestBytes = await readZipEntryBytes(bytes, 'manifest.json')
        expect(manifestBytes).not.toBeNull()
        expect(JSON.parse(new TextDecoder().decode(manifestBytes!))).toEqual(manifest)
        expect(await readZipEntryBytes(bytes, 'character/Fixture.charx'))
            .toEqual(new Uint8Array([80, 75, 3, 4, 9, 8, 7, 6]))

        const imported: unknown[] = []
        let parsedFolders: unknown[] | undefined
        expect(await consumeZipEntry(bytes, 'chats/chats.json', async stream => {
            const metadata = await parsePackageChatsJson(stream, chat => {
                imported.push(chat)
            })
            parsedFolders = metadata.folders
        })).toBe(true)
        expect(imported).toEqual(chats)
        expect(parsedFolders).toEqual(folders)
    })

    test('imports the byte-exact old whole-entry archive shape', async () => {
        const oldChatsJson = JSON.stringify({
            type: 'risuAllChats',
            ver: 2,
            data: chats,
            folders,
        }, null, 2)
        const oldManifest = JSON.stringify({
            type: 'risuCharacterPackage',
            version: 1,
            createdAt: '2025-01-02T03:04:05.000Z',
            character: { name: 'Old', file: '', isEmpty: true },
            chats: { count: chats.length, file: 'chats/chats.json' },
        }, null, 2)
        // This is the pre-C8 producer shape: each complete entry is supplied to
        // one synchronous zipSync call and manifest.json is physically last.
        const oldArchive = fflate.zipSync({
            'chats/chats.json': [fflate.strToU8(oldChatsJson), { level: 6 }],
            'manifest.json': [fflate.strToU8(oldManifest), { level: 6 }],
        })

        const oldSource = new Blob([oldArchive as unknown as BlobPart])
        expect(new TextDecoder().decode((await readZipEntryBytes(oldSource, 'manifest.json'))!))
            .toBe(oldManifest)
        const imported: unknown[] = []
        await consumeZipEntry(oldSource, 'chats/chats.json', async stream => {
            const metadata = await parsePackageChatsJson(stream, chat => {
                imported.push(chat)
            })
            expect(metadata.folders).toEqual(folders)
        })
        expect(imported).toEqual(chats)
    })

    test('hands encoded chunks off before requesting the next source chunk', async () => {
        let sinkWrites = 0
        let activeWrites = 0
        let maxActiveWrites = 0
        const sink: StreamingByteWriter = {
            async write() {
                activeWrites++
                maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
                sinkWrites++
                await Promise.resolve()
                activeWrites--
            },
            close() {},
        }
        const writer = new CharXWriter(sink)

        async function* source() {
            let previousWrites = sinkWrites
            for (let index = 0; index < 4; index++) {
                if (index > 0) {
                    expect(sinkWrites).toBeGreaterThan(previousWrites)
                    previousWrites = sinkWrites
                }
                yield new Uint8Array(256 * 1024).fill(index)
            }
        }

        await writer.writeIterable('bounded.bin', source(), 0)
        await writer.end()
        expect(sinkWrites).toBeGreaterThan(4)
        expect(maxActiveWrites).toBe(1)
    })
})

async function readStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader()
    while (!(await reader.read()).done) {
        // Drain the selected physical entry.
    }
}
