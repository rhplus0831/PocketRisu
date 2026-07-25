# Inlay compression can overwrite files an import just replaced

- Status: Open
- Severity: Low
- Area: server file stores / import barrier
- Affected code: `server/node/server.cjs:6777-6787` (single request-scope barrier check), `server/node/server.cjs:6800-6836` (long async sweep; `writeInlayFile` called outside the storage queue), `server/node/server.cjs:2958-3003` (import swaps the inlay directory)

## Risk

Bulk compression checks the import barrier once at request start, then reads,
converts, and rewrites inlays across many awaits, with only the thumbnail
`kvDel` inside the storage queue. An import that starts mid-sweep swaps in a
replacement inlay directory; the compression loop then publishes bytes
derived from the *pre-import* file over the imported one via the direct
`writeInlayFile` call. The imported image is silently replaced by a stale
compressed version. Requires an import racing an active compression sweep.

## Required fix and coverage

Hold a maintenance lease that excludes imports for the whole sweep, or
perform each read-validate-write cycle inside a queue boundary the import
must drain, revalidating the source bytes before publication.
