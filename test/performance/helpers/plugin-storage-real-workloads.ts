/**
 * Deterministic, CI-sized projections of the storage traces used by the six
 * large plugins in /home/codex/plugin. The external bundles are analysis
 * inputs, not test fixtures, so this file records their durable key/value and
 * mutation shapes without making the suite depend on a developer-local path.
 *
 * One period represents a sustained user session. Payload/cardinality caps are
 * scaled down from production while preserving the traits that matter to the
 * storage layer: generation replacement, retained session rows, unbounded
 * per-turn rows, and repeated whole-value rewrites.
 */

export const REAL_PLUGIN_WORKLOAD_PERIODS = 40

export const REAL_PLUGIN_NAMES = [
  'Flashback Memory',
  'WygLore Leaf',
  'Provider Manager 1.10.0',
  'Cupcake Provider Manager 1.35.11',
  'Risu Agents',
  'Yumi Translator',
] as const

export type RealPluginName = typeof REAL_PLUGIN_NAMES[number]

export type PluginStorageOperation =
  | {
      kind: 'set'
      plugin: RealPluginName
      key: string
      value: unknown
    }
  | {
      kind: 'remove'
      plugin: RealPluginName
      key: string
    }

export interface PluginStorageWorkloadPeriod {
  period: number
  operations: PluginStorageOperation[]
}

export interface PluginStorageWorkloadSummary {
  sets: number
  removes: number
  distinctKeys: number
}

export interface PluginStorageWorkload {
  periods: PluginStorageWorkloadPeriod[]
  finalValues: Map<string, unknown>
  summaryByPlugin: Record<RealPluginName, PluginStorageWorkloadSummary>
}

const FLASHBACK = REAL_PLUGIN_NAMES[0]
const WYGLORE = REAL_PLUGIN_NAMES[1]
const PROVIDER_110 = REAL_PLUGIN_NAMES[2]
const PROVIDER_135 = REAL_PLUGIN_NAMES[3]
const RISU_AGENTS = REAL_PLUGIN_NAMES[4]
const YUMI = REAL_PLUGIN_NAMES[5]

function patternedText(seed: string, length: number): string {
  const token = `${seed}|한글-memory-0123456789-abcdefghijklmnopqrstuvwxyz|`
  return token.repeat(Math.ceil(length / token.length)).slice(0, length)
}

function vector(seed: number, dimensions = 96): number[] {
  return Array.from({ length: dimensions }, (_, index) => (
    (((seed + 1) * 7919 + index * 104729) % 2_000_001 - 1_000_000) / 1_000_000
  ))
}

function jsonString(value: unknown, pretty = false): string {
  return JSON.stringify(value, null, pretty ? 2 : undefined)
}

function set(
  operations: PluginStorageOperation[],
  plugin: RealPluginName,
  key: string,
  value: unknown,
): void {
  // Match pluginStorage.setItem's invocation-time snapshot. Several plugins
  // retain and mutate their in-memory arrays after awaiting a write.
  operations.push({ kind: 'set', plugin, key, value: structuredClone(value) })
}

function remove(
  operations: PluginStorageOperation[],
  plugin: RealPluginName,
  key: string,
): void {
  operations.push({ kind: 'remove', plugin, key })
}

interface FlashbackScope {
  id: string
  records: Array<Record<string, unknown>>
  previousShards: string[]
  commit: number
}

function addFlashbackPeriod(
  period: number,
  operations: PluginStorageOperation[],
  scopes: FlashbackScope[],
): void {
  if (period === 1 || period % 12 === 0) {
    set(operations, FLASHBACK, 'vector_rag_memory:settings:v2', jsonString({
      version: 2,
      shardSize: 8,
      maxResponseItems: 96,
      chunkChars: 1200,
      overlap: 160,
      episodeBatchTurns: 3,
    }, true))
  }
  if (period === 1) remove(operations, FLASHBACK, 'vector_rag_memory:operation_log:v1')

  const scopeIndex = Math.floor((period - 1) / 10)
  if (!scopes[scopeIndex]) {
    scopes[scopeIndex] = {
      id: `scope-${scopeIndex.toString().padStart(2, '0')}`,
      records: [],
      previousShards: [],
      commit: 0,
    }
  }
  const scope = scopes[scopeIndex]
  scope.records.push({
    version: 2,
    id: `response-${period.toString().padStart(4, '0')}`,
    type: 'response',
    scopeKey: scope.id,
    createdAt: 1_785_168_000_000 + period * 60_000,
    text: patternedText(`flashback-turn-${period}`, period % 10 === 0 ? 1_650 : 900),
    tags: [`turn:${period}`, `scope:${scopeIndex}`],
    anchors: [`anchor-${period % 13}`, `character-${scopeIndex}`],
    vector: vector(period),
  })

  // The real plugin republishes the complete generation on capture, commonly
  // again during worldline reconciliation, and once more for episode rebuilds.
  const publications = 1 + (period % 4 === 0 ? 1 : 0) + (period % 6 === 0 ? 1 : 0)
  for (let publication = 0; publication < publications; publication += 1) {
    scope.commit += 1
    const commitId = `p${period.toString().padStart(3, '0')}-${scope.commit}`
    const prefix = `vector_rag_memory:scope:${scope.id}`
    const nextShards: string[] = []
    const shardSummaries: Array<Record<string, unknown>> = []
    for (let start = 0, shard = 0; start < scope.records.length; start += 8, shard += 1) {
      const key = `${prefix}:records:commit:${commitId}:shard:${shard.toString().padStart(4, '0')}`
      const records = scope.records.slice(start, start + 8)
      nextShards.push(key)
      set(operations, FLASHBACK, key, jsonString({
        version: 2,
        shard,
        scopeKey: scope.id,
        commitId,
        checksum: `checksum-${period}-${publication}-${shard}`,
        records,
      }, true))
      shardSummaries.push({
        shard,
        count: records.length,
        terms: records.flatMap(record => record.tags as string[]).slice(0, 96),
        anchors: records.flatMap(record => record.anchors as string[]).slice(0, 128),
        centroid: vector(period + shard, 32),
      })
    }
    set(operations, FLASHBACK, `${prefix}:manifest:v2`, jsonString({
      version: 2,
      scopeKey: scope.id,
      commitId,
      count: scope.records.length,
      shardCount: nextShards.length,
      shards: shardSummaries,
      episodeDigest: `episode-${Math.floor(period / 3)}`,
      worldlineRevision: period,
    }, true))
    set(operations, FLASHBACK, 'vector_rag_memory:scope_registry:v2', jsonString({
      version: 2,
      scopes: scopes.filter(Boolean).map(item => ({
        scopeKey: item.id,
        updatedAt: period,
        count: item.records.length,
      })).reverse(),
    }, true))
    if (period % 5 === 0 || publication > 0) {
      set(operations, FLASHBACK, `${prefix}:turn_worldline:v1`, jsonString({
        version: 1,
        nodes: scope.records.slice(-24).map((record, index) => ({
          id: record.id,
          parent: index === 0 ? null : scope.records.at(-25 + index)?.id ?? null,
        })),
        retired: period % 10 === 0 ? scope.records.slice(-2) : [],
      }, true))
    }
    for (const oldKey of scope.previousShards) remove(operations, FLASHBACK, oldKey)
    scope.previousShards = nextShards
  }
}

interface WygLoreSession {
  base: string
  buckets: Array<Array<Record<string, unknown>>>
  snapshots: Array<Record<string, unknown>>
  generation: number
}

function addWygLorePeriod(
  period: number,
  operations: PluginStorageOperation[],
  sessions: WygLoreSession[],
): void {
  const sessionIndex = Math.floor((period - 1) / 10)
  let session = sessions[sessionIndex]
  const firstPersist = !session
  if (!session) {
    session = {
      base: `wl.web.v1.${(0xabc00000 + sessionIndex).toString(16)}`,
      buckets: Array.from({ length: 32 }, () => []),
      snapshots: [],
      generation: 0,
    }
    sessions[sessionIndex] = session
  }
  session.generation += 1
  const changedBuckets = new Set<number>()
  for (let unitOffset = 0; unitOffset < 2; unitOffset += 1) {
    const unitId = `unit-${period}-${unitOffset}`
    const bucket = (period * 7 + unitOffset * 13) % 32
    changedBuckets.add(bucket)
    session.buckets[bucket].push({
      id: unitId,
      type: unitOffset === 0 ? 'episodic' : 'entity',
      name: `Memory ${period}/${unitOffset}`,
      content: patternedText(`wyglore-${unitId}`, 760),
      keywords: [`kw-${period % 17}`, `bucket-${bucket}`],
      aliases: [`alias-${unitId}`],
      knownBy: [`character-${sessionIndex}`],
      associations: Array.from({ length: 4 }, (_, index) => ({
        target: `unit-${Math.max(1, period - index)}-0`,
        weight: 0.5 + index / 10,
      })),
      activation: 1,
      createdAt: period,
      sourceChatIds: [`chat-${sessionIndex}`],
      keyExcerpts: [patternedText(`excerpt-${unitId}`, 80)],
      context: patternedText(`context-${unitId}`, 120),
    })
  }
  session.snapshots.push({ id: `snapshot-${period}`, unitCount: session.buckets.flat().length })
  session.snapshots = session.snapshots.slice(-200)

  const bucketIndexes = firstPersist
    ? Array.from({ length: 32 }, (_, index) => index)
    : [...changedBuckets]
  for (const bucket of bucketIndexes) {
    set(
      operations,
      WYGLORE,
      `${session.base}:units:b${bucket}`,
      jsonString(session.buckets[bucket]),
    )
  }
  const unitCount = session.buckets.reduce((total, bucket) => total + bucket.length, 0)
  set(operations, WYGLORE, `${session.base}:meta`, jsonString({
    version: 3,
    narrativeTime: period,
    commitLog: session.snapshots.slice(-64),
    chatFingerprint: `chat-${sessionIndex}`,
    globalEpoch: period,
  }))
  set(operations, WYGLORE, `${session.base}:snapshots`, jsonString(session.snapshots))
  set(operations, WYGLORE, `${session.base}:embeddings`, `wlz1:${patternedText(
    `embedding-${sessionIndex}-${period}`,
    Math.max(1_024, unitCount * 1_024),
  )}`)
  set(operations, WYGLORE, `${session.base}:units:manifest`, jsonString({
    schemaVersion: 1,
    bucketCount: 32,
    generation: session.generation,
    unitCount,
    bucketHash: Object.fromEntries(session.buckets.map((bucket, index) => [index, `h${index}-${bucket.length}`])),
    snapshotsHash: `snapshots-${session.snapshots.length}`,
  }))
  set(operations, WYGLORE, 'wl.globalSettings.v1', jsonString({
    maxUnits: 0,
    maxEmbeddedUnits: 0,
    persistDebounceMs: 5_000,
    updatedAt: period,
  }))
  if (period % 4 === 0) {
    set(operations, WYGLORE, `at.coldstart.${session.base}`, jsonString({
      jobId: `cold-${sessionIndex}`,
      status: 'running',
      nextChunk: period % 10,
      totalChunks: 10,
      processedMsgs: period * 8,
      mergedUnitIds: session.buckets.flat().slice(-8).map(unit => unit.id),
    }))
  }
  set(operations, WYGLORE, `wl.handsum.v1.chat.${sessionIndex}`, jsonString({
    schemaVersion: 1,
    scope: 'chat',
    scopeKey: `chat-${sessionIndex}`,
    slots: Array.from({ length: 5 }, (_, index) => patternedText(`hand-${period}-${index}`, 500)),
  }))
}

interface Provider110State {
  thinking: Array<Record<string, unknown>>
  tools: Array<Record<string, unknown>>
  logs: Array<Record<string, unknown>>
  batches: Array<Record<string, unknown>>
  scopes: string[]
}

function addProvider110Period(
  period: number,
  operations: PluginStorageOperation[],
  state: Provider110State,
): void {
  state.thinking.push({
    id: `thinking-${period}`,
    createdAt: period,
    encoding: 'j',
    payload: patternedText(`thinking-payload-${period}`, 2_400),
  })
  state.thinking = state.thinking.slice(-20)
  state.logs.unshift({
    id: `request-${period}`,
    timestamp: period,
    duration: 100 + period,
    url: 'https://provider.example/v1/chat/completions',
    requestBody: null,
    responseBody: null,
    compressedBody: patternedText(`request-log-${period}`, 2_000),
    status: 200,
    model: `model-${period % 8}`,
  })
  state.logs = state.logs.slice(0, 10)
  if (period % 3 === 0) {
    state.tools.push({
      id: `tool-${period}`,
      createdAt: period,
      encoding: 'j',
      payload: patternedText(`tool-payload-${period}`, 1_800),
    })
    state.tools = state.tools.slice(-20)
  }
  if (period % 5 === 0) {
    state.batches.push({
      id: `batch-${period}`,
      status: 'completed',
      createdAt: period,
      result: patternedText(`batch-result-${period}`, 4_000),
    })
  }
  const scope = `scope-${period % 8}`
  if (!state.scopes.includes(scope)) state.scopes.push(scope)

  set(operations, PROVIDER_110, 'pm_store', {
    version: 4,
    apiKeys: Array.from({ length: 4 }, (_, index) => `test-key-${index}`),
    models: Array.from({ length: 24 }, (_, index) => ({
      id: `model-${index}`,
      provider: `provider-${index % 4}`,
      schema: patternedText(`schema-${index}`, 320),
    })),
    cursor: period % 4,
    known: [],
  })
  set(operations, PROVIDER_110, 'pm_thinking_history_records', jsonString(state.thinking))
  if (state.tools.length > 0) {
    set(operations, PROVIDER_110, 'pm_tool_history_records', jsonString(state.tools))
  }
  set(operations, PROVIDER_110, 'pm_request_logs', jsonString(state.logs))
  set(operations, PROVIDER_110, 'pm_batch_jobs', `gzip:${jsonString(state.batches)}`)
  set(operations, PROVIDER_110, 'pm_gemini_explicit_caches', {
    version: 1,
    caches: state.scopes.flatMap(item => Array.from({ length: 2 }, (_, index) => ({
      id: `${item}-cache-${index}`,
      scope: item,
      state: 'active',
      tokenCount: 4_096 + period,
      preview: patternedText(`${item}-preview-${index}`, 160),
    }))),
    candidates: state.scopes.flatMap(item => Array.from({ length: 8 }, (_, index) => ({
      scope: item,
      prefixHash: patternedText(`${item}-hash-${index}`, 64),
      preview: patternedText(`${item}-candidate-${index}`, 160),
    }))),
    families: [],
    stats: { hits: period, created: state.scopes.length * 2 },
  })
  if (period % 10 === 0) {
    set(operations, PROVIDER_110, 'pm_known', `gzip:${jsonString(Array.from(
      { length: 4 },
      (_, source) => ({ source, fetchedAt: period, data: Array.from({ length: 30 }, (__, model) => ({
        id: `known-${source}-${model}`,
      })) }),
    ))}`)
  }
  if (period === 1 || period % 20 === 0) {
    set(operations, PROVIDER_110, 'pm_update_state', { shownChangelogVersion: `1.${period}` })
  }
  if (period === 1) {
    set(operations, PROVIDER_110, 'pm_batch_test_state', `gzip:${jsonString([{ baselineText: patternedText('batch-baseline', 5_000) }])}`)
  }
  if (period === 8) remove(operations, PROVIDER_110, 'pm_batch_test_state')
}

interface Provider135State {
  records: Array<Record<string, unknown>>
  auxLogs: Array<Record<string, unknown>>
  scopes: string[]
}

function addProvider135Period(
  period: number,
  operations: PluginStorageOperation[],
  state: Provider135State,
): void {
  for (let request = 0; request < 2; request += 1) {
    const record = {
      modelId: `model-${(period + request) % 12}`,
      provider: `provider-${(period + request) % 4}`,
      duration: 250 + period * 3 + request,
      status: 200,
      timestamp: period * 10 + request,
      tokenUsage: { input: 1_000 + period, output: 250, reasoning: request * 50, total: 1_250 + period },
      customPricing: null,
      source: 'main',
    }
    state.records.push(record)
    const chunkIndex = Math.floor((state.records.length - 1) / 20)
    const chunkRecords = state.records.slice(chunkIndex * 20, chunkIndex * 20 + 20)
    set(
      operations,
      PROVIDER_135,
      `cpm_perf_chunk_${(chunkIndex + 1).toString().padStart(6, '0')}`,
      jsonString({ v: 2, id: chunkIndex + 1, start: chunkIndex * 20, records: chunkRecords }),
    )
    set(operations, PROVIDER_135, 'cpm_perf_manifest', jsonString({
      v: 2,
      ts: period,
      totalRecorded: state.records.length,
      chunkSize: 20,
      chunks: Array.from({ length: chunkIndex + 1 }, (_, index) => ({
        id: index + 1,
        key: `cpm_perf_chunk_${(index + 1).toString().padStart(6, '0')}`,
        start: index * 20,
        count: Math.min(20, state.records.length - index * 20),
        sealed: index < chunkIndex,
      })),
    }))
  }

  state.auxLogs.push({
    ts: period,
    reason: `route-${period % 7}`,
    category: 'auxiliary',
    candidates: Array.from({ length: 5 }, (_, index) => `candidate-${period}-${index}`),
    details: patternedText(`aux-${period}`, 1_050),
  })
  state.auxLogs = state.auxLogs.slice(-30)
  set(operations, PROVIDER_135, 'cpm_aux_routing_logs', jsonString(state.auxLogs))

  const scope = `gemini:${period % 8}:model-${period % 4}`
  if (!state.scopes.includes(scope)) state.scopes.push(scope)
  set(operations, PROVIDER_135, 'cpm_gemini_explicit_caches', jsonString({
    version: 1,
    caches: state.scopes.flatMap(item => Array.from({ length: 3 }, (_, index) => ({
      id: `${item}:cache-${index}`,
      scope: item,
      prefixHash: patternedText(`${item}:root-${index}`, 64),
      tokenCount: 8_192,
      state: 'active',
      startPreview: patternedText(`${item}:start-${index}`, 160),
      boundaryPreview: patternedText(`${item}:boundary-${index}`, 160),
    }))),
    candidates: state.scopes.flatMap(item => Array.from({ length: 12 }, (_, index) => ({
      scope: item,
      prefixHash: patternedText(`${item}:candidate-${index}`, 64),
      preview: patternedText(`${item}:preview-${index}`, 160),
    }))),
    families: [],
    stats: { savedTokensTotal: period * 1_000, hitsTotal: period, createdTotal: state.scopes.length * 3 },
  }))
  set(operations, PROVIDER_135, 'cpm_last_boot_status', {
    ts: period,
    version: '1.35.11',
    ok: 12,
    fail: 0,
    timedOut: 0,
    bootDurationMs: 500 + period,
  })
  if (period % 10 === 0) {
    set(operations, PROVIDER_135, 'cpm_last_version_check', String(period))
  }
  if (period % 13 === 0) {
    set(operations, PROVIDER_135, 'cpm_pending_main_update', {
      version: `1.${period}`,
      changes: patternedText(`changes-${period}`, 600),
      attempts: 1,
    })
  }
  if (period % 13 === 1 && period > 1) {
    remove(operations, PROVIDER_135, 'cpm_pending_main_update')
  }
}

interface RisuAgentChat {
  characterId: string
  chatId: string
  snapshots: Array<Record<string, unknown>>
}

function addRisuAgentsPeriod(
  period: number,
  operations: PluginStorageOperation[],
  chats: RisuAgentChat[],
): void {
  if (period === 1 || period % 20 === 0) {
    set(operations, RISU_AGENTS, 'risu_agents_config_vault_v1', {
      version: 1,
      savedAt: period,
      config: {
        provider: 'openai',
        baseUrl: 'https://provider.example/v1',
        apiKey: 'test-only-key',
        model: 'test-model',
        temperature: 0.7,
        maxTokens: 2_000,
        pipeline: patternedText(`pipeline-${period}`, 7_000),
        pipelinePresetStore: patternedText(`pipeline-presets-${period}`, 7_000),
      },
    })
    set(operations, RISU_AGENTS, 'risu_agents_pipeline_presets_v1', {
      version: 1,
      activePresetId: 'default',
      presets: Array.from({ length: 3 }, (_, index) => ({
        id: `preset-${index}`,
        name: `Preset ${index}`,
        pipeline: patternedText(`agent-pipeline-${period}-${index}`, 7_000),
      })),
    })
  }

  const chatIndex = Math.floor((period - 1) / 10)
  if (!chats[chatIndex]) {
    chats[chatIndex] = {
      characterId: `character-${chatIndex.toString().padStart(2, '0')}-00000000-0000-0000`,
      chatId: `chat-${chatIndex.toString().padStart(2, '0')}-00000000-0000-00000000`,
      snapshots: [],
    }
  }
  const chat = chats[chatIndex]
  const base = `risu_agents_memory_v4:${chat.characterId}:${chat.chatId}:agent-plot`
  const messageCount = ((period - 1) % 10 + 1) * 2
  const snapshotKey = `${base}:snapshot:${messageCount}`
  chat.snapshots.push({
    messageCount,
    snapshotKey,
    updatedAt: period,
    usedAt: period,
    preview: patternedText(`memory-preview-${period}`, 160),
  })
  set(operations, RISU_AGENTS, snapshotKey, {
    version: 4,
    messageCount,
    value: patternedText(`complete-memory-${period}`, 2_500),
    updatedAt: period,
  })
  const indexValue = {
    version: 4,
    agentId: 'agent-plot',
    agentName: 'Plot Memory',
    characterId: chat.characterId,
    chatIndex,
    chatKey: chat.chatId,
    pointer: messageCount,
    snapshots: chat.snapshots,
    updatedAt: period,
  }
  // A successful memory load touches the index, then the new snapshot publish
  // writes it again. Preserve that same-key churn.
  set(operations, RISU_AGENTS, `${base}:index`, { ...indexValue, updatedAt: period - 0.5 })
  set(operations, RISU_AGENTS, `${base}:index`, indexValue)

  const runPrefix = `risu_agents_run_body_v1:${chat.characterId}:${chat.chatId}`
  const bodyPaths = [
    'settingBlocks',
    'preResults.0.content',
    'preResults.0.rawOutput',
    'preResults.0.prompt',
    'preResults.1.content',
    'preResults.1.prompt',
    'preResults.2.memoryUpdate',
    'finalResponse',
  ]
  for (const phase of ['before', 'after'] as const) {
    for (const [index, fieldPath] of bodyPaths.entries()) {
      const value = patternedText(
        `agent-body-${period}-${phase}-${fieldPath}`,
        fieldPath.includes('prompt') ? 8_500 + index * 300 : 1_600 + index * 220,
      )
      set(operations, RISU_AGENTS, `${runPrefix}:${fieldPath}`, {
        version: 1,
        runKey: `run-${period}`,
        fieldPath,
        value,
        chars: value.length,
        updatedAt: period,
      })
    }
    set(operations, RISU_AGENTS, `risu_agents_run:${chat.characterId}:${chat.chatId}`, {
      version: 1,
      type: phase,
      status: phase === 'after' ? 'complete' : 'running',
      runKey: `run-${period}`,
      pipelineSnapshot: patternedText(`run-pipeline-${period}`, 7_000),
      notes: [{ content: patternedText(`run-note-${period}`, 1_500) }],
      userInput: patternedText(`run-input-${period}`, 1_800),
      finalResponse: phase === 'after' ? patternedText(`run-final-${period}`, 700) : '',
      bodyReferences: bodyPaths,
      updatedAt: period,
    })
  }
}

interface YumiState {
  promptPresets: Array<Record<string, unknown>>
  characterOverrides: Record<string, unknown>
  optionSelections: Record<string, unknown>
}

function makeYumiPromptPreset(id: string, seed: number): Record<string, unknown> {
  return {
    id,
    name: `Prompt ${id}`,
    input: patternedText(`yumi-input-${seed}`, 7_500),
    output: patternedText(`yumi-output-${seed}`, 7_500),
    sync: patternedText(`yumi-sync-${seed}`, 7_500),
    glossary: patternedText(`yumi-glossary-${seed}`, 7_500),
    guide: patternedText(`yumi-guide-${seed}`, 7_500),
    loreKey: patternedText(`yumi-lore-${seed}`, 7_500),
    protectGen: patternedText(`yumi-protect-${seed}`, 7_500),
  }
}

function addYumiPeriod(
  period: number,
  operations: PluginStorageOperation[],
  state: YumiState,
): void {
  if (period === 1) {
    state.promptPresets.push(makeYumiPromptPreset('default', 0))
    set(operations, YUMI, 'yumi_tr_update_dismissed_version', { version: '1.1.0' })
    set(operations, YUMI, 'yumi_tr_update_state', { dismissedVersion: '1.1.0' })
    remove(operations, YUMI, 'yumi_tr_update_dismissed_version')
  }
  if (period % 10 === 0) {
    state.promptPresets.push(makeYumiPromptPreset(`detached-remote-${period}`, period))
  }
  const characterId = `character-${period.toString().padStart(3, '0')}`
  state.characterOverrides[characterId] = {
    name: `Character ${period}`,
    translation: period % 2 === 0,
    settingsPresetId: 'default',
    promptPresetId: state.promptPresets.at(-1)?.id,
    excludedLorebooks: Array.from({ length: 4 }, (_, index) => `lore-${period}-${index}`),
    promptOptions: { language: 'Korean', tone: `tone-${period % 5}` },
  }
  if (period % 5 === 0) {
    state.optionSelections[`preset-${period}`] = {
      variables: { genre: `genre-${period % 4}`, audience: 'adult' },
      language: { display: 'Korean', model: 'ko' },
    }
  }

  set(operations, YUMI, 'yumi_tr_settings_presets', {
    presets: [{
      id: 'default',
      name: 'Default',
      settings: {
        sourceLanguage: 'auto',
        targetLanguage: 'ko',
        coldPolicy: 'compress',
        coldCap: 200,
        deterministicSession: period,
        padding: patternedText(`settings-${period}`, 1_200),
      },
    }],
    activeId: 'default',
  })
  set(operations, YUMI, 'yumi_tr_prompt_presets', {
    presets: state.promptPresets,
    activeId: 'default',
    editedAt: period,
  })
  set(operations, YUMI, 'yumi_tr_character_overrides', jsonString(state.characterOverrides))
  if (period % 5 === 0) {
    set(operations, YUMI, 'yumi_tr_prompt_option_selections', jsonString(state.optionSelections))
  }
  if (period % 7 === 0 || period === 1) {
    set(operations, YUMI, 'yumi_tr_protect_presets', {
      presets: [{ id: 'default', custom: Array.from({ length: period }, (_, index) => `token-${index}`) }],
      activeId: 'default',
    })
    set(operations, YUMI, 'yumi_tr_correction_presets', {
      presets: [{
        id: 'default',
        rules: Array.from({ length: Math.ceil(period / 4) }, (_, index) => ({
          from: `source-${index}`,
          to: `target-${index}`,
        })),
      }],
      activeId: 'default',
    })
  }
  if (period % 10 === 0 || period === 1) {
    set(operations, YUMI, 'yumi_tr_remote_prompt_presets', `gzip:${patternedText(`remote-prompts-${period}`, 4_000)}`)
    set(operations, YUMI, 'yumi_tr_protect_packs', `gzip:${patternedText(`protect-packs-${period}`, 2_000)}`)
  }
  if (period % 15 === 0) {
    set(operations, YUMI, 'yumi_tr_update_state', { shownChangelogVersion: `1.2.${period}` })
  }
}

function applyExpectedOperation(values: Map<string, unknown>, operation: PluginStorageOperation): void {
  if (operation.kind === 'set') values.set(operation.key, operation.value)
  else values.delete(operation.key)
}

export function buildRealPluginStorageWorkload(
  periodCount = REAL_PLUGIN_WORKLOAD_PERIODS,
): PluginStorageWorkload {
  const flashbackScopes: FlashbackScope[] = []
  const wygLoreSessions: WygLoreSession[] = []
  const provider110: Provider110State = {
    thinking: [],
    tools: [],
    logs: [],
    batches: [],
    scopes: [],
  }
  const provider135: Provider135State = { records: [], auxLogs: [], scopes: [] }
  const risuAgentChats: RisuAgentChat[] = []
  const yumi: YumiState = { promptPresets: [], characterOverrides: {}, optionSelections: {} }
  const finalValues = new Map<string, unknown>()
  const seenKeys = new Map<RealPluginName, Set<string>>(
    REAL_PLUGIN_NAMES.map(plugin => [plugin, new Set<string>()]),
  )
  const summaryByPlugin = Object.fromEntries(REAL_PLUGIN_NAMES.map(plugin => [plugin, {
    sets: 0,
    removes: 0,
    distinctKeys: 0,
  }])) as Record<RealPluginName, PluginStorageWorkloadSummary>
  const periods: PluginStorageWorkloadPeriod[] = []

  for (let period = 1; period <= periodCount; period += 1) {
    const operations: PluginStorageOperation[] = []
    addFlashbackPeriod(period, operations, flashbackScopes)
    addWygLorePeriod(period, operations, wygLoreSessions)
    addProvider110Period(period, operations, provider110)
    addProvider135Period(period, operations, provider135)
    addRisuAgentsPeriod(period, operations, risuAgentChats)
    addYumiPeriod(period, operations, yumi)
    for (const operation of operations) {
      const summary = summaryByPlugin[operation.plugin]
      summary[operation.kind === 'set' ? 'sets' : 'removes'] += 1
      seenKeys.get(operation.plugin)!.add(operation.key)
      applyExpectedOperation(finalValues, operation)
    }
    periods.push({ period, operations })
  }
  for (const plugin of REAL_PLUGIN_NAMES) {
    summaryByPlugin[plugin].distinctKeys = seenKeys.get(plugin)!.size
  }
  return { periods, finalValues, summaryByPlugin }
}
