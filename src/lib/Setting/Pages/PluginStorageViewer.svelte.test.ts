import { mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, test, vi } from 'vitest'

const viewerPage = vi.hoisted(() => vi.fn())
const atomicBatch = vi.hoisted(() => vi.fn())
const rewriteItem = vi.hoisted(() => vi.fn())
const clearStorage = vi.hoisted(() => vi.fn())
const confirmMutation = vi.hoisted(() => vi.fn(async () => false))
const mutationError = vi.hoisted(() => vi.fn())
const mutationSuccess = vi.hoisted(() => vi.fn())
const localValues = vi.hoisted(() => new Map<string, string>())
const localSetItem = vi.hoisted(() => vi.fn((key: string, value: string) => {
    localValues.set(key, value)
}))

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
        pluginStorageTotalSize: (size: string) => `Total size: ${size}`,
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
        pluginStorageViewerStale: 'Storage changed; reloaded.',
        pluginStorageViewerOutcomeUnknown: 'Storage may have changed; reloaded.',
        pluginStorageViewerReadOnly: 'This value cannot be edited safely.',
    },
}))

vi.mock('src/ts/alert', () => ({
    alertConfirm: confirmMutation,
    notifyError: mutationError,
    notifySuccess: mutationSuccess,
}))

vi.mock('src/ts/plugins/pluginSaveStorage', () => ({
    atomicBatchOwnedPluginSaveStorage: atomicBatch,
    clearOwnedPluginSaveStorage: clearStorage,
    getPluginSaveStorageViewerPage: viewerPage,
    rewriteOwnedPluginSaveStorageItem: rewriteItem,
}))

vi.mock('src/ts/plugins/pluginStorageMeta', () => ({
    getOwners: vi.fn(async () => ({})),
    removeOwner: vi.fn(),
}))

vi.mock('src/ts/plugins/pluginSafeClass', () => ({
    SafeLocalStorage: class {
        keys() { return [...localValues.keys()] }
        getItem(key: string) { return localValues.get(key) ?? null }
        setItem(key: string, value: string) { localSetItem(key, value) }
        removeItem(key: string) { localValues.delete(key) }
    },
    SafeLocalPluginStorage: class {
        async keys() { return [] }
        async getItem() { return null }
        async setItem() {}
        async removeItem() {}
    },
}))

const { default: PluginStorageViewer } = await import('./PluginStorageViewer.svelte')
const { StorageError } = await import('src/ts/storage/storageError')

type ViewerOptions = {
    keyQuery?: string
    signal?: AbortSignal | null
}

type DeferredRequest = {
    options: ViewerOptions
    resolve: (value: ReturnType<typeof pageResult>) => void
}

function pageResult(key: string, extraEntries: Array<Record<string, unknown>> = []) {
    return {
        entries: [{
            key,
            owner: 'Plugin Owner',
            text: `value:${key}`,
            size: key.length,
            type: 'object',
            editor: {
                codec: 'json-v1',
                kind: 'json',
                text: JSON.stringify({ value: key }),
            },
            revision: `sha256:${'d'.repeat(64)}`,
        }, ...extraEntries],
        generation: 'viewer-generation',
        manifestRevision: `sha256:${'a'.repeat(64)}`,
        databaseRevision: 'b'.repeat(32),
        pageToken: `sha256:${'c'.repeat(64)}`,
        page: 0,
        pageSize: 50,
        pageCount: 1,
        total: 1 + extraEntries.length,
        totalBytes: 1536,
        ownerFacets: [{ owner: 'Plugin Owner', count: 1 + extraEntries.length }],
        unknownOwnerCount: 0,
        ownerFacetTotal: 1 + extraEntries.length,
        metrics: {
            manifestParses: 1,
            valueReads: 1,
            sizeValueReads: 1,
            ownerReads: 0,
            maxRowParses: 1,
        },
    }
}

function pageWithEntry(entry: Record<string, unknown>) {
    const result = pageResult(entry.key as string)
    result.entries = [entry as (typeof result.entries)[number]]
    result.total = 1
    result.ownerFacetTotal = 1
    return result
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

function click(element: Element): void {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function buttonWithText(text: string): HTMLButtonElement {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].reverse()
        .find(candidate => candidate.textContent?.trim() === text)
    if (!button) throw new Error(`Missing button: ${text}`)
    return button
}

function openEntry(target: HTMLElement, key: string): void {
    const keyLabel = target.querySelector<HTMLElement>(`span[title="${key}"]`)
    const row = keyLabel?.closest<HTMLElement>('[role="button"]')
    if (!row) throw new Error(`Missing entry row: ${key}`)
    click(row)
}

afterEach(() => {
    viewerPage.mockReset()
    atomicBatch.mockReset()
    rewriteItem.mockReset()
    clearStorage.mockReset()
    confirmMutation.mockReset()
    confirmMutation.mockResolvedValue(false)
    mutationError.mockReset()
    mutationSuccess.mockReset()
    localValues.clear()
    localSetItem.mockClear()
    document.body.replaceChildren()
})

describe('PluginStorageViewer component cancellation', () => {
    test('shows the whole Save File total with byte-aware formatting', async () => {
        viewerPage.mockResolvedValue(pageResult('sized'))
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginStorageViewer, { target })

        await waitFor(() => expect(target.textContent).toContain('Total size: 1.5 KB'))

        await unmount(component)
    })

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

describe('PluginStorageViewer save snapshot mutations', () => {
    test.each([
        {
            label: 'JSON-looking true string',
            entry: {
                key: 'string-true', owner: 'Plugin Owner', text: 'true', size: 4,
                type: 'string',
                editor: { codec: 'json-v1', kind: 'string', text: '"true"' },
            },
            editorText: '"true"',
        },
        {
            label: 'JSON-looking object string',
            entry: {
                key: 'string-object', owner: 'Plugin Owner', text: '{"a":1}', size: 7,
                type: 'string',
                editor: { codec: 'json-v1', kind: 'string', text: '"{\\"a\\":1}"' },
            },
            editorText: '"{\\"a\\":1}"',
        },
        {
            label: 'null',
            entry: {
                key: 'null', owner: 'Plugin Owner', text: '', size: 0, type: 'object',
                editor: { codec: 'json-v1', kind: 'json', text: 'null' },
            },
            editorText: 'null',
        },
        {
            label: 'boolean',
            entry: {
                key: 'boolean', owner: 'Plugin Owner', text: 'true', size: 4, type: 'boolean',
                editor: { codec: 'json-v1', kind: 'json', text: 'true' },
            },
            editorText: 'true',
        },
        {
            label: 'number',
            entry: {
                key: 'number', owner: 'Plugin Owner', text: '42', size: 2, type: 'number',
                editor: { codec: 'json-v1', kind: 'json', text: '42' },
            },
            editorText: '42',
        },
    ])('unchanged $label saves are exact no-ops', async ({ entry, editorText }) => {
        viewerPage.mockResolvedValue(pageWithEntry({
            ...entry,
            revision: `sha256:${'d'.repeat(64)}`,
        }))
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginStorageViewer, { target })
        await waitFor(() => expect(target.textContent).toContain(entry.key))

        openEntry(target, entry.key)
        await waitFor(() => expect(document.body.textContent).toContain('Edit'))
        click(buttonWithText('Edit'))
        await tick()
        expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(editorText)
        click(buttonWithText('Save'))
        await tick()

        expect(rewriteItem).not.toHaveBeenCalled()
        expect(mutationSuccess).not.toHaveBeenCalled()
        await unmount(component)
    })

    test('intentional edits cannot retype a top-level string', async () => {
        viewerPage.mockResolvedValue(pageWithEntry({
            key: 'typed-string', owner: 'Plugin Owner', text: 'true', size: 4,
            type: 'string',
            editor: { codec: 'json-v1', kind: 'string', text: '"true"' },
            revision: `sha256:${'d'.repeat(64)}`,
        }))
        rewriteItem.mockResolvedValue({ committed: true, revisions: [] })
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginStorageViewer, { target })
        await waitFor(() => expect(target.textContent).toContain('typed-string'))

        openEntry(target, 'typed-string')
        await waitFor(() => expect(document.body.textContent).toContain('Edit'))
        click(buttonWithText('Edit'))
        await tick()
        const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!
        textarea.value = 'false'
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
        click(buttonWithText('Save'))

        await waitFor(() => expect(rewriteItem).toHaveBeenCalledOnce())
        expect(rewriteItem).toHaveBeenCalledWith(
            'typed-string',
            'false',
            'Plugin Owner',
            `sha256:${'d'.repeat(64)}`,
        )
        await unmount(component)
    })

    test.each([
        {
            label: 'top-level undefined',
            entry: {
                key: 'undefined', owner: 'Plugin Owner', text: '', size: 0,
                type: 'empty',
                editor: { codec: 'lossless-json-v1', kind: 'readonly', text: null },
            },
        },
        {
            label: 'object with an undefined property',
            entry: {
                key: 'undefined-property', owner: 'Plugin Owner', text: '{"kept":1}', size: 10,
                type: 'object',
                editor: { codec: 'lossless-json-v1', kind: 'readonly', text: null },
            },
        },
        {
            label: 'sparse array',
            entry: {
                key: 'sparse-array', owner: 'Plugin Owner', text: '[null,"kept"]', size: 13,
                type: 'array',
                editor: { codec: 'lossless-json-v1', kind: 'readonly', text: null },
            },
        },
    ])('$label is read-only and refuses editing', async ({ entry }) => {
        viewerPage.mockResolvedValue(pageWithEntry({
            ...entry,
            revision: `sha256:${'d'.repeat(64)}`,
        }))
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginStorageViewer, { target })
        await waitFor(() => expect(target.textContent).toContain(entry.key))

        openEntry(target, entry.key)
        await waitFor(() => {
            expect(document.body.textContent).toContain('This value cannot be edited safely.')
        })
        const edit = buttonWithText('Edit')
        expect(edit.disabled).toBe(true)
        click(edit)
        await tick()
        expect(document.querySelector('textarea')).toBeNull()
        expect(rewriteItem).not.toHaveBeenCalled()

        await unmount(component)
    })

    test('unchanged localStorage JSON-like strings remain byte-exact', async () => {
        const original = '{  "a" : 1  }'
        localValues.set('local-json', original)
        viewerPage.mockResolvedValue(pageResult('unused'))
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginStorageViewer, { target })
        await waitFor(() => expect(target.textContent).toContain('unused'))

        click(buttonWithText('Local'))
        await waitFor(() => expect(target.textContent).toContain('local-json'))
        openEntry(target, 'local-json')
        await waitFor(() => expect(document.body.textContent).toContain('Edit'))
        click(buttonWithText('Edit'))
        await tick()
        expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value)
            .toBe('{\n  "a": 1\n}')
        click(buttonWithText('Save'))
        await tick()

        expect(localSetItem).not.toHaveBeenCalled()
        expect(localValues.get('local-json')).toBe(original)
        await unmount(component)
    })

    test('edit and single delete carry the exact page revision', async () => {
        viewerPage.mockResolvedValue(pageResult('guarded'))
        rewriteItem.mockResolvedValue({
            committed: true,
            generation: 'next-generation',
            revisions: [{ key: 'guarded', revision: `sha256:${'e'.repeat(64)}` }],
        })
        atomicBatch.mockResolvedValue({
            committed: true,
            generation: 'delete-generation',
            revisions: [{ key: 'guarded', revision: null }],
        })
        confirmMutation.mockResolvedValue(true)
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginStorageViewer, { target })
        await waitFor(() => expect(target.textContent).toContain('guarded'))

        openEntry(target, 'guarded')
        await waitFor(() => expect(document.body.textContent).toContain('Edit'))
        click(buttonWithText('Edit'))
        await tick()
        const textarea = document.querySelector<HTMLTextAreaElement>('textarea')
        expect(textarea).not.toBeNull()
        textarea!.value = '{"changed":true}'
        textarea!.dispatchEvent(new Event('input', { bubbles: true }))
        click(buttonWithText('Save'))
        await waitFor(() => expect(rewriteItem).toHaveBeenCalledOnce())
        expect(rewriteItem).toHaveBeenCalledWith(
            'guarded',
            { changed: true },
            'Plugin Owner',
            `sha256:${'d'.repeat(64)}`,
        )
        await waitFor(() => expect(mutationSuccess).toHaveBeenCalledWith('Saved guarded'))

        const removeButton = target.querySelector<HTMLButtonElement>('button[aria-label="Remove"]')
        expect(removeButton).not.toBeNull()
        click(removeButton!)
        await waitFor(() => expect(atomicBatch).toHaveBeenCalledOnce())
        expect(atomicBatch).toHaveBeenCalledWith([{
            type: 'remove',
            key: 'guarded',
            expectedRevision: `sha256:${'d'.repeat(64)}`,
        }], '')

        await unmount(component)
    })

    test('filtered save delete is one all-or-nothing revision batch', async () => {
        viewerPage.mockResolvedValue(pageResult('first', [{
            key: 'second',
            owner: 'Plugin Owner',
            text: 'value:second',
            size: 6,
            type: 'string',
            editor: { codec: 'json-v1', kind: 'string', text: '"value:second"' },
            revision: `sha256:${'e'.repeat(64)}`,
        }]))
        atomicBatch.mockResolvedValue({
            committed: true,
            generation: 'delete-generation',
            revisions: [
                { key: 'first', revision: null },
                { key: 'second', revision: null },
            ],
        })
        confirmMutation.mockResolvedValue(true)
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginStorageViewer, { target })
        await waitFor(() => expect(target.textContent).toContain('second'))

        const valueInput = target.querySelector<HTMLInputElement>(
            'input[placeholder="Search value"]',
        )
        expect(valueInput).not.toBeNull()
        valueInput!.value = 'value:'
        valueInput!.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        click(buttonWithText('Delete 2'))

        await waitFor(() => expect(atomicBatch).toHaveBeenCalledOnce())
        expect(atomicBatch).toHaveBeenCalledWith([
            { type: 'remove', key: 'first', expectedRevision: `sha256:${'d'.repeat(64)}` },
            { type: 'remove', key: 'second', expectedRevision: `sha256:${'e'.repeat(64)}` },
        ], '')
        expect(clearStorage).not.toHaveBeenCalled()

        await unmount(component)
    })

    test.each([
        {
            label: 'conflict',
            failure: { committed: false, conflicts: [{ key: 'guarded', revision: null }] },
            message: 'Storage changed; reloaded.',
        },
        {
            label: 'unknown outcome',
            failure: new StorageError('ambiguous', {
                operation: 'batch',
                commitOutcomeUnknown: true,
                commitOutcome: 'unknown',
            }),
            message: 'Storage may have changed; reloaded.',
        },
    ])('$label never retries or reports success and reconciles by reading', async ({ failure, message }) => {
        viewerPage.mockResolvedValue(pageResult('guarded'))
        if (failure instanceof Error) rewriteItem.mockRejectedValue(failure)
        else rewriteItem.mockResolvedValue(failure)
        const target = document.createElement('div')
        document.body.append(target)
        const component = mount(PluginStorageViewer, { target })
        await waitFor(() => expect(target.textContent).toContain('guarded'))

        openEntry(target, 'guarded')
        await waitFor(() => expect(document.body.textContent).toContain('Edit'))
        click(buttonWithText('Edit'))
        await tick()
        const textarea = document.querySelector<HTMLTextAreaElement>('textarea')
        expect(textarea).not.toBeNull()
        textarea!.value = '{"changed":true}'
        textarea!.dispatchEvent(new Event('input', { bubbles: true }))
        click(buttonWithText('Save'))

        await waitFor(() => expect(mutationError).toHaveBeenCalledWith(message))
        expect(rewriteItem).toHaveBeenCalledOnce()
        expect(mutationSuccess).not.toHaveBeenCalled()
        await waitFor(() => expect(viewerPage).toHaveBeenCalledTimes(2))

        await unmount(component)
    })
})
