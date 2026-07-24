# PocketRisu — Codebase Structure Guide

Navigation map for developers and AI agents. Read this first, then open the relevant
detail doc under [docs/structure/](docs/structure/) — each one covers a subsystem's key
files, runtime flows, cross-subsystem edges, invariants/gotchas, and "to change X, look
at Y" hints with `file:line` references.

Generated 2026-07-23. Line numbers in the detail docs drift as code changes; verify with
`rg` before relying on them.

## What PocketRisu is

A self-hosted fork of [RisuAI](https://github.com/kwaroran/RisuAI) (AI roleplay chat):
one Node server on your PC/homeserver, accessed from any browser. Frontend is a Svelte 5
+ Vite SPA (`src/`); backend is an Express server (`server/node/server.cjs`) storing all
data in a single SQLite database. **RisuAI ecosystem compatibility is a hard
constraint** — character cards, presets, modules, and `.bin` backups must round-trip
with upstream.

## Runtime topology

```text
Browser SPA (src/)                          Node server (server/node/)
┌──────────────────────────┐   HTTP/WS   ┌─────────────────────────────┐
│ index.html → src/main.ts │ ─────────── │ server.cjs (Express, ~6.4k) │
│ → App.svelte             │  /api/*     │ ├ db.cjs      → SQLite kv: stub DB + chats/*
│   store-driven screens,  │  /proxy2    │ ├ chunkStore  → CDC chunks: chats/snapshots
│   no URL router          │  /proxy-    │ ├ logs.cjs    → save/logs.db
│ NodeStorage (HTTP client)│  stream-jobs│ ├ inlays      → save/inlays/*.ext + sidecars
│ forageStorage = server KV│             │ └ backups     → backups/*.bin
└──────────────────────────┘             └─────────────────────────────┘
```

- The client holds the whole `Database` object in memory (`DBState.db`, a Svelte 5
  `$state` rune) with chats **stubbed out**; full chat bodies are fetched lazily and
  saved individually. A reactive save loop syncs changes to the server via JSON Patch
  (`/api/patch`) with full-write fallback (`/api/write`).
- Model API calls go direct from the browser when possible, otherwise through the
  server's `/proxy2`; streaming local-network requests use WebSocket proxy jobs.
- `server/hono/` is a **non-functional scaffold** (only `GET /`), not an alternate
  backend. `server.cjs` treats `process.cwd()` as the app root and does not parse
  `.env`.

## Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Vite dev server (port 5174) |
| `pnpm build` | Production build to `dist/` |
| `pnpm runserver` | Start the Node backend (serves `dist/`, port 6001 or `$PORT`) |
| `pnpm check` | `svelte-check` type checking |
| `pnpm test` | Default vitest suite (happy-dom, colocated `*.test.ts` in `src/`) |
| `pnpm test:server` | Server-side tests (`server/node/**/*.test.ts`, node env, real better-sqlite3) |
| `pnpm test:compat` | RisuAI compatibility suite (`test/compat/`, backup/preset/DB round-trips) |

## Directory map

| Path | Contents |
|---|---|
| `src/ts/` | All application logic, grouped by domain (see subsystem index) |
| `src/lib/` | Svelte components: `ChatScreens/`, `SideBars/`, `Setting/`, `UI/`, `Mobile/`, `LiteUI/`, `Playground/`, `Others/`, `_dev/` |
| `src/lang/` | UI translations (`en.ts`, `ko.ts`, …) + help texts (`help.*.ts`) |
| `src/etc/` | Bundled assets (sounds, default images, patch notes) |
| `server/node/` | The production Express backend |
| `server/hono/` | Inactive multi-runtime scaffold |
| `docs/` | User docs (`en/`, `ko/`, …) and these structure docs (`structure/`) |
| `test/compat/` | Upstream-compatibility integration tests |
| `scripts/` | Portable launcher (C), Termux build, standalone updater (`updater.cjs`) |
| `public/` | Static assets copied into the build |
| `util/` | Userscript helper for CORS-free fetches |

## Subsystem index

| Doc | Scope |
|---|---|
| [server-backend](docs/structure/server-backend.md) | Express server: HTTP route catalog, JWT/session auth, stubs-only database + externalized chat rows in SQLite KV, content-defined chunking, patch sync, assembled backups/snapshots, orphan GC, storage dashboard, proxies, self-update. |
| [client-storage](docs/structure/client-storage.md) | The `Database` model and `setDatabase()` defaults, `NodeStorage` HTTP adapter, reactive save loop in `globalApi.svelte.ts`, RisuSave codecs + JSON-Patch sync, chat stub/placeholder hydration, drafts, `.bin` backups, bootstrap ordering. |
| [chat-pipeline](docs/structure/chat-pipeline.md) | `sendChat()` end to end: prompt buckets and prompt-card templates, token budgeting, attachment/multimodal conversion, streaming, regenerate/continue, post-processing, suggestions, slash commands. |
| [model-providers](docs/structure/model-providers.md) | Legacy `LLMModel` registry (`format` dispatch, flags) and provider wire code (OpenAI/Anthropic/Google/NovelAI/Horde/…), ModelPreset adapter path, streaming contracts, proxy/local-network transport, how to add a model or provider. |
| [presets-profiles](docs/structure/presets-profiles.md) | The three-concept split: registry `ModelProfile` → installed `ModelPreset` (frozen snapshot + adapters) vs upstream-compatible `botPreset` (prompt preset, `.risup`). Registries, custom profiles, key pool, Gemini context cache. |
| [memory-lorebook](docs/structure/memory-lorebook.md) | Lorebook activation (keys, decorators, recursion, budget), HypaMemory V3 long-term summarization, embedding backends and vector caches, module scoping (`getModules()`) and content projection. |
| [characters-personas](docs/structure/characters-personas.md) | `character`/`RisuPersona` models, card import/export (PNG V2/V3, CharX, JSON, RCC), character packages, PNG chunk + RPack primitives, `.risum`/`.risup` routing, RisuRealm integration, asset storage. |
| [scripting-extensions](docs/structure/scripting-extensions.md) | CBS `{{...}}` template engine, regex scripts (4 edit modes), triggers V1/V2/Lua, plugin API V2/V2.1/V3 (iframe sandbox), MCP clients (remote, internal, plugin) and tool-call flow. |
| [ui-layer](docs/structure/ui-layer.md) | Component map, root screen switching in `App.svelte`, stores-as-router, settings pages + declarative `SettingRenderer`, chat render chain (`Chats` → `Chat` → `ChatBody`), mobile vs desktop shells, theming/alerts/hotkeys. |
| [media-translation](docs/structure/media-translation.md) | Translation providers (LLM/DeepL/Bergamot/Google) and caches, TTS providers + plugin hooks, inlay asset lifecycle (upload → storage → lazy render), image generation (`stableDiff`), notification sounds. |

## The three flows you'll trace most

**Send a message** — `DefaultChatScreen.sendMain()` (commands, input scripts) →
`sendChat()` in `src/ts/process/index.svelte.ts` (prompt assembly, lore/memory hooks,
token budgeting) → `requestChatData()` in `src/ts/process/request/request.ts` (retries,
plugin/trigger hooks, classic-vs-preset dispatch) → provider wire code → cumulative
stream snapshots back into the chat → `editoutput` scripts / output triggers → the save
loop persists the mutation. Details: chat-pipeline, model-providers.

**Persist data** — mutate `DBState.db` (that's the convention — no explicit save call)
→ `$effect`s in `saveDb()` (`src/ts/globalApi.svelte.ts`) mark dirty state → changed
full chats are POSTed to `/api/chat-content` first, then the stub-only database syncs
via `/api/patch` (JSON Patch + hash) or ETag-guarded `/api/write` → the server writes
chat rows through immediately and debounce-writes the stubs-only database. Details: client-storage,
server-backend.

**Extend behavior** — CBS expressions expand during prompt building and display; regex
scripts run at `editinput`/`editoutput`/`editprocess`/`editdisplay`; triggers fire at
`start`/`output`/`display`/`request`/`manual`; plugins hook requests and provide
models; MCP tools are injected into provider tool-call loops. Execution order for one
string: Lua listeners → display triggers → plugin handlers → CBS → regex scripts
(`processScriptFull()` in `src/ts/process/scripts.ts`). Details: scripting-extensions.

## Global invariants (break these and things corrupt quietly)

- **Client/server protocol code is duplicated and must change in lockstep**: chat-stub
  metadata allowlists, `normalizeJSON()`/`calculateHash()` patch hashing, `RisuSaveType`
  constants, and the asset "uncleanables" sets all exist in both `src/ts/` and
  `server/node/`. Each detail doc calls out its pairs.
- **Chat stubs vs placeholders**: `_stub: true` is the wire marker for chats without
  messages; `_placeholder: true` is the runtime marker. Hydrate placeholders
  (`ensureChatHydrated()`) before reading or mutating messages. Multiple guard layers
  exist specifically to prevent chat-message loss — don't remove any of them.
- **Persisted numeric enums** (`LLMFlags`, `LLMFormat`, `LLMTokenizer`) and stable IDs
  (`chaId`, chat IDs, persona IDs, preset UUIDs): append new values, never renumber;
  never key durable references by array index. Exception: `botPresetsId` stays
  index-based for upstream backup compatibility.
- **Two model regimes coexist**: legacy global `LLMModel` selection and per-chat
  `ModelPreset` bindings with frozen profile snapshots. Many behaviors (tools, retries,
  key resolution) are implemented separately in both.
- **Streaming contract**: providers emit *cumulative* text snapshots, not deltas;
  `editoutput` hooks run on every snapshot and must be repeat-safe.
- **RisuAI compat quirks are intentional**: the misspelled `extentions` field, RPack
  obfuscation, legacy save-format fallbacks, `GET /api/remove`, index-based
  `botPresetsId`. Don't "fix" them without a coordinated compat plan (`test/compat/`
  guards some of this).
- **Svelte 5 conventions**: runes (`DBState`) and classic writable stores coexist;
  files with runes need the `.svelte.ts` suffix. UI binds directly into `DBState.db`;
  the save loop depends on deep reactive reads (`deepTouch`).
