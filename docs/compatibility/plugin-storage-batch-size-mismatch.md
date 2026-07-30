# Safe plugin-storage update APIs cannot handle values accepted by setItem

- Status: Fixed 2026-07-30
- Severity: Medium
- Confidence: High

## Difference

serve's optimized setItem() accepts a value up to the default 128 MiB
per-value limit. atomicBatch(), rewriteItem(), and updateItem() base64-encode
values into a JSON request with a hard 16 MiB body limit in
src/ts/storage/pluginStorageBatch.ts. Base64 and envelope overhead reduce the
effective single-value ceiling to roughly 12 MiB.

These safe/versioned APIs are new on serve, but they are advertised alongside
setItem() for the same logical storage. Their narrower transport cannot operate
on all valid existing rows.

## Compatibility impact

A plugin can successfully store a value, then be unable to update it with
compare-and-swap, rewrite it, or include it in an atomic batch. The failure
appears only when adopting the safer mutation API and is far below the
advertised per-value capacity.

## Recommendation

Use streamed binary request framing or derive every mutation limit from the
same negotiated capability. Report operation-specific limits before encoding
and test one value across setItem, getItem, rewriteItem, updateItem, and
atomicBatch at the shared boundary.

## Resolution

The authenticated session now advertises the server's framed-batch operation,
metadata, per-value, and aggregate payload limits. New clients use a `framed-v1`
request consisting of bounded canonical JSON metadata followed by raw JSON value
bytes. Each value is bound into the request by its byte length and SHA-256 digest,
so the acknowledgement remains request-specific without base64 expansion.

The server streams every value into a private spool, verifies its declared length
and digest, validates JSON from the staged file, and only then enters the storage
mutation queue. Revision and manifest CAS checks still precede one SQLite
transaction; large values publish through the existing file-backed chunk writer.
Failed ingress, conflicts, transaction rollbacks, and lost connections clean the
private stage without exposing a live prefix. Servers that do not advertise the
framing capability retain the legacy 16 MiB JSON/base64 fallback.

Coverage includes a real 13 MiB value (above the old effective ceiling), negotiated
capabilities, malformed hash rejection, staged revision conflicts, transaction
rollback, spool cleanup, legacy framing, and client acknowledgement binding.
