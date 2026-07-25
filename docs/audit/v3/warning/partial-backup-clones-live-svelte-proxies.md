# Partial backup clones live Svelte proxies

- Status: Open
- Severity: Medium
- Lens: L2
- Area: Areas 3 and 6 — client serialization and recovery
- Affected code: `src/ts/storage/database.svelte.ts:749-753`, `src/ts/drive/backuplocal.ts:105`, `src/ts/drive/backuplocal.ts:193`, `src/ts/drive/backuplocal.ts:219-224`; runtime reproduction and test gap: `src/ts/drive/backuplocal.ts:97-105`, `src/ts/drive/backuplocal.ts:162-224`, `src/ts/storage/database.svelte.ts:745-753`, `src/ts/drive/backuplocal.test.ts:48-50`, `src/ts/drive/backuplocal.test.ts:84-95`

## Risk

`SavePartialLocalBackup()` reads the live deeply reactive database and shallowly
spreads only its root before calling native `structuredClone()`. Nested character,
chat, persona, preset, and plugin-storage proxies remain, so structured clone
throws `DataCloneError` in the installed Svelte runtime.

The throw occurs after the writer opens and selected assets may be streamed, but
before the optimized plugin-storage fold and `database.risudat` write. Partial
backup is therefore unusable for a normal runes database and can leave an open
or incomplete archive. Unit tests miss it because they mock plain database
objects rather than a real nested Svelte proxy.

## Required fix and coverage

Start from `getDatabase({ snapshot: true })` before opening the writer, and abort
or close the output on every later failure. This is a quick one-line ownership
fix plus writer-lifetime hardening.

Add an integration test with a real nested `$state` proxy and require a closed,
decodable archive containing `database.risudat`.
