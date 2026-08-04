import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({
    getItem: vi.fn(),
    getItemCached: vi.fn(),
}))

vi.mock('./storage/autoStorage', () => ({
    AutoStorage: class {
        getItem = storage.getItem
        getItemCached = storage.getItemCached
    },
}))
vi.mock('./storage/database.svelte', () => ({
    appVer: 0,
    nodeOnlyVer: 0,
    defaultSdDataFunc: vi.fn(),
    getCurrentCharacter: vi.fn(),
    getDatabase: vi.fn(),
    loadTogglesFromChat: vi.fn(),
    setDatabase: vi.fn(),
}))
vi.mock('./stores.svelte', () => ({
    MobileGUI: { set: vi.fn() },
    botMakerMode: { set: vi.fn() },
    selectedCharID: { subscribe: vi.fn() },
    loadedStore: { set: vi.fn() },
    DBState: { db: { characters: [] } },
    LoadingStatusState: {},
    selIdState: { selId: 0 },
    ReloadGUIPointer: { set: vi.fn() },
    bodyIntercepterStore: { set: vi.fn() },
    loadingOverlayStore: { set: vi.fn() },
    chatDeselected: { set: vi.fn() },
}))
vi.mock('./parser/parser.svelte', () => ({ hasher: vi.fn() }))
vi.mock('./process/modules', () => ({ moduleUpdate: vi.fn() }))
vi.mock('./process/index.svelte', () => ({ doingChat: { set: vi.fn() } }))
vi.mock('./storage/dirtyTargetBridge', () => ({
    DirtyTargetBridge: class {},
}))
vi.mock('./util', () => ({}))
vi.mock('streamsaver', () => ({ default: {} }))
vi.mock('./update', () => ({}))
vi.mock('./plugins/plugins.svelte', () => ({}))
vi.mock('./alert', () => ({}))
vi.mock('./characterCards', () => ({}))
vi.mock('./storage/defaultPrompts', () => ({}))
vi.mock('./storage/risuSave', () => ({}))
vi.mock('./storage/chatStorage', () => ({}))
vi.mock('./storage/chatPersistStage', () => ({}))
vi.mock('./storage/nodeStorage', () => ({}))
vi.mock('./storage/assetSaveRetry', () => ({}))
vi.mock('./platform', () => ({}))
vi.mock('./gui/animation', () => ({}))
vi.mock('./gui/colorscheme', () => ({}))
vi.mock('src/lang', () => ({ language: {} }))
vi.mock('./observer.svelte', () => ({}))
vi.mock('./gui/guisize', () => ({}))
vi.mock('./characters', () => ({}))
vi.mock('./hotkey', () => ({}))
vi.mock('./process/generationState', () => ({}))
vi.mock('./process/chatSendState', () => ({}))
vi.mock('./network/localNetwork', () => ({}))
vi.mock('./network/proxyJobWs', () => ({}))
vi.mock('./plugins/pluginStorageTracking', () => ({}))
vi.mock('./storage/databaseClone', () => ({}))
vi.mock('./storage/writerTakeover', () => ({}))
vi.mock('./storage/databaseSave', () => ({}))
vi.mock('./storage/clientBuildHandshake', () => ({}))
vi.mock('./storage/activeChatDirtyTracker.svelte', () => ({}))
vi.mock('./storage/conflictRebaseBudget', () => ({}))
vi.mock('./storage/databaseDirtyRevisionTracker.svelte', () => ({}))
vi.mock('./requestLog', () => ({}))

const { loadAsset, readImage } = await import('./globalApi.svelte')

describe('cached global asset reads', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    for (const [name, read] of [
        ['readImage', readImage],
        ['loadAsset', loadAsset],
    ] as const) {
        it(`${name} routes bytes through the verified resource cache`, async () => {
            const bytes = new Uint8Array([1, 2, 3])
            storage.getItemCached.mockResolvedValueOnce(bytes)

            await expect(read('assets/example.png')).resolves.toBe(bytes)
            expect(storage.getItemCached).toHaveBeenCalledOnce()
            expect(storage.getItemCached).toHaveBeenCalledWith('assets/example.png')
            expect(storage.getItem).not.toHaveBeenCalled()
        })

        it(`${name} preserves a null result from the cached authoritative read`, async () => {
            storage.getItemCached.mockResolvedValueOnce(null)

            await expect(read('assets/missing.png')).resolves.toBeNull()
            expect(storage.getItemCached).toHaveBeenCalledOnce()
            expect(storage.getItemCached).toHaveBeenCalledWith('assets/missing.png')
            expect(storage.getItem).not.toHaveBeenCalled()
        })
    }
})
