import { describe, expect, test, vi } from 'vitest'
import { DatabaseDirtyRevisionLedger } from '../../src/ts/storage/databaseDirtyRevisions'

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

const { RisuSaveEncoder, RisuSavePatcher } = await import('../../src/ts/storage/risuSave')

const emptyToSave = () => ({
  character: [] as string[],
  chat: [] as [string, string][],
  root: false,
  botPreset: false,
  modules: false,
  plugins: false,
  pluginCustomStorage: false,
})

function makeDatabase(characterCount: number) {
  return {
    username: 'before',
    personaPrompt: 'p',
    characters: Array.from({ length: characterCount }, (_, index) => ({
      chaId: `character-${index}`,
      name: `Character ${index}`,
      desc: `${index}:${'x'.repeat(8 * 1024)}`,
      chats: [{ id: `chat-${index}`, name: 'Chat', _stub: true }],
      chatPage: 0,
    })),
    botPresets: [],
    modules: [],
    plugins: [],
    pluginCustomStorage: {},
  }
}

async function unrelatedSaveWork(characterCount: number) {
  const database = makeDatabase(characterCount)
  const ledger = new DatabaseDirtyRevisionLedger()
  ledger.trustRootStructure(true)
  ledger.trustRootKey('username', true)
  ledger.trustRootKey('personaPrompt', true)
  ledger.trustCharacterStructure(true)
  for (const character of database.characters) {
    ledger.trustCharacter(character.chaId, true)
  }
  ledger.trustModuleStructure(true)
  ledger.trustBranch('modulesStructural', true)
  ledger.trustBranch('botPreset', true)
  ledger.trustBranch('plugins', true)
  ledger.trustBranch('pluginCustomStorage', true)

  const events: Array<{ codec: string; branch: string }> = []
  const codecOptions = {
    // The production performance path is measured with dual-run verification off.
    verifyDirtyRevisions: false,
    onWork: (event: { codec: string; branch: string }) => events.push(event),
  }
  const encoder = new RisuSaveEncoder(codecOptions as any)
  const patcher = new RisuSavePatcher(codecOptions as any)
  await encoder.init(database as any)
  await patcher.init(database)

  database.username = 'after'
  ledger.markRootKey('username')
  const revisions = ledger.capture()
  events.length = 0
  await encoder.set(database as any, { ...emptyToSave(), root: true }, revisions)
  const proposal = await patcher.set(database, { ...emptyToSave(), root: true }, revisions)

  return {
    encoderCharacterSerializations: events.filter(event => (
      event.codec === 'encoder' && event.branch === 'character'
    )).length,
    patcherCharacterSerializations: events.filter(event => (
      event.codec === 'patcher' && event.branch === 'character'
    )).length,
    patchOperations: proposal.patch.length,
  }
}

describe('unrelated-save work bounds', () => {
  test('character serialization work stays zero as character count grows', async () => {
    const small = await unrelatedSaveWork(16)
    const large = await unrelatedSaveWork(512)

    expect(small.encoderCharacterSerializations).toBe(0)
    expect(small.patcherCharacterSerializations).toBe(0)
    expect(large.encoderCharacterSerializations).toBe(0)
    expect(large.patcherCharacterSerializations).toBe(0)
    expect(small.patchOperations).toBe(1)
    expect(large.patchOperations).toBe(1)
  })
})
