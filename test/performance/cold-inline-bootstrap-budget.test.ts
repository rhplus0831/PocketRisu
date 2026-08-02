import { describe, expect, test, vi } from 'vitest'

vi.mock('../../src/ts/storage/database.svelte', () => ({
  createBotPresetTemplate: () => ({ id: 'default' }),
}))

vi.mock('../../src/ts/storage/chatStorage', () => ({
  chatToStub: (chat: any) => ({
    id: chat?.id ?? '',
    name: chat?.name ?? '',
    _stub: true,
  }),
}))

vi.mock('../../src/ts/globalApi.svelte', () => ({
  forageStorage: { realStorage: null },
}))

const MIB = 1024 * 1024
const LARGE_INLINE_VALUE_BYTES = 8 * MIB
const BOOT_RETAINED_PAYLOAD_MULTIPLIER = 7
const BOOT_FIXED_HEADROOM_BYTES = 256 * 1024

type BootstrapMeasurement = {
  inputBytes: number
  payloadBytes: number
  largeBlockParseCalls: number
  largeBlockParsedBytes: number
  decodeInstallBytes: number
  codecReadyBytes: number
  peakLogicalBytes: number
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function block(type: number, name: string, value: unknown): Uint8Array {
  const nameBytes = new TextEncoder().encode(name)
  const body = new TextEncoder().encode(JSON.stringify(value))
  const bytes = new Uint8Array(7 + nameBytes.byteLength + body.byteLength)
  bytes[0] = type
  bytes[1] = 0
  bytes[2] = nameBytes.byteLength
  bytes.set(nameBytes, 3)
  new DataView(bytes.buffer).setUint32(3 + nameBytes.byteLength, body.byteLength, true)
  bytes.set(body, 7 + nameBytes.byteLength)
  return bytes
}

function strictInlineSave(valueBytes: number): Uint8Array {
  const blocks = [
    block(1, 'root', {
      characters: [],
      optimizePluginMemory: false,
      __directory: ['preset', 'modules', 'plugins', 'pluginStorage', 'config'],
    }),
    block(4, 'preset', [{ id: 'default' }]),
    block(5, 'modules', []),
    block(9, 'plugins', []),
    block(11, 'pluginStorage', {
      inline: 'x'.repeat(valueBytes),
    }),
    block(0, 'config', { version: 1 }),
  ]
  const header = new TextEncoder().encode('RISUSAVE\0')
  const bytes = new Uint8Array(
    header.byteLength + blocks.reduce((total, entry) => total + entry.byteLength, 0),
  )
  bytes.set(header)
  let offset = header.byteLength
  for (const entry of blocks) {
    bytes.set(entry, offset)
    offset += entry.byteLength
  }
  return bytes
}

function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value))
}

async function measureColdInlineBootstrap(valueBytes: number): Promise<BootstrapMeasurement> {
  const {
    RisuSaveEncoder,
    RisuSavePatcher,
  } = await import('../../src/ts/storage/risuSave')
  const { decodeStrictRisuSaveBlocks } = await import(
    '../../src/ts/storage/strictRisuSaveCodec'
  )
  const { cloneDatabaseState } = await import('../../src/ts/storage/databaseClone')
  const { copyDatabasePluginStorageRecord } = await import(
    '../../src/ts/plugins/pluginStorageRecord'
  )

  const input = strictInlineSave(valueBytes)
  const payloadBytes = jsonBytes({ inline: 'x'.repeat(valueBytes) })
  const originalParse = JSON.parse.bind(JSON)
  let largeBlockParseCalls = 0
  let largeBlockParsedBytes = 0
  const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
    if (typeof text === 'string') {
      const bytes = utf8Bytes(text)
      if (bytes >= Math.max(MIB, payloadBytes / 2)) {
        largeBlockParseCalls += 1
        largeBlockParsedBytes += bytes
      }
    }
    return originalParse(text, reviver)
  })

  let decoded: Record<string, any>
  try {
    decoded = await decodeStrictRisuSaveBlocks(input) as Record<string, any>
  } finally {
    parseSpy.mockRestore()
  }

  // This mirrors the active cold-boot ownership sequence without asserting the
  // deferred Track 5.1 one-resident-copy target: bootstrap preserves a detached
  // patch baseline, installs a shallow compatibility-map copy, then saveDb()
  // initializes the encoder and patcher generations.
  const initialPatchBaseline = cloneDatabaseState(decoded)
  decoded.pluginCustomStorage = copyDatabasePluginStorageRecord(
    decoded.pluginCustomStorage,
  )
  const liveDatabase = decoded

  const encoder = new RisuSaveEncoder({ verifyDirtyRevisions: false })
  await encoder.init(liveDatabase as any, { compression: false })
  const patcher = new RisuSavePatcher({ verifyDirtyRevisions: false })
  await patcher.init(initialPatchBaseline)

  const encoderState = encoder as unknown as {
    baselineJsons: { pluginStorage: string }
    blocks: { pluginStorage: Uint8Array }
  }
  const patcherState = patcher as unknown as {
    lastSyncedDb: Record<string, any>
    lastRootKeyJsons: Map<string, string>
  }
  const patcherPluginJson = patcherState.lastRootKeyJsons.get('pluginCustomStorage')
  expect(patcherPluginJson).toBeDefined()
  expect(patcherState.lastSyncedDb).not.toBe(initialPatchBaseline)
  expect(patcherState.lastSyncedDb).not.toBe(liveDatabase)

  const liveGraphBytes = jsonBytes(liveDatabase.pluginCustomStorage)
  const initialPatchBaselineBytes = jsonBytes(initialPatchBaseline.pluginCustomStorage)
  const patcherGraphBytes = jsonBytes(patcherState.lastSyncedDb.pluginCustomStorage)
  const decodeInstallBytes = input.byteLength + liveGraphBytes + initialPatchBaselineBytes
  const codecReadyBytes = liveGraphBytes
    + initialPatchBaselineBytes
    + utf8Bytes(encoderState.baselineJsons.pluginStorage)
    + encoderState.blocks.pluginStorage.byteLength
    + patcherGraphBytes
    + utf8Bytes(patcherPluginJson!)

  encoder.retire()
  patcher.retire()
  return {
    inputBytes: input.byteLength,
    payloadBytes,
    largeBlockParseCalls,
    largeBlockParsedBytes,
    decodeInstallBytes,
    codecReadyBytes,
    peakLogicalBytes: Math.max(decodeInstallBytes, codecReadyBytes),
  }
}

describe('cold inline bootstrap budget', () => {
  test('parses the large block once and keeps current retained forms within 7S', async () => {
    const cacheMode = process.env.POCKETRISU_PERF_RESOURCE_CACHE
    expect(['off', 'on']).toContain(cacheMode)

    const empty = await measureColdInlineBootstrap(0)
    const large = await measureColdInlineBootstrap(LARGE_INLINE_VALUE_BYTES)
    const payloadSizeS = large.payloadBytes - empty.payloadBytes
    const attributablePeak = large.peakLogicalBytes - empty.peakLogicalBytes

    expect(payloadSizeS).toBeGreaterThanOrEqual(LARGE_INLINE_VALUE_BYTES)
    expect(large.inputBytes - empty.inputBytes).toBeLessThanOrEqual(
      payloadSizeS + 64,
    )
    expect(empty.largeBlockParseCalls).toBe(0)
    expect(large.largeBlockParseCalls).toBe(1)
    expect(large.largeBlockParsedBytes).toBe(large.payloadBytes)
    expect(attributablePeak).toBeLessThanOrEqual(
      payloadSizeS * BOOT_RETAINED_PAYLOAD_MULTIPLIER + BOOT_FIXED_HEADROOM_BYTES,
    )
  })
})
