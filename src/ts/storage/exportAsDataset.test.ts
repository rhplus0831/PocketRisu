import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../globalApi.svelte', () => ({
    downloadFileParts: vi.fn(),
}))
vi.mock('../alert', () => ({ notifySuccess: vi.fn() }))
vi.mock('src/lang', () => ({ language: { successExport: 'done' } }))
vi.mock('./database.svelte', () => ({
    getDatabase: vi.fn(() => ({ characters: [] })),
    getCharacterInterchangeSnapshot: vi.fn(),
}))
vi.mock('./interchangeChatStream', () => ({
    streamCharacterChats: vi.fn(),
}))

const { encodeDatasetBlobParts } = await import('./exportAsDataset')

describe('dataset streaming encoder', () => {
    beforeEach(() => vi.clearAllMocks())

    test('is byte-identical to the previous whole-array JSON.stringify output', async () => {
        const rows = [
            {
                name: 'A 🌱',
                description: 'first',
                chats: [
                    { role: 'user', data: 'hello' },
                    { role: 'char', data: 'line 1\nline 2' },
                ],
                lorebook: [{ key: 'seed', content: 'value', alwaysActive: false }],
            },
            {
                name: 'A 🌱',
                description: 'first',
                chats: [],
                lorebook: [{ key: 'seed', content: 'value', alwaysActive: false }],
            },
        ]

        const parts = await encodeDatasetBlobParts(rows)
        const actual = await new Blob(parts).text()
        expect(actual).toBe(JSON.stringify(rows, null, 4))
        // Prefix, one immutable part per row, and suffix are retained; no
        // aggregate JSON string/Uint8Array is created by the encoder.
        expect(parts).toHaveLength(rows.length + 2)
    })

    test('preserves the previous empty dataset bytes', async () => {
        const parts = await encodeDatasetBlobParts([])
        expect(await new Blob(parts).text()).toBe('[]')
    })
})
