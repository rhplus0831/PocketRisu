# A patch conflict promotes the server's ETag and authorizes a stale full write

- Status: Open
- Severity: High
- Area: client save loop / sync protocol
- Affected code: `src/ts/storage/nodeStorage.ts:596-608` (409 `currentEtag` stored into `_lastDbEtag`), `src/ts/globalApi.svelte.ts:980-1013` (full-write fallback uses the promoted ETag; rebase only on `ConflictError`), `server/node/server.cjs:4232-4241` (`/api/write` accepts a matching ETag), `server/node/server.cjs:4326-4335` (`deleteRemovedChatRows` in the same transaction)

## Risk

The lost-update protection has two layers: `/api/patch` verifies
`expectedHash` against the client's baseline, and `/api/write` verifies
`x-if-match` against the server's current ETag. The client wires them together
in a way that defeats both.

When a patch fails with 409 (the server's database changed relative to this
tab's baseline — a snapshot restore, another device or tab, an import),
`patchItem()` stores the conflict response's `currentEtag` into `_lastDbEtag`
and returns failure. The save loop's fallback then submits the client's
**entire stale in-memory database** as a full write using exactly that
freshly-adopted ETag. The `If-Match` check passes by construction, the stale
graph replaces the newer server state, and `deleteRemovedChatRows()` deletes —
in the same transaction — every chat row the newer graph referenced but the
stale graph does not.

`rebaseTrackedLocalChangesOnLatestServerDb()` exists precisely for this
situation, but it is invoked only when the full write itself returns a
conflict, which the promotion makes impossible. In practice, every
patch-hash mismatch escalates to "force-push my copy".

Concrete trigger: a second tab or device restores a snapshot / imports a backup
/ simply saves; the first tab's next debounced save (or its unload save) hits
the hash mismatch and silently overwrites the restored state, deleting chats
created since its baseline. Automatic DB snapshots (5-minute cooldown, DB-only)
are the only recourse.

## Required fix and coverage

Treat a patch-hash 409 as a mandatory rebase: re-fetch the authoritative
database, rebase tracked local changes onto it, and retry — never adopt the
conflict `currentEtag` as authorization for a full write of the stale image.
Destructive server-side operations (restore/import) should additionally
invalidate or quiesce client save loops before the client reloads.

Cover with a two-client compat test: client A loads state S; the server is
restored to R; A performs an edit; assert the server still contains R's
chats with A's edit rebased (or A's write rejected), not S.
