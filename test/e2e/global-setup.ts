/**
 * Builds the cached fixture templates once per run (no-op when the spec
 * strings match the cache) and verifies `dist/` is present — the server
 * serves the built SPA and rejects mutations from mismatched client builds.
 */
import { access } from 'node:fs/promises'
import path from 'node:path'
import { createE2eApiClient } from './helpers/apiClient.js'
import { createE2eSeedBackup, mockProviderDatabaseFields, type E2eSeedSpec } from './helpers/seedData.js'
import { ensureTemplate, E2E_PASSWORD_DIGEST, PROJECT_ROOT } from './helpers/server.js'

const MEDIUM_SPEC: E2eSeedSpec = { characterCount: 10, chatsPerCharacter: 3, messagesPerChat: 30, messageBytes: 200 }
const LARGE_CHAT_SPEC: E2eSeedSpec = { characterCount: 3, chatsPerCharacter: 2, messagesPerChat: 400, messageBytes: 1000 }
/** Boot-scaling fixture: many characters, modest chats. */
const XL_SPEC: E2eSeedSpec = { characterCount: 300, chatsPerCharacter: 2, messagesPerChat: 20, messageBytes: 300 }
/** Large-chat data plus classic model config aimed at the mock provider. */
const PROVIDER_SPEC: E2eSeedSpec = { ...LARGE_CHAT_SPEC, databaseFields: mockProviderDatabaseFields }

/** PF-05 crossover fixture: stubs DB > 1 MB via 4 KB character descriptions. */
const XXL_DESC_SPEC: E2eSeedSpec = {
  characterCount: 300, chatsPerCharacter: 1, messagesPerChat: 4,
  messageBytes: 200, characterDescBytes: 4096,
}

const TEMPLATES: ReadonlyArray<readonly [string, E2eSeedSpec]> = [
  ['medium', MEDIUM_SPEC],
  ['large-chat', LARGE_CHAT_SPEC],
  ['xl', XL_SPEC],
  ['provider', PROVIDER_SPEC],
  ['xxl-desc', XXL_DESC_SPEC],
]

export default async function globalSetup(): Promise<void> {
  try {
    await access(path.join(PROJECT_ROOT, 'dist', 'build-stamp.json'))
  } catch {
    throw new Error('dist/build-stamp.json missing — run `pnpm build` before the E2E suite.')
  }

  for (const [name, spec] of TEMPLATES) {
    await ensureTemplate(name, JSON.stringify(spec), async (server) => {
      const client = await createE2eApiClient(server.port, E2E_PASSWORD_DIGEST)
      const result = await client.importBackup(createE2eSeedBackup(spec))
      if (!result.ok) {
        throw new Error(`Template "${name}" seed import failed: ${JSON.stringify(result)}`)
      }
    })
  }
}
