# Test coverage gaps

- Source: Area 8 — mode matrix and round trips

Blank coverage cells identify combinations likely to admit an L3 regression;
they are not additional findings.

## Compatibility coverage map

| Surface / combination | Coverage present | Missing |
|---|---|---|
| Ordinary full `.bin` DB/assets/cold storage/NDJSON | `backup-roundtrip`, `coldstorage`, `db-chunking`, `stream-risu-*` | Browser-local stores and chat-version history are outside the fixture model |
| Upstream → Pocket | `upstream-import.test.ts` exists | `test/fixtures/upstream/upstream-backup.bin` is absent/untracked, so the whole describe is skipped (`upstream-import.test.ts:17-27`) |
| Pocket upstream-target → upstream | Pocket test asserts namespace omission and normalized DB equality (`backup-roundtrip.test.ts:355-411`) | Nothing invokes `/home/codex/Risuai`'s real loader or saves back from upstream; no inlay-bearing semantic compare |
| CCv2/CCv3 PNG, CharX, JSON, RCC | None in `test/compat/` | Every card round-trip, regex lore, non-media assets, image metadata/encoding, RCC corpus |
| Character packages | None | All option combinations; ID maps; inlay collisions; metadata; append vs replace |
| `.risup` | `preset-v4-roundtrip` covers a different ModelPreset `.bin` format | `.risup` codec and exhaustive `botPreset` field comparison |
| `.risum` / module CharX | None | `.risum` field/assets/ID compare; known v2 CharX fields remain excluded |
| Chat JSON/HTML/JSONL export/import | None | Every structured chat interchange path, duplicate IDs, empty/default fields, Unicode/HTML escaping, folders |
| Chat-version restore | Unit tests only | No server version capture → UI restore → save → reload compat test; v2 ack warning remains open |
| optimize off↔on | Strong unit ordering tests; steady-state backup/snapshot compat tests | Markerless just-disabled snapshot restored over newer optimized rows (confirmed finding); portable backup/export after N of M keys; rollback plus concurrent backup; viewer during transition |
| optimize × resource cache | Each has separate units | No combined test with cached `pluginsave/` read during internalization or disable/re-enable |
| resource cache toggle | Helper unit tests | No real IndexedDB epoch/stale-write transition; no server compat test |
| hub normal↔hub | Isolated hub and normal boots; hub spool/chat backups | No same-save-dir restart normal→hub→normal, no existing file backup/snapshot visibility/retention check, no portable restore in hub |
| monolith↔externalized chats | Strong streaming/in-memory/chunked/downgrade tests | Duplicate **stub** IDs and client interchange imports are absent |
| backup A→B matrix | optimize, chunks, monolith substantially covered | Resource-cache state, hub state, image flags, local/IDB plugin state, chat-backup roots/caps, card/package modes |
| Persistence-shape flag pairs | Some optimize+chat/plugin snapshot fixtures | No pairwise matrix. In particular: optimize×resource cache, hub×portable restore, allow-all×CharX, image-compression×all card/module formats, package chat-ID remap×inlay metadata |

## Flag interaction sweep

| Pair | Was the combination considered? | Result |
|---|---|---|
| optimize × resource cache | Partially in production code: only optimized value reads request `{cached:true}` (`pluginSaveStorage.ts:71-84`), and cached KV requires server hash confirmation (`nodeStorage.ts:372-415`) | Sound statically; no combined transition test |
| optimize × plugin version | Explicit eligibility and runtime guards (`PluginSettings.svelte:40-45,118-120`; `plugins.svelte.ts:446-467`) | Considered; impossible imported combination degrades by not running legacy plugin, not by deleting its data |
| optimize × snapshot / Node-only / upstream backup | Explicit fold/independent-entry branches (`server.cjs:2490-2569,4715-4759,4980-4988`) and strong steady-state tests | Portable and upstream content is complete, but the automatic-snapshot ownership marker follows the post-toggle flag instead of the folded row set. **The enabled→disabled transition was not considered together with a later cross-mode restore; confirmed warning finding** |
| optimize × chat externalization | One streaming save assembles chats and optionally plugin rows (`streamRisuSave.cjs:88-137`) | Considered; atomic/full backup tests exist |
| hub × server backups/snapshots | Explicit route gates and cap pinning | Considered; transition visibility/retention on one save is untested |
| hub × chat backups | Chat backups deliberately live under writable `save/` and continue in hub (`server.cjs:976-989`; `hub-hosting.test.ts:36-61`) | Considered and tested |
| hub × portable backup restore | No hub gate on portable export/import | Appears sound, but clearly lacks a combined test |
| backup restore × resource cache | Cache is outside import; every hit remains server-hash-authorized | Considered by protocol, not by integration test |
| plugin save/local/IDB × snapshot folding | Sidecars explicitly follow their backend (`pluginStorageMeta.ts:1-18`); fold enumerates only save prefixes | Considered as travel semantics; full-backup UI does not enumerate device-local data |
| allow-all extensions × CharX `.json` classification | Picker and exporter allow it, importer blanket-ignores suffix | **Clearly not considered together; confirmed warning finding** |
| image compression × PNG/JSON/CharX/module assets | All formats call the same `compressImage`; help text warns about image compression | Byte divergence is intentional, but no semantic/animated-image cross-format test |
| character-package chat ID remap × inlay metadata | Separate loops with no shared map (`characterPackage.ts:277-284,367-385`) | **Clearly not considered together; confirmed warning finding** |
| HTML import × externalized chat-row identity | HTML keeps ID while row persistence de-duplicates by ID | **Clearly not considered together; confirmed fatal finding** |
| upstream target × inlay/signature stores | Explicitly omitted in server comments, but chat reference integrity is not transformed/tested | Known limitation in code, not presented as a lossy semantic transition to the user |
