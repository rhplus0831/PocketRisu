# Persona exports silently drop advanced persona data

- Status: Open
- Severity: Low
- Area: import/export round-trips
- Affected code: `src/ts/persona.ts:50-101` (export card = name/prompt/note only), `src/ts/characterPackage.ts:103-129`, `src/ts/characterPackage.ts:229-255`, `src/ts/characterPackage.ts:518-542` (package path also omits `embeddedModule`; `largePortrait` recorded but never applied), `src/ts/storage/database.svelte.ts` (`RisuPersona` defines `largePortrait`, `embeddedModule`)

## Risk

A persona with `largePortrait` or an `embeddedModule` (lore, regex, triggers,
assets) exports through Persona Settings or character packages as only
name + prompt + note (+icon). Import reports success and silently produces an
incomplete persona; moving to a fresh installation via these paths loses the
embedded module permanently. Full backups are unaffected.

## Required fix and coverage

Version the persona payload and serialize every `RisuPersona` field (including
embedded-module assets); apply `largePortrait` on import. Add a round-trip
test over all fields.
