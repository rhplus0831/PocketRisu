# Whole-chat patches can partially commit external rows

- Status: Fixed (2026-08-05 remediation queue)
- Owner: server backend
- Source reports: [data-loss audit](../../2026-07-data-loss-audit/reports/whole-chat-patches-half-apply-external-rows.md), [compatibility investigation](../../2026-07-compatibility/reports/whole-chat-patch-partially-commits-rows.md)
- Severity: High (at fix time)
- Resolution: `6e6725e2` — `/api/patch` now rejects any resulting snapshot that
  contains a payload-bearing chat with a definitive 422
  `CHAT_PAYLOAD_PATCH_UNSUPPORTED` (not-committed, current ETag included)
  before plugin externalization, deletion tracking, or cache installation —
  the rejection path mutates nothing. Detection (`countPayloadChats`) is a
  pure scan because untouched patch subtrees stay reference-shared with the
  live cache. Rejection was chosen over transactional staging: the official
  client never sends payload chats through patches, and its existing
  full-write fallback — already row/stub transactional — engages on the
  non-success result, healing even a pathological cache atomically. The
  store's now-unreachable writing extractor was removed; `/api/write`'s
  transactional split path keeps the internal extractor.
- Regression coverage: `test/compat/database-write-atomicity.test.ts` (a patch
  bearing two payload chats commits nothing — no rows, database bytes and
  ETag unchanged; a payload overwrite leaves the authoritative row untouched;
  stub-only patches still succeed afterwards),
  `server/node/chatRows.test.ts` (detection criterion incl. hybrid
  stub+message bodies; non-mutation guarantee).
- Canonical architecture: [server backend](../../../../docs/structure/server-backend.md)

## Original risk (historical)

The compatibility-shaped `/api/patch` request still accepts payload-bearing
whole-chat replacements. Chat bodies are externalized through independent row
writes before the stub database is published. A later row failure returns 500
with an earlier prefix already committed; a later debounced database failure
can also leave old stubs resolving to newly overwritten rows. Those
overwritten rows do not receive the pre-images captured by
`/api/chat-content`. The official client normally sends stubs and separate
row writes, so the risk was limited to retained legacy or external callers;
the `x-client-build` admission gate added friction but not a barrier.

## Original required fix (historical)

Reject payload-bearing whole-chat patch operations in favor of
`/api/chat-content`, or stage every row and the stub graph in one synchronous
transaction. Inject failure on the second of two row writes and require
neither row nor the stub database to change.
