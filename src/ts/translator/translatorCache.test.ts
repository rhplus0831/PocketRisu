import { beforeEach, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({
    Init: vi.fn(async () => undefined),
    keys: vi.fn<(prefix?: string) => Promise<string[]>>(async () => []),
    getItem: vi.fn(async () => null as Uint8Array | null),
    getItems: vi.fn<(keys: string[]) => Promise<{ key: string, value: Uint8Array }[]>>(
        async () => [],
    ),
    setItem: vi.fn(async () => null),
    removeItem: vi.fn(async () => undefined),
}))

vi.mock('../globalApi.svelte', () => ({
    forageStorage: storage,
    globalFetch: vi.fn(),
}))
vi.mock('../parser/chatML', () => ({ parseChatML: vi.fn() }))
vi.mock('../storage/database.svelte', () => ({ getDatabase: vi.fn() }))
vi.mock('./presets', () => ({
    defaultTranslatorPrompt: '',
    getCurrentTranslatorPresetFromState: vi.fn(),
}))
vi.mock('../alert', () => ({ notifyError: vi.fn() }))
vi.mock('../process/request/request', () => ({ requestChatData: vi.fn() }))
vi.mock('../process/index.svelte', () => ({ doingChat: { set: vi.fn() } }))
vi.mock('../parser/parser.svelte', () => ({
    applyMarkdownToNode: vi.fn(),
    hasher: vi.fn(),
}))
vi.mock('../stores.svelte', () => ({ selectedCharID: { subscribe: vi.fn() } }))
vi.mock('../process/modules', () => ({ getModuleRegexScripts: vi.fn() }))
vi.mock('../util', () => ({ getNodetextToSentence: vi.fn(), sleep: vi.fn() }))
vi.mock('../process/scripts', () => ({ processScriptFull: vi.fn() }))
vi.mock('../notificationSound', () => ({ playNotificationSound: vi.fn() }))

const {
    clearLLMCache,
    exportLLMCacheAsJSON,
    searchLLMCache,
    setLLMCache,
} = await import('./translator')

const encoder = new TextEncoder()

function setPersistentRows(rows: Record<string, { key: string, value: string }>) {
    const storageKeys = Object.keys(rows)
    storage.keys.mockResolvedValue(storageKeys)
    storage.getItems.mockImplementation(async (keys: string[]) => keys.flatMap((storageKey) => {
        const row = rows[storageKey]
        return row
            ? [{ key: storageKey, value: encoder.encode(JSON.stringify(row)) }]
            : []
    }))
    return storageKeys
}

describe('LLM translation cache bulk reads', () => {
    beforeEach(async () => {
        storage.keys.mockReset().mockResolvedValue([])
        await clearLLMCache()
        vi.clearAllMocks()
        storage.keys.mockResolvedValue([])
        storage.getItem.mockResolvedValue(null)
        storage.getItems.mockResolvedValue([])
        storage.setItem.mockResolvedValue(null)
        storage.removeItem.mockResolvedValue(undefined)
    })

    it('searches persisted rows in listed order with one bulk read and memory-first deduplication', async () => {
        await setLLMCache('match-memory', 'memory-value')
        await setLLMCache('ignore-memory', 'ignored')
        vi.clearAllMocks()
        const storageKeys = setPersistentRows({
            'cache/llm-translate/duplicate.json': { key: 'match-memory', value: 'stale-value' },
            'cache/llm-translate/first.json': { key: 'match-first', value: 'first-value' },
            'cache/llm-translate/nonmatch.json': { key: 'other', value: 'other-value' },
            'cache/llm-translate/second.json': { key: 'match-second', value: 'second-value' },
        })
        storageKeys.splice(3, 0, 'cache/llm-translate/missing.json')
        storage.keys.mockResolvedValue(storageKeys)

        await expect(searchLLMCache('match')).resolves.toEqual([
            { key: 'match-memory', value: 'memory-value' },
            { key: 'match-first', value: 'first-value' },
            { key: 'match-second', value: 'second-value' },
        ])
        expect(storage.keys).toHaveBeenCalledOnce()
        expect(storage.getItems).toHaveBeenCalledOnce()
        expect(storage.getItems).toHaveBeenCalledWith(storageKeys)
        expect(storage.getItem).not.toHaveBeenCalled()
    })

    it('exports the unchanged object shape with one bulk read and memory values winning', async () => {
        await setLLMCache('duplicate', 'memory-value')
        await setLLMCache('memory-only', 'memory-only-value')
        vi.clearAllMocks()
        const storageKeys = setPersistentRows({
            'cache/llm-translate/duplicate.json': { key: 'duplicate', value: 'stale-value' },
            'cache/llm-translate/persisted.json': { key: 'persisted-only', value: 'persisted-value' },
        })
        storageKeys.push('cache/llm-translate/missing.json')
        storage.keys.mockResolvedValue(storageKeys)

        const result = await exportLLMCacheAsJSON()

        expect(result).toEqual({
            duplicate: 'memory-value',
            'memory-only': 'memory-only-value',
            'persisted-only': 'persisted-value',
        })
        expect(Object.keys(result)).toEqual(['duplicate', 'memory-only', 'persisted-only'])
        expect(storage.keys).toHaveBeenCalledOnce()
        expect(storage.getItems).toHaveBeenCalledOnce()
        expect(storage.getItems).toHaveBeenCalledWith(storageKeys)
        expect(storage.getItem).not.toHaveBeenCalled()
    })
})
