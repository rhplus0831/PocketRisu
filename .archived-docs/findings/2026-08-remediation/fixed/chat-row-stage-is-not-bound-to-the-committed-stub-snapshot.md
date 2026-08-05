# Chat-row staging is not bound to the committed stub snapshot

- Status: Fixed (2026-08-05 remediation queue)
- Owner: server backend
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: High (at fix time)
- Resolution: `73d5c87e` — the persist stage loops row discovery: after each
  awaited row batch it rediscovers the full live graph
  (`rediscoverUnbackedFullChats` — full-bodied, non-placeholder chats without
  durability proof; wire stubs are never row-written) and writes what
  appeared, until clean or a bounded cap requeues and refuses the stub
  commit. `saveDb` adds a synchronous dispatch guard on the patch and
  full-write paths — after the payload is computed, with no awaits before
  dispatch, any unbacked chat discards the payload and retries — so nothing
  the payload could contain is published unbacked. The `/api/db/optimize`
  orphan sweep captures a forced, required `orphan-sweep` pre-image per row
  and skips rows whose capture fails: no chat row is unlinked without a
  durable recovery copy. The revision-bound staged-commit protocol the report
  offered as an alternative was deliberately not built — the loop + guard
  enforce the same invariant client-side, and the sweep backup provides the
  durable row-success/stub-failure recovery record.
- Regression coverage: `src/ts/storage/chatPersistStage.test.ts` (chat created
  during a paused row write; rediscovery predicate; non-convergence refuses
  the commit), `test/compat/db-chunking.test.ts` (byte-exact restore of a
  swept orphan from the chat-backups store; capture-failure leaves the row),
  `server/node/chatRows.test.ts` (sweep capture wiring).
- Canonical architecture: [server backend](../../../../docs/structure/server-backend.md)

## Original risk (historical)

The client discovers a fixed set of chat rows, awaits their POSTs, and only
then encodes the still-live database. A chat created during an earlier slow
row POST can therefore appear in the committed stub graph without having been
in the row candidate set. Reload turns it into a placeholder whose content
request is 404.

The reverse direction is also non-atomic: a row may become durable before
encoding or stub publication fails. Its only recovery reference then lives in
the current page's retry queue; after client loss it is orphaned, and the
server sweep deletes it after the one-hour grace period. Synchronous patch
durability alone would not close either mismatch.

## Original required fix (historical)

Bind row staging and stub publication to one immutable database revision, and
repeat discovery after awaited batches until that exact stub graph is
row-backed. Use a server-side staged transaction/commit token or durable
reconciliation record for row-success/stub-failure recovery.
