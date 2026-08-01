import { describe, expect, test, vi } from 'vitest'

vi.mock('svelte-sonner', () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}))

vi.mock('../../src/ts/process/modules', () => ({
  moduleUpdate: vi.fn(),
  getModules: () => [],
  getModuleAssets: () => [],
  getModuleLorebooks: () => [],
  getModuleTriggers: () => [],
  getModuleRegexScripts: () => [],
  getModuleToggles: () => [],
  getModuleMcps: () => [],
  exportModuleLegacy: vi.fn(),
  readModule: vi.fn(),
}))

interface SaveOutcome {
  status: string
  error?: unknown
}

type ImmediateSave = (options?: { forceFullWrite?: boolean }) => Promise<SaveOutcome>

async function waitForCommittedSave(
  requestImmediateSave: ImmediateSave,
  options?: { forceFullWrite?: boolean },
): Promise<void> {
  const deadline = Date.now() + 10_000
  let lastOutcome: SaveOutcome | null = null
  while (Date.now() < deadline) {
    lastOutcome = await requestImmediateSave(options)
    if (lastOutcome.status === 'committed') return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Database save loop did not become ready: ${String(lastOutcome?.error)}`)
}

describe('full database fallback assembly', () => {
  test('assembles only after patch rejection or an explicit full write', async () => {
    vi.stubGlobal('__PATCH_SYNC__', true)
    const quietLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    let fullSaveAssembly: ReturnType<typeof vi.spyOn> | null = null

    try {
      const {
        forageStorage,
        markCharacterDirty,
        requestImmediateSave,
        saveDb,
      } = await import('../../src/ts/globalApi.svelte')
      const { RisuSaveEncoder } = await import('../../src/ts/storage/risuSave')
      const { getDatabase, setDatabase } = await import('../../src/ts/storage/database.svelte')

      let etag = '00000000000000000000000000000001'
      const patchItem = vi.fn(async () => ({ success: true, etag }))
      const setItem = vi.fn(async () => undefined)
      const storage = {
        _lastDbEtag: etag,
        patchItem,
        setItem,
        setDbEtag(nextEtag: string | null) {
          etag = nextEtag ?? etag
          this._lastDbEtag = nextEtag
        },
      }
      forageStorage.realStorage = storage as any

      setDatabase({
        characters: [{
          name: 'Assembly Test',
          chaId: 'assembly-test-character',
          desc: 'initial',
          firstMessage: 'Hello',
          chats: [],
          chatPage: 0,
          image: '',
          type: 'character',
        }],
        botPresets: [],
        modules: [],
        plugins: [],
        optimizePluginMemory: false,
        pluginCustomStorage: {
          largeUnchangedValue: 'x'.repeat(2 * 1024 * 1024),
        },
      } as any)
      fullSaveAssembly = vi.spyOn(RisuSaveEncoder.prototype, 'encode')

      let saveLoopFailure: unknown = null
      void saveDb().catch(error => {
        saveLoopFailure = error
      })
      await waitForCommittedSave(requestImmediateSave, { forceFullWrite: true })
      expect(saveLoopFailure).toBeNull()

      const character = getDatabase().characters[0]

      const patchOnlyEncodeCalls = fullSaveAssembly.mock.calls.length
      const patchOnlyPatchCalls = patchItem.mock.calls.length
      const patchOnlyWriteCalls = setItem.mock.calls.length
      character.desc = `patch-only-${Date.now()}`
      markCharacterDirty(character.chaId)
      await waitForCommittedSave(requestImmediateSave)
      expect(patchItem).toHaveBeenCalledTimes(patchOnlyPatchCalls + 1)
      expect(setItem).toHaveBeenCalledTimes(patchOnlyWriteCalls)
      expect(fullSaveAssembly).toHaveBeenCalledTimes(patchOnlyEncodeCalls)

      const fallbackEncodeCalls = fullSaveAssembly.mock.calls.length
      const fallbackPatchCalls = patchItem.mock.calls.length
      const fallbackWriteCalls = setItem.mock.calls.length
      patchItem.mockResolvedValueOnce({ success: false })
      character.desc = `patch-fallback-${Date.now()}`
      markCharacterDirty(character.chaId)
      await waitForCommittedSave(requestImmediateSave)
      expect(patchItem).toHaveBeenCalledTimes(fallbackPatchCalls + 1)
      expect(setItem).toHaveBeenCalledTimes(fallbackWriteCalls + 1)
      expect(fullSaveAssembly).toHaveBeenCalledTimes(fallbackEncodeCalls + 1)

      const forcedEncodeCalls = fullSaveAssembly.mock.calls.length
      const forcedPatchCalls = patchItem.mock.calls.length
      const forcedWriteCalls = setItem.mock.calls.length
      await waitForCommittedSave(requestImmediateSave, { forceFullWrite: true })
      expect(patchItem).toHaveBeenCalledTimes(forcedPatchCalls)
      expect(setItem).toHaveBeenCalledTimes(forcedWriteCalls + 1)
      expect(fullSaveAssembly).toHaveBeenCalledTimes(forcedEncodeCalls + 1)
      expect(saveLoopFailure).toBeNull()
    } finally {
      fullSaveAssembly?.mockRestore()
      quietLog.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
