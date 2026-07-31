import type { character } from 'src/ts/storage/database.svelte'
import { DBState } from 'src/ts/stores.svelte'
import { beforeEach, expect, test, vi } from 'vitest'
import { CharacterHandler } from '../characters'

const mocks = vi.hoisted(() => ({
  alertConfirm: vi.fn(async () => true),
  markCharacterDirty: vi.fn(),
}))

vi.mock(import('katex'), () => ({}))
vi.mock(import('src/ts/lite'), () => ({}))
vi.mock(import('src/ts/alert'), () => ({
  alertConfirm: mocks.alertConfirm,
  alertInput: vi.fn(),
}))
vi.mock(import('src/ts/globalApi.svelte'), () => ({
  fetchNative: vi.fn(),
  markCharacterDirty: mocks.markCharacterDirty,
  openURL: vi.fn(),
}))
vi.mock(import('src/ts/storage/database.svelte'), () => ({
  getCurrentCharacter: () => DBState.db.characters[0],
}))
vi.mock(import('src/ts/stores.svelte'), () => {
  return {
    DBState: {
      db: {
        characters: [],
      },
    },
    selIdState: {
      selId: 0,
    },
  } as unknown as typeof import('src/ts/stores.svelte')
})

function makeCharacter(): character {
  return {
    chaId: 'char-target',
    name: 'Target',
    chats: [],
    globalLore: [],
    customscript: [],
    additionalAssets: [],
    triggerscript: [{
      comment: '',
      conditions: [],
      effect: [{ type: 'triggerlua', code: 'return "before"' }],
      type: 'manual',
    }],
  } as character
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.alertConfirm.mockResolvedValue(true)
  DBState.db.characters = [makeCharacter()]
})

test.each<{
  name: string
  tool: string
  args: Record<string, unknown>
  prepare?: (char: character) => void
}>([
  {
    name: 'character information',
    tool: 'risu-set-character-info',
    args: { id: 'char-target', data: { description: 'after' } },
  },
  {
    name: 'new lorebook entry',
    tool: 'risu-set-character-lorebook',
    args: { id: 'char-target', name: 'Lore', content: 'after' },
  },
  {
    name: 'existing lorebook entry',
    tool: 'risu-set-character-lorebook',
    args: { id: 'char-target', name: 'Lore', content: 'after' },
    prepare: char => char.globalLore.push({
      alwaysActive: false,
      comment: 'Lore',
      content: 'before',
      insertorder: 100,
      key: '',
      mode: 'normal',
      secondkey: '',
      selective: false,
    }),
  },
  {
    name: 'lorebook deletion',
    tool: 'risu-delete-character-lorebook',
    args: { id: 'char-target', name: 'Lore' },
    prepare: char => char.globalLore.push({
      alwaysActive: false,
      comment: 'Lore',
      content: 'before',
      insertorder: 100,
      key: '',
      mode: 'normal',
      secondkey: '',
      selective: false,
    }),
  },
  {
    name: 'new regex script',
    tool: 'risu-set-character-regex-scripts',
    args: { id: 'char-target', name: 'Regex', in: 'before', out: 'after' },
  },
  {
    name: 'existing regex script',
    tool: 'risu-set-character-regex-scripts',
    args: { id: 'char-target', name: 'Regex', out: 'after' },
    prepare: char => char.customscript.push({
      ableFlag: true,
      comment: 'Regex',
      flag: '',
      in: 'before',
      out: 'before',
      type: 'editdisplay',
    }),
  },
  {
    name: 'regex deletion',
    tool: 'risu-delete-character-regex-scripts',
    args: { id: 'char-target', name: 'Regex' },
    prepare: char => char.customscript.push({
      ableFlag: true,
      comment: 'Regex',
      flag: '',
      in: 'before',
      out: 'before',
      type: 'editdisplay',
    }),
  },
  {
    name: 'additional asset deletion',
    tool: 'risu-delete-character-additional-assets',
    args: { id: 'char-target', assetName: 'Asset' },
    prepare: char => char.additionalAssets.push(['Asset', 'assets/a.png', 'png']),
  },
  {
    name: 'Lua update',
    tool: 'risu-set-character-lua-script',
    args: { id: 'char-target', code: 'return "after"' },
  },
])('marks the arbitrary target after mutating $name', async ({ tool, args, prepare }) => {
  const char = DBState.db.characters[0]
  prepare?.(char)

  const response = await new CharacterHandler().handle(tool, args)

  expect(response?.[0]).toEqual(expect.objectContaining({ type: 'text' }))
  expect(mocks.markCharacterDirty).toHaveBeenCalledWith('char-target')
})

test('does not mark or mutate a denied operation', async () => {
  mocks.alertConfirm.mockResolvedValue(false)

  const response = await new CharacterHandler().handle('risu-set-character-info', {
    id: 'char-target',
    data: { name: 'Denied' },
  })

  expect(response).toEqual([{ type: 'text', text: 'Access denied by user.' }])
  expect(DBState.db.characters[0].name).toBe('Target')
  expect(mocks.markCharacterDirty).not.toHaveBeenCalled()
})

test('preserves partial-update compatibility while scheduling fields changed before an error', async () => {
  const response = await new CharacterHandler().handle('risu-set-character-info', {
    id: 'char-target',
    data: { name: 'Changed first', unsupported: true },
  })

  expect(response?.[0]).toEqual(expect.objectContaining({
    type: 'text',
    text: expect.stringContaining('does not exist'),
  }))
  expect(DBState.db.characters[0].name).toBe('Changed first')
  expect(mocks.markCharacterDirty).toHaveBeenCalledWith('char-target')
})
