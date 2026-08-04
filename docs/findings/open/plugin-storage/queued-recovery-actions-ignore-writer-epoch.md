# Queued plugin-recovery actions are not bound to the writer epoch

- Status: Open
- Severity: Warning
- Owner: plugin storage
- Source: [delta audit DA-16](../../../../.archived-docs/findings/2026-08-delta-audit/02-findings.md#da-16-queued-recovery-actions-are-not-re-bound-to-the-writer-epoch-c-f4)

Destructive recovery checks the session before queueing, but the queued
callback does not revalidate ownership and the recovery HMAC binds no writer
epoch. A takeover between admission and execution can interleave stale-session
writes with recovery publication.

Bind the request and recovery token to a writer epoch, then revalidate inside
the queued callback and return 423 on mismatch.
