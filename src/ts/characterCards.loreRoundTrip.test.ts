import { Buffer } from 'buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    alertError: vi.fn(),
    downloadFile: vi.fn<(name: string, data: Uint8Array) => Promise<void>>(async () => undefined),
    readImage: vi.fn<(id: string) => Promise<Uint8Array>>(),
    saveAsset: vi.fn<(data: Uint8Array) => Promise<string>>(async () => 'assets/imported.png'),
    database: {
        characters: [] as any[],
        statics: { imports: 0 },
        account: { useSync: false },
    },
}))

vi.mock('./alert', () => ({
    alertCardExport: vi.fn(),
    alertConfirm: vi.fn(async () => true),
    alertError: mocks.alertError,
    alertInput: vi.fn(),
    alertStore: { set: vi.fn() },
    alertTOS: vi.fn(),
    alertWait: vi.fn(),
    notifyError: vi.fn(),
    notifySuccess: vi.fn(),
}))
vi.mock('./storage/database.svelte', () => ({
    appVer: 0,
    defaultSdDataFunc: vi.fn(() => []),
    getCharacterSnapshot: vi.fn(),
    getDatabase: vi.fn(() => mocks.database),
    importPreset: vi.fn(),
    newChatModelDefaults: vi.fn(() => ({})),
    setDatabase: vi.fn(),
    setDatabaseLite: vi.fn(),
}))
vi.mock('./util', () => ({
    checkNullish: (value: unknown) => value === null || value === undefined,
    decryptBuffer: vi.fn(),
    isKnownUri: vi.fn(() => false),
    selectFileByDom: vi.fn(),
    sleep: vi.fn(async () => undefined),
}))
vi.mock('src/lang', () => ({
    language: {
        errors: { noData: 'No data' },
        importedCharacter: 'Imported character',
        successExport: 'Exported character',
    },
}))
vi.mock('./characters', () => ({ characterFormatUpdate: vi.fn() }))
vi.mock('./globalApi.svelte', () => {
    class AppendableBuffer {
        private data = new Uint8Array()
        deapended = 0

        append(next: Uint8Array) {
            const combined = new Uint8Array(this.data.length + next.length)
            combined.set(this.data)
            combined.set(next, this.data.length)
            this.data = combined
        }

        length() {
            return this.deapended + this.data.length
        }

        slice(start: number, end: number) {
            return this.data.slice(start - this.deapended, end - this.deapended)
        }

        deappend(length: number) {
            this.data = this.data.slice(length)
            this.deapended += length
        }

        get buffer() {
            return this.data
        }
    }

    class BlankWriter {
        async init() {}
        async write() {}
        async end() {}
    }

    class LocalWriter {
        async init() {}
    }

    class VirtualWriter {}

    return {
        AppendableBuffer,
        BlankWriter,
        LocalWriter,
        VirtualWriter,
        checkCharOrder: vi.fn(),
        downloadFile: mocks.downloadFile,
        forageStorage: {},
        loadAsset: vi.fn(),
        readImage: mocks.readImage,
        saveAsset: mocks.saveAsset,
    }
})
vi.mock('./media', () => ({
    compressImage: vi.fn(async (data: Uint8Array) => data),
    getImageType: vi.fn(() => 'PNG'),
}))
vi.mock('./stores.svelte', () => ({ selectedCharID: { set: vi.fn() } }))
vi.mock('./routing', () => ({ openSettings: vi.fn(), SettingsRoute: {} }))
vi.mock('./parser/parser.svelte', () => ({ hasher: vi.fn() }))
vi.mock('./process/files/inlays', () => ({
    reencodeImage: vi.fn(async (data: Uint8Array) => data),
}))
vi.mock('./process/processzip', () => ({
    CharXImporter: class {},
    CharXSkippableChecker: vi.fn(),
    CharXWriter: class {},
}))
vi.mock('./process/modules', () => ({
    confirmImportedModuleCapabilities: vi.fn(),
    exportModuleLegacy: vi.fn(),
    readModule: vi.fn(),
}))

const { createBaseV3, exportCharacterCard, importCharacterProcess } = await import('./characterCards')

const MINIMAL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
)

class MemoryWriter {
    private chunks: Uint8Array[] = []

    write(data: Uint8Array) {
        this.chunks.push(data.slice())
    }

    close() {}

    bytes() {
        return Buffer.concat(this.chunks.map((chunk) => Buffer.from(chunk)))
    }
}

function createCharacter() {
    return {
        name: 'Lore semantics',
        image: 'assets/source.png',
        globalLore: [
            {
                key: '/dragons?/iu',
                secondkey: '',
                insertorder: 10,
                comment: 'Regex lore',
                content: 'regex content',
                mode: 'normal',
                alwaysActive: false,
                selective: false,
                extentions: { preserved: 'regex-extension' },
                activationPercent: 75,
                loreCache: null,
                useRegex: true,
            },
            {
                key: 'literal dragon',
                secondkey: '',
                insertorder: 20,
                comment: 'Literal lore',
                content: 'literal content',
                mode: 'normal',
                alwaysActive: false,
                selective: false,
                extentions: { preserved: 'literal-extension' },
                activationPercent: 100,
                loreCache: null,
                useRegex: false,
            },
        ],
        loreExt: {},
        loreSettings: { fullWordMatching: false },
        chats: [],
        chatFolders: [],
        additionalData: {},
    } as any
}

function expectRegexSemantics(entries: Array<{ key: string; useRegex?: boolean }>) {
    expect(entries.map((entry) => ({ key: entry.key, useRegex: entry.useRegex }))).toEqual([
        { key: '/dragons?/iu', useRegex: true },
        { key: 'literal dragon', useRegex: false },
    ])
}

describe('character-card lore regex round trips', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.database.characters.length = 0
        mocks.database.statics.imports = 0
        mocks.readImage.mockResolvedValue(MINIMAL_PNG)
    })

    it('preserves true and false use_regex semantics through CCv2 JSON export and import', async () => {
        await exportCharacterCard(createCharacter(), 'json', { spec: 'v2' })

        expect(mocks.alertError).not.toHaveBeenCalled()
        expect(mocks.downloadFile).toHaveBeenCalledOnce()
        const exportedBytes = mocks.downloadFile.mock.calls[0][1] as Uint8Array
        const exportedCard = JSON.parse(Buffer.from(exportedBytes).toString('utf8'))
        expect(exportedCard.data.character_book.entries.map((entry: any) => entry.use_regex)).toEqual([true, false])

        await importCharacterProcess({ name: 'round-trip.json', data: exportedBytes })

        expect(mocks.database.characters).toHaveLength(1)
        expectRegexSemantics(mocks.database.characters[0].globalLore)
    })

    it('preserves true and false use_regex semantics through CCv2 PNG export and import', async () => {
        const writer = new MemoryWriter()
        await exportCharacterCard(createCharacter(), 'png', { spec: 'v2', writer: writer as any })

        expect(mocks.alertError).not.toHaveBeenCalled()
        const exportedPng = writer.bytes()
        const chunks = (await import('./pngChunk')).PngChunk.read(exportedPng, ['chara'])
        const exportedCard = JSON.parse(Buffer.from(chunks.chara, 'base64').toString('utf8'))
        expect(exportedCard.data.character_book.entries.map((entry: any) => entry.use_regex)).toEqual([true, false])

        await importCharacterProcess({ name: 'round-trip.png', data: exportedPng })

        expect(mocks.database.characters).toHaveLength(1)
        expectRegexSemantics(mocks.database.characters[0].globalLore)
        expect(Array.from(mocks.saveAsset.mock.calls[0][0] as Uint8Array)).toEqual(Array.from(MINIMAL_PNG))
    })

    it('keeps CCv3 lore entries on the shared regex-semantic adapter', () => {
        const card = createBaseV3(createCharacter())

        expect(card.data.character_book?.entries.map((entry) => entry.use_regex)).toEqual([true, false])
    })
})
