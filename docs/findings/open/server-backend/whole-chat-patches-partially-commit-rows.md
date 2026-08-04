# Whole-chat patches can partially commit external rows

- Status: Open
- Severity: High
- Owner: server backend
- Source reports: [data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/reports/whole-chat-patches-half-apply-external-rows.md), [compatibility investigation](../../../../.archived-docs/findings/2026-07-compatibility/reports/whole-chat-patch-partially-commits-rows.md)

## Risk

The compatibility-shaped `/api/patch` request still accepts payload-bearing
whole-chat replacements. Chat bodies are externalized through independent row
writes before the stub database is published. A later row failure returns 500
with an earlier prefix already committed; a later debounced database failure can
also leave old stubs resolving to newly overwritten rows. Those overwritten rows
do not receive the pre-images captured by `/api/chat-content`.

The official client normally sends stubs and separate row writes, so the risk is
limited to retained legacy or external callers.

## Required fix and coverage

Reject payload-bearing whole-chat patch operations in favor of
`/api/chat-content`, or stage every row and the stub graph in one synchronous
transaction. Inject failure on the second of two row writes and require neither
row nor the stub database to change.
