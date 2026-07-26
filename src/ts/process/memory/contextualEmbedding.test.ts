import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  db: { voyageApiKey: 'voyage-key' },
  globalFetch: vi.fn(),
}))

vi.mock('src/ts/globalApi.svelte', () => ({
  globalFetch: mocks.globalFetch,
}))

vi.mock('src/ts/storage/database.svelte', () => ({
  getDatabase: () => mocks.db,
}))

vi.mock('./hypamemory', () => ({
  contextHash: (texts: string[]) => `hash-${texts.join('-')}`,
}))

import { getContextProvider, isContextModel } from './contextualEmbedding'

describe('Voyage contextual embedding providers', () => {
  beforeEach(() => {
    mocks.db.voyageApiKey = 'voyage-key'
    mocks.globalFetch.mockReset()
  })

  it('recognizes Context 3 and Context 4 without treating other models as contextual', () => {
    expect(isContextModel('voyageContext3')).toBe(true)
    expect(isContextModel('voyageContext4')).toBe(true)
    expect(isContextModel('openai3small')).toBe(false)
  })

  it('sends grouped documents to voyage-context-4', async () => {
    mocks.globalFetch.mockResolvedValue({
      ok: true,
      data: {
        data: [
          { data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] },
        ],
      },
    })

    const provider = getContextProvider('voyageContext4')
    const result = await provider.embedDocumentGroups([['first', 'second']])

    expect(provider.modelId).toBe('voyage-context-4')
    expect(result).toEqual([[[1, 0], [0, 1]]])
    expect(mocks.globalFetch).toHaveBeenCalledWith(
      'https://api.voyageai.com/v1/contextualizedembeddings',
      {
        headers: {
          Authorization: 'Bearer voyage-key',
          'Content-Type': 'application/json',
        },
        body: {
          model: 'voyage-context-4',
          inputs: [['first', 'second']],
          input_type: 'document',
        },
      }
    )
  })

  it('sends queries as independent groups and keeps Context 4 cache keys isolated', async () => {
    mocks.globalFetch.mockResolvedValue({
      ok: true,
      data: {
        data: [
          { data: [{ embedding: [1, 2] }] },
          { data: [{ embedding: [3, 4] }] },
        ],
      },
    })

    const provider = getContextProvider('voyageContext4')
    const result = await provider.embedQueries(['first query', 'second query'])

    expect(result).toEqual([[1, 2], [3, 4]])
    expect(mocks.globalFetch.mock.calls[0][1].body).toEqual({
      inputs: [['first query'], ['second query']],
      model: 'voyage-context-4',
      input_type: 'query',
    })
    expect(provider.getCacheKeySuffix(['first', 'second'])).toBe(
      '|voyageContext4|ctx:hash-first-second'
    )
    expect(provider.getCacheKeySuffix(['only one'])).toBe('|voyageContext4')
  })

  it('keeps the existing Context 3 model and cache identity', () => {
    const provider = getContextProvider('voyageContext3')

    expect(provider.modelId).toBe('voyage-context-3')
    expect(provider.getCacheKeySuffix(['first', 'second'])).toBe(
      '|voyageContext3|ctx:hash-first-second'
    )
  })

  it('names Context 4 in the missing-key error', async () => {
    mocks.db.voyageApiKey = '  '

    await expect(
      getContextProvider('voyageContext4').embedQueries(['query'])
    ).rejects.toThrow('Voyage Context 4 requires a Voyage API Key')
  })
})
