# PocketRisu codebase structure guide

Navigation map for developers and AI agents. Start here, choose the owning subsystem,
then use the change maps and symbol names in `docs/structure/`. Ownership and runtime
behavior were audited on 2026-07-27 against `abee0232`. File paths and symbols are the
durable references; line-number hints in the detail docs are approximate and should be
confirmed with `rg`.

## What PocketRisu is

PocketRisu is a self-hosted fork of [RisuAI](https://github.com/kwaroran/RisuAI): a
Svelte 5 + Vite browser client backed by one Express/Node process and a SQLite KV core.
Chats, optimized plugin values, ordinary assets, inlays, backups, and recovery history
use specialized row or filesystem stores around that core.

PocketRisu maintains selected RisuAI interchange surfaces, including Character Card
V2/V3, `.risup` prompt presets, `.risum` modules, and RisuSave `.bin` migration.
Compatibility is surface-specific rather than universally lossless. Upstream-target
backups omit PocketRisu inlay namespaces, encrypted risuai.xyz account backups are not
accepted, and PocketRisu-only state may have no upstream runtime meaning.

## Find where to make a change

| I need to change… | Start here | Coordinate with |
|---|---|---|
| Screens, settings, chat rendering, mobile layout, themes | [UI layer](docs/structure/ui-layer.md) | Chat pipeline, client storage |
| Sending, prompt assembly, token budgeting, attachments | [Chat pipeline](docs/structure/chat-pipeline.md) | Memory, extensions, providers, media |
| Provider wire formats, streaming, tools, or transport | [Model providers](docs/structure/model-providers.md) | Presets/profiles, server backend |
| Model profiles, prompt presets, credentials, bindings, Gemini cache | [Presets and profiles](docs/structure/presets-profiles.md) | Model providers, chat pipeline |
| Database fields, save timing, chat hydration, drafts, browser cache | [Client storage](docs/structure/client-storage.md) | Server backend, backup/recovery |
| Routes, auth, SQLite, chunks, proxying, filesystem stores | [Server backend](docs/structure/server-backend.md) | Client storage, backup/recovery |
| Backups, partial exports, imports, snapshots, destructive restore | [Backup and recovery](docs/structure/backup-recovery.md) | Server backend, client storage |
| Plugin KV semantics, CAS/batches, generations, transitions, viewer | [Plugin storage](docs/structure/plugin-storage.md) | Extensions, client/server storage |
| Cards, personas, packages, Realm, character interchange | [Characters and personas](docs/structure/characters-personas.md) | Media, memory, presets |
| Lore activation, Hypa V3, embeddings, modules | [Memory and lorebook](docs/structure/memory-lorebook.md) | Chat pipeline, characters |
| CBS, regex, triggers, Lua, plugin lifecycle, MCP | [Scripting and extensions](docs/structure/scripting-extensions.md) | Chat pipeline, providers, plugin storage |
| Translation, TTS, inlays, image generation, sounds | [Media and translation](docs/structure/media-translation.md) | Chat pipeline, server backend |

## Run and verify

Use pnpm 10.34.1 and Node 22.12 or newer; Node 24 is recommended and used by current
Docker/release builds. The five test commands below are separate suites—there is no
aggregate `test:all` command.

| Command | Purpose |
|---|---|
| `pnpm dev` | Frontend-only Vite server on `0.0.0.0:5174` with a strict port; no `/api` proxy |
| `pnpm build` | Production build with sourcemaps to `dist/` |
| `pnpm preview` | Preview the built frontend; still no backend API |
| `pnpm runserver` | Start Express from the repository root; serves `dist/` on `$HOST:$PORT` (default port 6001) |
| `pnpm check` | Svelte and TypeScript diagnostics |
| `pnpm check:help` | Validate localized help-key coverage |
| `pnpm test` | Browser/client unit tests under `src/` in happy-dom |
| `pnpm test:server` | Node server unit tests with real `better-sqlite3` |
| `pnpm test:compat` | Real-server storage/interchange integration tests: imports, exports, atomicity, caches, plugin storage |
| `pnpm test:performance` | Isolated performance suite, run with resource cache disabled and enabled |
| `pnpm test:performance:extreme` | Opt-in 448 MiB plugin transition stress test targeting roughly 2 GiB peak RSS; performs memory/disk preflight and never runs from the default performance command |

The upstream-backup fixture suite runs only when the ignored local file
`test/fixtures/upstream/upstream-backup.bin` is supplied. Most `test/compat/` coverage
tests PocketRisu persistence and interchange behavior, not execution inside upstream.

## Architecture at a glance

```text
Browser client (src/)                         Node server (server/node/)
┌───────────────────────────────┐   HTTP/WS   ┌──────────────────────────────────┐
│ index.html → src/main.ts      │ ─────────── │ server.cjs (Express)             │
│ → App.svelte + loadData()     │  /api/*     │ ├ SQLite KV + protected chunks  │
│ stores/runes select screens   │  /proxy2    │ ├ chats/* + pluginsave/* rows   │
│                               │  WS jobs    │ ├ assets/inlays/history files   │
│ DBState.db holds placeholders │             │ └ pins/spools/backups/recovery  │
│ NodeStorage-backed, KV-shaped │             │                                  │
│ server storage API            │             │ logs.cjs → save/logs.db         │
│ optional verified IDB cache   │             │                                  │
└───────────────────────────────┘             └──────────────────────────────────┘
```

- The browser holds the whole `Database` proxy in `DBState.db`. Unopened chats are
  runtime `_placeholder` objects; full bodies hydrate lazily. Database persistence
  replaces every chat with a wire `_stub` and saves authoritative chat rows first.
- The opt-in IndexedDB resource cache stores verified, hash-addressed bytes plus
  resource manifests. It is disposable; the Node server remains authoritative.
- Model traffic goes directly from the browser when allowed or through `/proxy2`.
  Classic OpenAI-style local streaming can use restricted WebSocket proxy jobs with
  `/proxy2` fallback. ModelPreset and non-streaming local requests use `/proxy2`.
- `server/hono/` remains a non-functional scaffold. The production server treats
  `process.cwd()` as the application root and does not load `.env` itself.
- Remote non-localhost use requires a secure browser context by default. Use HTTPS;
  `POCKETRISU_ALLOW_INSECURE_CONTEXT` is an explicit operator escape hatch.

## Directory map

| Path | Contents |
|---|---|
| `src/ts/` | Application logic grouped by domain |
| `src/lib/` | Svelte screens, settings, sidebars, mobile shells, and shared UI |
| `src/styles/`, `src/styles.css` | Theme/layout CSS, including the default Node-only presentation |
| `src/lang/`, `src/etc/docs/` | UI translations and embedded help content |
| `server/node/` | Production Express backend and storage/recovery modules |
| `server/hono/` | Incomplete multi-runtime scaffold |
| `shared/` | Contracts consumed by both client and server, currently plugin key policy |
| `docs/structure/` | This architecture guide's subsystem references |
| `docs/audit/`, `.archived-docs/` | Point-in-time risk reports and historical material, not canonical architecture |
| `test/compat/` | Real-server integration and storage/interchange regressions |
| `test/performance/` | Resource-cache and storage performance scenarios |
| `scripts/` | Portable/Termux build helpers, updater, and verification scripts |
| `public/` | Static files copied into the frontend build |
| `util/` | Legacy/upstream userscript support; not part of the PocketRisu runtime |

## Core runtime flows

### Send a message

`DefaultChatScreen.sendMain()` handles commands and input transforms, then
`sendChatMain()` owns the UI generation lock and delegates to `sendChat()` in
`src/ts/process/index.svelte.ts`. The process layer assembles prompt buckets, lore,
memory, attachments, and token budgets; `requestChatData()` applies request hooks,
classic-versus-ModelPreset dispatch, retries, and provider/tool loops. Cumulative
response snapshots return through output transforms and triggers before the save loop
persists the mutation. See [chat pipeline](docs/structure/chat-pipeline.md),
[model providers](docs/structure/model-providers.md), and
[scripting and extensions](docs/structure/scripting-extensions.md).

### Persist database and chat state

Ordinary UI code mutates `DBState.db`. `saveDb()` tracks deep reactive reads, stages
changed chat bodies to `/api/chat-content`, then commits the stubs-only database through
JSON Patch or an ETag-guarded full write. Generation checkpoints can persist active chat
rows before final completion. Plugin storage, drafts, assets, inlays, and destructive
recovery use explicit protocols rather than this implicit save loop. See
[client storage](docs/structure/client-storage.md),
[server backend](docs/structure/server-backend.md), and
[plugin storage](docs/structure/plugin-storage.md).

### Extend behavior

CBS expressions, regex scripts, Lua/triggers, JavaScript plugins, and MCP tools enter at
different lifecycle points. For `processScriptFull()`, Lua runs first; display triggers
run only for `editdisplay`; plugin handlers, CBS, and regex scripts follow. V2/V2.1
plugins execute in the page realm with compatibility guards; V3 plugins use an iframe
bridge and permissioned host APIs. See
[scripting and extensions](docs/structure/scripting-extensions.md).

### Export, import, and recover

Full/server exports require a valid live database and every referenced chat, then bind a
pinned WAL view to verified private filesystem copies. Partial exports and automatic
snapshots have explicit recovery-oriented missing-chat policies. Destructive imports and
restores stage bounded input behind the import barrier and report committed,
not-committed, or unknown outcomes. See
[backup and recovery](docs/structure/backup-recovery.md).

## Vocabulary that prevents expensive mistakes

| Term | Meaning |
|---|---|
| `chaId` | Durable character ID and first component of a chat-row key |
| `Chat.id` | Durable conversation ID used by chat rows, drafts, history, and caches |
| `Message.chatId` / request `arg.chatId` | Generation ID used by status/logging flows |
| Numeric script/parser `chatID` | Message-array index, not a durable conversation ID |
| `ModelPreset` | Installed model configuration with a frozen profile snapshot and per-chat binding |
| Prompt preset / `botPreset` | RisuAI-format prompt template selected through `botPresetsId` |
| Ordinary asset | `assets/*`; safe names are normally files under `save/assets/` |
| Inlay | `inlay/*` payload/sidecar plus `inlay_meta/*` ownership metadata |

## Cross-cutting contracts

### Persistence and identity

- Chat placeholders must hydrate before message access. `_stub` is the wire marker;
  `_placeholder` is the browser-runtime marker. Guard layers that prevent message loss
  are intentional.
- Stable IDs and persisted numeric enums are compatibility contracts. Append enum values;
  never renumber them. Where selectors intentionally remain index-based—such as
  `botPresetsId`, `selectedPersona`, or `character.chatPage`—use their reorder/delete
  helpers so references move together.
- The public streaming iterator consumed by `sendChat()` yields cumulative snapshots.
  Provider and adapter parsers may handle deltas internally but must accumulate at that
  boundary. Output hooks therefore need to be repeat-safe.
- `requestImmediateSave()` returns an outcome. Code that requires durability must confirm
  `committed` or use the committed-save helper; merely awaiting the call is insufficient.

### Client/server storage protocols

- Chat metadata allowlists, patch normalization/hashing, and RisuSave constants have
  coordinated client/server implementations. The plugin key policy is centralized in
  `shared/plugin-save-key-policy.json`; other paired contracts still require lockstep
  changes.
- Browser caches are non-authoritative. Cache hits, segmented DB assembly, and list deltas
  must fall back to a full authoritative read on malformed, missing, stale, or
  unverifiable state.
- The latest `/api/session` caller owns mutation rights. A displaced writer receives 423
  and must reload or enter the frozen read-only recovery UI; stale dirty state must not be
  replayed over the new writer.
- Runtime KV/chat-row/asset/inlay mutations that can overlap a destructive import must use
  the storage queue. The held import transaction and startup recovery are deliberate,
  bounded exceptions.

### Plugin publications

- Optimized plugin storage is one generation-bound publication: database mode and
  `pluginStorageGeneration`, `plugin-storage/manifest.json`, value rows, and owner rows
  move together. Prefix rows absent from the matching manifest are quarantined physical
  data, not current state.
- Use the dedicated versioned mutation, batch, generation, and staged-transition APIs
  for optimized rows and publication controls. Generic KV writes never mutate those
  roots. Ordinary database patches may update the inline value/owner maps only after
  the server proves that the live authoritative mode is inline.
- Never replay a storage or destructive-replacement request whose commit outcome is
  unknown. Re-read or reload authoritative state and reconcile first.

### Backup, import, and compatibility

- Full and server-file exports require a valid live database and all referenced chats.
  Automatic snapshots and partial jobs deliberately preserve a bare stub for an already
  missing chat so damaged state still has a recovery point.
- Full exports combine one pinned SQLite view with verified private filesystem copies.
  Database assembly uses `POCKETRISU_SPOOL_DIR` or `save/.spool`; filesystem pins remain
  under `save/.partial-export-spool`.
- Imports are exclusive replacement transactions. Bounded ingress/staging, the abortable
  import barrier, SQLite transaction, and filesystem swap journal are one safety protocol.
- Upstream migration exports are intentionally lossy for PocketRisu-only inlays. RisuAI
  quirks such as `extentions`, RPack framing, legacy save fallbacks, and index-based
  `botPresetsId` are deliberate data-format contracts. The mutating `GET /api/remove` is
  a separate PocketRisu browser/server compatibility contract.

### Frontend conventions

- Svelte 5 runes and classic writable stores coexist. Non-component TypeScript modules
  that use runes need the `.svelte.ts` suffix. UI code binds directly into `DBState.db`,
  and the save loop depends on `deepTouch()` establishing deep reactive dependencies.

## Documentation maintenance

Approximate file sizes were removed from the root map because fast-moving storage and
plugin modules made them misleading. When code moves, prefer updating symbol ownership
and change maps over refreshing every line number. Treat `docs/audit/` findings as
historical evidence whose resolution must be checked against current code.
