import { mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, test, vi } from 'vitest'

const viewerPage = vi.hoisted(() => vi.fn())

vi.mock('src/lang', () => ({
    language: {
        cancel: 'Cancel',
        close: 'Close',
        edit: 'Edit',
        remove: 'Remove',
        systemLogsLoading: 'Loading',
        pluginStorageBackendIdb: 'IDB',
        pluginStorageBackendIdbDesc: 'IDB storage',
        pluginStorageBackendLocal: 'Local',
        pluginStorageBackendLocalDesc: 'Local storage',
        pluginStorageBackendSave: 'Save',
        pluginStorageBackendSaveDesc: 'Save storage',
        pluginStorageDesc: 'Plugin storage',
        pluginStorageEmpty: 'Empty',
        pluginStorageFormatJson: 'Format',
        pluginStorageLoadError: 'Load error',
        pluginStorageMetaChars: 'Characters',
        pluginStorageMetaSize: 'Size',
        pluginStorageMetaType: 'Type',
        pluginStorageNextPage: 'Next',
        pluginStorageOwner: 'Owner',
        pluginStorageOwnerUnknown: 'Unknown',
        pluginStoragePreviousPage: 'Previous',
        pluginStorageRefresh: 'Refresh',
        pluginStorageSave: 'Save',
        pluginStorageSearchKey: 'Search key',
        pluginStorageSearchValue: 'Search value',
        pluginStorageBulkDeleteAll: (count: number) => `Clear ${count}`,
        pluginStorageBulkDeleteAllConfirm: () => 'Clear all?',
        pluginStorageBulkDeleteConfirm: () => 'Delete shown?',
        pluginStorageBulkDeleteShown: (count: number) => `Delete ${count}`,
        pluginStorageBulkDeleted: () => 'Deleted',
        pluginStorageDeleteConfirm: () => 'Delete?',
        pluginStorageDeleted: 'Deleted',
        pluginStorageJsonError: (message: string) => message,
        pluginStoragePageCount: (page: number, pages: number, total: number) => (
            `${page}/${pages} (${total})`
        ),
        pluginStorageSaved: (key: string) => `Saved ${key}`,
    },
}))

vi.mock('src/ts/alert', () => ({
    alertConfirm: vi.fn(async () => false),
    notifyError: vi.fn(),
    notifySuccess: vi.fn(),
}))

vi.mock('src/ts/plugins/pluginSaveStorage', () => ({
    clearOwnedPluginSaveStorage: vi.fn(),
    getPluginSaveStorageViewerPage: viewerPage,
    removeOwnedPluginSaveStorageItem: vi.fn(),
    setPluginSaveStorageItem: vi.fn(),
}))

vi.mock('src/ts/plugins/pluginStorageMeta', () => ({
    getOwners: vi.fn(async () => ({})),
    removeOwner: vi.fn(),
}))

vi.mock('src/ts/plugins/pluginSafeClass', () => ({
    SafeLocalStorage: class {
        keys() { return [] }
        getItem() { return null }
        setItem() {}
        removeItem() {}
    },
    SafeLocalPluginStorage: class {
        async keys() { return [] }
        async getItem() { return null }
        async setItem() {}
        async removeItem() {}
    },
}))

const { default: PluginStorageViewer } = await import('./PluginStorageViewer.svelte')

type ViewerOptions = {
    keyQuery?: string
    signal?: AbortSignal | null
}

type DeferredRequest = {
    options: ViewerOptions
    resolve: (value: ReturnType<typeof pageResult>) => void
}

function pageResult(key: string) {
    return {
        entries: [{ key, text: `value:${key}`, size: key.length, type: 'string' }],
        generation: 'viewer-generation',
        manifestRevision: `sha256:${'a'.repeat(64)}`,
        databaseRevision: 'b'.repeat(32),
        pageToken: `sha256:${'c'.repeat(64)}`,
        page: 0,
        pageSize: 50,
        pageCount: 1,
        total: 1,
        ownerFacets: [],
        unknownOwnerCount: 1,
        ownerFacetTotal: 1,
        metrics: {
            manifestParses: 1,
            valueReads: 1,
            ownerReads: 0,
            maxRowParses: 1,
        },
    }
}

async function waitFor(assertion: () => void, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (true) {
        try {
            assertion()
            return
        } catch (error) {
            if (Date.now() >= deadline) throw error
            await tick()
            await new Promise(resolve => setTimeout(resolve, 0))
        }
    }
}

afterEach(() => {
    viewerPage.mockReset()
    document.body.replaceChildren()
})

describe('PluginStorageViewer component cancellation', () => {
    test('changing the key filter while loading aborts the obsolete fetch and rejects its late commit', async () => {
        const requests: DeferredRequest[] = []
        viewerPage.mockImplementation((options: ViewerOptions) => (
            new Promise(resolve => requests.push({ options, resolve }))
        ))
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginStorageViewer, { target })

        await waitFor(() => expect(requests).toHaveLength(1))
        const keyInput = target.querySelector<HTMLInputElement>(
            'input[placeholder="Search key"]',
        )
        expect(keyInput).not.toBeNull()
        keyInput!.value = 'fresh'
        keyInput!.dispatchEvent(new Event('input', { bubbles: true }))

        await waitFor(() => expect(requests).toHaveLength(2))
        expect(requests[1].options.keyQuery).toBe('fresh')
        expect(requests[0].options.signal?.aborted).toBe(true)

        requests[1].resolve(pageResult('fresh-result'))
        await waitFor(() => expect(target.textContent).toContain('fresh-result'))

        // Simulate a transport that resolves despite observing abort. The
        // component identity guard must still reject this obsolete body.
        requests[0].resolve(pageResult('stale-result'))
        await tick()
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(target.textContent).toContain('fresh-result')
        expect(target.textContent).not.toContain('stale-result')

        await unmount(component)
    })
})
