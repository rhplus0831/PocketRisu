import { describe, expect, test, vi } from 'vitest'
import { tick } from 'svelte'
import type { ConflictRebaseGraphBudgetSample } from '../../src/ts/storage/conflictRebaseBudget'

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

async function waitForCommittedSave(
  requestImmediateSave: (options?: { forceFullWrite?: boolean }) => Promise<SaveOutcome>,
  options?: { forceFullWrite?: boolean },
): Promise<void> {
  const deadline = Date.now() + 20_000
  let lastOutcome: SaveOutcome | null = null
  while (Date.now() < deadline) {
    lastOutcome = await requestImmediateSave(options)
    if (lastOutcome.status === 'committed') return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Conflict save did not commit: ${String(lastOutcome?.error)}`)
}

describe('conflict rebase graph budget', () => {
  test('keeps a large ETag conflict at three live database graphs instead of six', async () => {
    vi.stubGlobal('__PATCH_SYNC__', true)
    const quietLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const quietWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const {
      forageStorage,
      markCharacterDirty,
      requestImmediateSave,
      saveDb,
    } = await import('../../src/ts/globalApi.svelte')
    const { cloneDatabaseState } = await import('../../src/ts/storage/databaseClone')
    const {
      CONFLICT_REBASE_GRAPH_BOUND,
      CONFLICT_REBASE_PREVIOUS_GRAPH_BOUND,
      setConflictRebaseGraphBudgetHookForTests,
    } = await import('../../src/ts/storage/conflictRebaseBudget')
    const { encodeRisuSaveLegacy } = await import('../../src/ts/storage/risuSave')
    const { getDatabase, setDatabase } = await import('../../src/ts/storage/database.svelte')
    const { selectedCharID } = await import('../../src/ts/stores.svelte')

    let etag = '10000000000000000000000000000001'
    let conflictNextPatch = false
    let candidateData = new Uint8Array()
    let signalConflictStarted = () => {}
    let releaseConflict = () => {}
    const conflictStarted = new Promise<void>(resolve => { signalConflictStarted = resolve })
    const conflictRelease = new Promise<void>(resolve => { releaseConflict = resolve })
    const readDatabaseCandidate = vi.fn(async () => ({
      data: candidateData,
      etag: '20000000000000000000000000000002',
    }))
    const patchItem = vi.fn(async () => {
      if (conflictNextPatch) {
        conflictNextPatch = false
        signalConflictStarted()
        await conflictRelease
        return { success: false, conflict: true }
      }
      return { success: true, etag }
    })
    const saveChatContent = vi.fn(async () => undefined)
    forageStorage.realStorage = {
      _lastDbEtag: etag,
      patchItem,
      setItem: vi.fn(async () => undefined),
      saveChatContent,
      readDatabaseCandidate,
      setDbEtag(nextEtag: string | null) {
        etag = nextEtag ?? etag
        this._lastDbEtag = nextEtag
      },
    } as any

    const largeRootPayload = 'r'.repeat(4 * 1024 * 1024)
    setDatabase({
      username: 'initial-server-user',
      personaPrompt: 'initial-prompt',
      largeRootPayload,
      characters: Array.from({ length: 4 }, (_, index) => ({
        name: `Budget Character ${index}`,
        chaId: `budget-character-${index}`,
        desc: `initial-${index}-${'c'.repeat(1024 * 1024)}`,
        firstMessage: 'Hello',
        chats: index === 3 ? [
          {
            id: 'late-chat',
            name: 'Late chat',
            message: [{ role: 'user', data: 'initial late chat value' }],
            note: '',
            localLore: [],
          },
          {
            id: 'untouched-chat',
            name: 'Untouched local name',
            message: [{ role: 'user', data: 'untouched local body' }],
            note: '',
            localLore: [],
          },
        ] : [],
        chatPage: 0,
        image: '',
        type: 'character',
      })),
      botPresets: [{ id: 'budget-preset', name: 'Budget preset' }],
      modules: [],
      plugins: [],
      optimizePluginMemory: false,
      pluginCustomStorage: {},
    } as any)
    selectedCharID.set(3)

    let saveLoopFailure: unknown = null
    void saveDb().catch(error => { saveLoopFailure = error })
    await waitForCommittedSave(requestImmediateSave, { forceFullWrite: true })

    const remote = cloneDatabaseState(getDatabase())
    remote.username = 'concurrent-server-user'
    remote.characters[2].desc = 'concurrent-server-character-C'
    remote.characters[3].chats[1].name = 'Concurrent server chat name'
    candidateData = encodeRisuSaveLegacy(remote)

    const localCharacter = getDatabase().characters[0]
    localCharacter.desc = `local-conflict-edit-${'l'.repeat(1024 * 1024)}`
    markCharacterDirty(localCharacter.chaId)

    const samples: ConflictRebaseGraphBudgetSample[] = []
    setConflictRebaseGraphBudgetHookForTests(sample => samples.push(sample))
    conflictNextPatch = true
    try {
      const conflictedSave = requestImmediateSave()
      await Promise.race([
        conflictStarted,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('Conflict patch did not start')),
          10_000,
        )),
      ])

      // These proxy mutations land after the save proposal has been captured
      // but before its 409 response is released.
      getDatabase().characters[1].desc = 'late-local-character-B'
      getDatabase().personaPrompt = 'late-local-root-value'
      getDatabase().characters[3].chats[0].message[0].data = 'late-local-chat-value'
      await tick()
      releaseConflict()
      await conflictedSave

      expect(getDatabase().characters[1].desc).toBe('late-local-character-B')
      expect(getDatabase().personaPrompt).toBe('late-local-root-value')
      expect(getDatabase().characters[2].desc).toBe('concurrent-server-character-C')
      expect(getDatabase().characters[3].chats[0].message[0].data).toBe('late-local-chat-value')
      expect(getDatabase().characters[3].chats[1].name).toBe('Concurrent server chat name')
      await waitForCommittedSave(requestImmediateSave)
    } finally {
      releaseConflict()
      setConflictRebaseGraphBudgetHookForTests(null)
      selectedCharID.set(-1)
      quietLog.mockRestore()
      quietWarn.mockRestore()
      vi.unstubAllGlobals()
    }

    expect(readDatabaseCandidate).toHaveBeenCalledTimes(1)
    expect(samples.map(sample => sample.phase)).toEqual([
      'candidate-decoded',
      'old-codecs-retired',
      'replacement-baseline-ready',
      'authoritative-graph-installed',
    ])
    const peakGraphCount = Math.max(...samples.map(sample => sample.liveGraphs.length))
    expect(CONFLICT_REBASE_PREVIOUS_GRAPH_BOUND).toBe(6)
    expect(CONFLICT_REBASE_GRAPH_BOUND).toBe(3)
    expect(peakGraphCount).toBeLessThanOrEqual(CONFLICT_REBASE_GRAPH_BOUND)
    expect(peakGraphCount).toBeLessThan(CONFLICT_REBASE_PREVIOUS_GRAPH_BOUND)
    expect(getDatabase().username).toBe('concurrent-server-user')
    expect(getDatabase().characters[0].desc).toContain('local-conflict-edit-')
    expect(saveChatContent.mock.calls.some(([chaId, , chatId, chat]) => (
      chaId === 'budget-character-3'
      && chatId === 'late-chat'
      && chat?.message?.[0]?.data === 'late-local-chat-value'
    ))).toBe(true)
    expect(patchItem.mock.calls.some(([, proposal]) => (
      proposal.patch.some((operation: any) => operation.path.startsWith('/characters/1'))
      && proposal.patch.some((operation: any) => operation.path === '/personaPrompt')
    ))).toBe(true)
    expect(saveLoopFailure).toBeNull()
  })
})
