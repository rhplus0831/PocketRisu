import { describe, expect, test, vi } from 'vitest'
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

    let etag = '10000000000000000000000000000001'
    let conflictNextPatch = false
    let candidateData = new Uint8Array()
    const readDatabaseCandidate = vi.fn(async () => ({
      data: candidateData,
      etag: '20000000000000000000000000000002',
    }))
    const patchItem = vi.fn(async () => {
      if (conflictNextPatch) {
        conflictNextPatch = false
        return { success: false, conflict: true }
      }
      return { success: true, etag }
    })
    forageStorage.realStorage = {
      _lastDbEtag: etag,
      patchItem,
      setItem: vi.fn(async () => undefined),
      readDatabaseCandidate,
      setDbEtag(nextEtag: string | null) {
        etag = nextEtag ?? etag
        this._lastDbEtag = nextEtag
      },
    } as any

    const largeRootPayload = 'r'.repeat(4 * 1024 * 1024)
    setDatabase({
      username: 'initial-server-user',
      largeRootPayload,
      characters: Array.from({ length: 4 }, (_, index) => ({
        name: `Budget Character ${index}`,
        chaId: `budget-character-${index}`,
        desc: `initial-${index}-${'c'.repeat(1024 * 1024)}`,
        firstMessage: 'Hello',
        chats: [],
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

    let saveLoopFailure: unknown = null
    void saveDb().catch(error => { saveLoopFailure = error })
    await waitForCommittedSave(requestImmediateSave, { forceFullWrite: true })

    const remote = cloneDatabaseState(getDatabase())
    remote.username = 'concurrent-server-user'
    candidateData = encodeRisuSaveLegacy(remote)

    const localCharacter = getDatabase().characters[0]
    localCharacter.desc = `local-conflict-edit-${'l'.repeat(1024 * 1024)}`
    markCharacterDirty(localCharacter.chaId)

    const samples: ConflictRebaseGraphBudgetSample[] = []
    setConflictRebaseGraphBudgetHookForTests(sample => samples.push(sample))
    conflictNextPatch = true
    try {
      await waitForCommittedSave(requestImmediateSave)
    } finally {
      setConflictRebaseGraphBudgetHookForTests(null)
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
    expect(saveLoopFailure).toBeNull()
  })
})
