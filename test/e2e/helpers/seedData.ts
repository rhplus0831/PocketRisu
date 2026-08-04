/**
 * E2E dataset builders. Same wire format as `test/compat/helpers/seed.ts`,
 * with size knobs the audit scenarios need. Message bodies are deterministic
 * pseudo-random printable ASCII (seeded PRNG), so gzip cannot flatter the
 * byte measurements the way repeated filler text does.
 */
import { Packr } from 'msgpackr'
import { encodeBackup } from '../../compat/helpers/encode.js'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })

function encodeRisuSaveLegacy(data: unknown): Buffer {
  return Buffer.concat([MAGIC_RAW, packr.encode(data)])
}

/** mulberry32 — tiny deterministic PRNG so templates rebuild identically. */
function createRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const BODY_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,;:!?()-'

function randomBody(rng: () => number, stamp: string, bytes: number): string {
  let body = stamp
  while (body.length < bytes) {
    let word = ''
    const wordLength = 3 + Math.floor(rng() * 9)
    for (let i = 0; i < wordLength; i++) {
      word += BODY_ALPHABET[Math.floor(rng() * BODY_ALPHABET.length)]
    }
    body += word + ' '
  }
  return body.slice(0, Math.max(bytes, stamp.length))
}

export interface E2eSeedSpec {
  characterCount: number
  chatsPerCharacter: number
  messagesPerChat: number
  /** Approximate byte length of each message body. */
  messageBytes: number
  /** Byte length of each character description (stubs-DB scaling); default small. */
  characterDescBytes?: number
  /** PRNG seed; change to force different bodies. */
  seed?: number
  /** Extra root database fields (model config, flags…). */
  databaseFields?: Record<string, unknown>
}

export function createE2eSeedBackup(spec: E2eSeedSpec): Buffer {
  const rng = createRng(spec.seed ?? 0x9e2e5eed)
  const characters = Array.from({ length: spec.characterCount }, (_, ci) => ({
    name: `E2E Character ${ci}`,
    chaId: `e2e-char-${ci}`,
    desc: spec.characterDescBytes
      ? randomBody(rng, `E2E fixture character ${ci} `, spec.characterDescBytes)
      : `End-to-end fixture character ${ci}`,
    firstMessage: 'Hello from the E2E fixture!',
    chats: Array.from({ length: spec.chatsPerCharacter }, (_, chatIdx) => ({
      id: `e2e-chat-${ci}-${chatIdx}`,
      name: `Chat ${chatIdx}`,
      message: Array.from({ length: spec.messagesPerChat }, (_, mi) => ({
        role: mi % 2 === 0 ? 'user' : 'char',
        // Keep one greppable marker per message; the rest is incompressible.
        data: randomBody(rng, `E2EMSG c${ci} t${chatIdx} m${mi} `, spec.messageBytes),
      })),
      lastDate: Date.now(),
      localLore: [],
      scriptstate: {},
      note: '',
    })),
    chatPage: 0,
    image: '',
    // Keep the performance fixture focused on the shared ingest defaults.
    sdData: [],
    type: 'character',
  }))

  const database: Record<string, unknown> = {
    characters,
    apiType: 'openai',
    mainPrompt: '',
    jailbreak: '',
    globalNote: '',
    temperature: 80,
    maxContext: 4000,
    maxResponse: 300,
    frequencyPenalty: 70,
    PresensePenalty: 70,
    personas: [{ name: 'Default', icon: '', personaPrompt: '' }],
    botPresets: [],
    modules: [],
    botPresetsId: 0,
    moduleIntergration: '',
    selectedCharacter: 0,
    ...(spec.databaseFields ?? {}),
  }

  return encodeBackup([{ name: 'database.risudat', data: encodeRisuSaveLegacy(database) }])
}

/**
 * Classic-path model configuration pointing at the harness mock provider.
 * `reverse_proxy` + OpenAICompatible format sends OpenAI-style
 * chat.completions to `forceReplaceUrl` (LLMFormat.OpenAICompatible = 0).
 */
export const MOCK_PROVIDER_PORT = 46791
export const mockProviderDatabaseFields: Record<string, unknown> = {
  aiModel: 'reverse_proxy',
  subModel: 'reverse_proxy',
  forceReplaceUrl: `http://127.0.0.1:${MOCK_PROVIDER_PORT}/v1/chat/completions`,
  autofillRequestUrl: false,
  customAPIFormat: 0,
  customProxyRequestModel: 'e2e-mock-model',
  proxyKey: 'e2e-mock-key',
  useStreaming: true,
}
