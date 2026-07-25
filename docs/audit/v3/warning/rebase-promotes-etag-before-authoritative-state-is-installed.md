# Rebase promotes the ETag before authoritative state is installed

- Status: Open
- Severity: Medium
- Lens: D6, L4
- Area: Area 4 — client↔server sync protocol
- Related: [A patch conflict promotes the ETag and authorizes a stale full write](../../v2/fatal/patch-conflict-etag-promotion-enables-stale-full-write.md) — same authorization-token defect on a different path (full-write rebase/read, not patch 409)
- Affected code: `src/ts/globalApi.svelte.ts:706-778`, `src/ts/globalApi.svelte.ts:1017-1024`, `src/ts/globalApi.svelte.ts:1072-1083`, `src/ts/storage/nodeStorage.ts:353-364`, `src/ts/plugins/pluginSaveStorage.ts:177-180`, `server/node/server.cjs:4232-4241`, `server/node/server.cjs:4324-4335`

## Risk

On a full-write conflict, `rebaseTrackedLocalChangesOnLatestServerDb()` calls
`setDbEtag(conflictEtag)` as its first statement, before the authoritative body
has been fetched, decoded, merged, and installed. `NodeStorage.getItem()`
independently repeats the ordering: it stores `x-db-etag` from the response
headers before awaiting the body.

Any mid-rebase failure — fetch body, decode, clone, `setDatabase()`, or
encoder/patcher reinitialization — exits with the fresh ETag installed while the
stale local database remains active, and the retry handler never rolls the ETag
back. A subsequent forced full write skips patch/hash validation and submits the
stale graph under the promoted ETag; the server's `If-Match` accepts it, so
another client's characters and stubs can be replaced and their rows deleted.
Plugin-memory mode reconciliation is a production caller of
`requestImmediateSave({ forceFullWrite: true })`.

## Required fix and coverage

Treat the conflict ETag as a local candidate and publish it only after the
authoritative body is fully read, decoded, merged, installed, and both baselines
reinitialize successfully. On any rebase failure, restore the last ETag actually
paired with the local baseline, or clear it so no forced write carries
authorization.

Test a rebase whose authoritative GET fails mid-body, followed by a forced full
write, and require the server to reject it.
