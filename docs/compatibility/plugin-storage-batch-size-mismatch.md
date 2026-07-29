# Safe plugin-storage update APIs cannot handle values accepted by setItem

- Status: Confirmed internal contract mismatch
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
