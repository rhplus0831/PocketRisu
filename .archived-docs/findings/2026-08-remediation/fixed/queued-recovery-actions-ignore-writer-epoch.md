# Queued plugin-recovery actions are not bound to the writer epoch

- Status: Fixed (2026-08-05 remediation queue)
- Owner: plugin storage
- Source: [delta audit DA-16](../../2026-08-delta-audit/02-findings.md#da-16-queued-recovery-actions-are-not-re-bound-to-the-writer-epoch-c-f4)
- Severity: Warning (at fix time)
- Resolution: `3d7e7fb6` — the resolve route captures the admitted session
  identity (id, user-active flag, writer epoch) and revalidates it through the
  shared session-lock check inside the queued callback, after the inspection
  await and immediately before the destructive mutation, rejecting 423
  `SESSION_DEACTIVATED` (definitive not-committed) on mismatch; the recovery
  token HMAC additionally binds the process writer epoch. Session-less legacy
  clients keep their prior behavior.
- Regression coverage: `test/compat/plugin-storage-boot-reconcile.test.ts` —
  stale-epoch admission reject, happy-path resolve, and the queued-takeover
  race (HTTP/1.1 pipelining pins admission order; the inlay publish gate holds
  the mutation queue open across the takeover).
- Canonical architecture: [plugin storage](../../../../docs/structure/plugin-storage.md)

## Original risk (historical)

Destructive recovery checks the session before queueing, but the queued
callback does not revalidate ownership and the recovery HMAC binds no writer
epoch. A takeover between admission and execution can interleave stale-session
writes with recovery publication.

## Original required fix (historical)

Bind the request and recovery token to a writer epoch, then revalidate inside
the queued callback and return 423 on mismatch.
