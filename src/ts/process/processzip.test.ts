import { beforeEach, describe, expect, test, vi } from 'vitest'
import * as fflate from 'fflate'

const mocks = vi.hoisted(() => ({
    saveAsset: vi.fn<(data:Uint8Array) => Promise<string>>(),
}))

vi.mock('../characterCards', () => ({ hubURL: '' }))
vi.mock('../globalApi.svelte', () => ({
    AppendableBuffer: class {
        chunks:Uint8Array[] = []

        append(data:Uint8Array) {
            this.chunks.push(data)
        }

        get buffer() {
            const size = this.chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
            const combined = new Uint8Array(size)
            let offset = 0
            for(const chunk of this.chunks){
                combined.set(chunk, offset)
                offset += chunk.byteLength
            }
            return combined
        }
    },
    saveAsset: mocks.saveAsset,
}))
vi.mock('../alert', () => ({ alertStore: { set: vi.fn() } }))
vi.mock('../parser/parser.svelte', () => ({ hasher: vi.fn() }))
vi.mock('../util', () => ({
    asBuffer: (data:Uint8Array) => data.buffer,
    Semaphore: class {
        async acquire() {}
        release() {}
    },
    sleep: async () => {},
}))

import { CharXImporter } from './processzip'
import { consumeZipEntry } from './zipStream'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function cardJson(assetPaths:string[]):Uint8Array {
    return encoder.encode(JSON.stringify({
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            name: 'Asset fixture',
            assets: assetPaths.map((path, index) => ({
                type: 'x-risu-asset',
                uri: `embeded://${path}`,
                name: `asset-${index}`,
                ext: path.split('.').pop() || 'unknown',
            })),
        },
    }))
}

async function importCharX(source:Uint8Array|ReadableStream<Uint8Array>):Promise<CharXImporter> {
    const importer = new CharXImporter()
    await importer.parse(source)
    await importer.done()
    return importer
}

describe('CharX asset classification', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.saveAsset.mockImplementation(async data => `saved:${decoder.decode(data)}`)
    })

    test('direct import keeps referenced JSON and non-media members as assets', async () => {
        const jsonPath = 'assets/x-risu-asset/code/settings.json'
        const scriptPath = 'assets/x-risu-asset/code/bootstrap.lua'
        const escapingPath = 'x_meta/../settings-copy.json'
        const archive = fflate.zipSync({
            [jsonPath]: encoder.encode('{"theme":"dark"}'),
            [scriptPath]: encoder.encode('return { enabled = true }'),
            [escapingPath]: encoder.encode('{"type":"PNG"}'),
            './x_meta/preview.json': encoder.encode('{"type":"PNG"}'),
            'card.json': cardJson([jsonPath, scriptPath]),
        })

        const importer = await importCharX(archive)

        expect(importer.assets).toEqual({
            [jsonPath]: 'saved:{"theme":"dark"}',
            [scriptPath]: 'saved:return { enabled = true }',
            [escapingPath]: 'saved:{"type":"PNG"}',
        })
        expect(mocks.saveAsset).toHaveBeenCalledTimes(3)
        expect(importer.assets).not.toHaveProperty('./x_meta/preview.json')
    })

    test('nested character-package import keeps JSON and non-media CharX assets', async () => {
        const jsonPath = 'assets/x-risu-asset/data/palette.json'
        const textPath = 'assets/x-risu-asset/data/license.txt'
        const escapingPath = 'x_meta/../license-copy.json'
        const charx = fflate.zipSync({
            [jsonPath]: encoder.encode('["red","green"]'),
            [textPath]: encoder.encode('redistribution permitted'),
            [escapingPath]: encoder.encode('{"source":"package"}'),
            './x_meta/palette.json': encoder.encode('{"type":"Unknown"}'),
            'card.json': cardJson([jsonPath, textPath]),
        })
        const packageBytes = fflate.zipSync({
            'character/Asset fixture.charx': charx,
            'manifest.json': encoder.encode(JSON.stringify({
                type: 'risuCharacterPackage',
                version: 1,
                character: { name: 'Asset fixture', file: 'character/Asset fixture.charx' },
            })),
        })

        let importer:CharXImporter|undefined
        const found = await consumeZipEntry(
            packageBytes,
            'character/Asset fixture.charx',
            async stream => {
                importer = await importCharX(stream)
            },
        )

        expect(found).toBe(true)
        expect(importer?.assets).toEqual({
            [jsonPath]: 'saved:["red","green"]',
            [textPath]: 'saved:redistribution permitted',
            [escapingPath]: 'saved:{"source":"package"}',
        })
        expect(mocks.saveAsset).toHaveBeenCalledTimes(3)
    })

    test('a normalized-equivalent card reference overrides x_meta metadata classification', async () => {
        const rawPath = './x_meta/referenced.json'
        const referencedPath = 'x_meta/referenced.json'
        const archive = fflate.zipSync({
            [rawPath]: encoder.encode('{"payload":42}'),
            'x_meta/exporter.json': encoder.encode('{"type":"PNG"}'),
            'card.json': cardJson([referencedPath]),
        })

        const importer = await importCharX(archive)

        expect(importer.assets).toEqual({
            [rawPath]: 'saved:{"payload":42}',
            [referencedPath]: 'saved:{"payload":42}',
        })
        expect(mocks.saveAsset).toHaveBeenCalledOnce()
    })

    test('rejects distinct raw member names with one normalized path', async () => {
        const archive = fflate.zipSync({
            'x_meta/exporter.json': encoder.encode('{"type":"PNG"}'),
            './x_meta/exporter.json': encoder.encode('{"type":"PNG"}'),
            'card.json': cardJson([]),
        })
        const importer = new CharXImporter()

        await importer.parse(archive)

        await expect(importer.done()).rejects.toThrow('Ambiguous CharX member paths normalize')
        expect(mocks.saveAsset).not.toHaveBeenCalled()
    })

    test.each([
        ['x_meta/bad.json', '{"type":3}', 'Invalid CharX metadata member'],
        ['x_meta/readme.txt', 'metadata', 'Unknown CharX metadata member'],
    ])('rejects malformed or unknown unreferenced metadata at %s', async (path, contents, message) => {
        const archive = fflate.zipSync({
            [path]: encoder.encode(contents),
            'card.json': cardJson([]),
        })
        const importer = new CharXImporter()

        await importer.parse(archive)

        await expect(importer.done()).rejects.toThrow(message)
        expect(mocks.saveAsset).not.toHaveBeenCalled()
    })
})
