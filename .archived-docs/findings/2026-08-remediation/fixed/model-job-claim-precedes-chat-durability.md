# Live model-job claim precedes chat-row durability

- Status: Fixed (2026-08-07 remediation queue)
- Owner: chat pipeline
- Source: [delta audit DA-5](../../2026-08-delta-audit/02-findings.md#da-5-live-model-job-claim-precedes-chat-row-durability-d-f1)
- Severity: Warning (at fix time)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the
  [revalidation register](../../2026-08-revalidation/README.md)
- Resolution: this remediation commit — live main-job transports hand terminal
  done/failed jobs to the send owner instead of claiming at raw journal EOF.
  Terminality is tracked separately from successful chat publication: throws,
  post-EOF processing failures, aborts, and connection loss never unlock
  cleanup. A published outermost send explicitly marks its exact chat dirty,
  forces an immediate durable save with generation-checkpoint throttling
  disabled, and requires a `committed` outcome before it claims terminal jobs
  and generation-conditionally deletes its tombstone.
  Retry, failed, displaced, rejected, claim-failure, and delete-failure outcomes
  retain a recovery path. Exact live ownership also defers concurrent terminal
  discovery through both the server-terminal/transport-EOF race and recursive
  auto-continue/resend chains. No-terminal direct/proxy conclusions remain
  fire-and-forget, auxiliary jobs retain their prior behavior, and the chat UI
  no longer performs cleanup outside this contract. Main-job connection-loss
  failures retain a typed recoverable disposition across the adapter/request
  boundary instead of entering ordinary retry cleanup; unrecoverable auxiliary
  jobs retain their existing ordinary retry/fallback policy. Failed resends preserve the
  original message identity while stamping the current failed generation for
  idempotent recovery.
- Regression coverage: `src/ts/process/request/liveModelJobFinalization.test.ts`
  proves save-before-claim-before-delete ordering, recovery-artifact retention
  for every non-committed save outcome, and exactly-once post-commit cleanup;
  `src/ts/process/request/liveModelJobSend.test.ts` covers exact-row dirty
  marking and a real forced chat-row write despite a recent generation
  checkpoint, non-streaming and streaming post-EOF publication failures,
  abort/connection-loss retention, recursive latest-generation ownership, and
  claim/delete cleanup failures, direct/proxy no-terminal behavior, and failed
  resend dual identity; `src/ts/process/request/modelJobDisposition.test.ts`
  covers typed direct/wrapped main connection-loss retry bypass and rethrow,
  plus unchanged auxiliary retry/fallback classification;
  `src/ts/process/request/jobRecovery.test.ts` covers terminal discovery races
  and two-generation idempotent recovery; `src/ts/process/request/pendingSends.test.ts`
  and `server/node/model-jobs.test.ts` cover acknowledged generation-aware
  deletion and cross-generation replacement; and
  `src/ts/process/request/jobFetch.test.ts` covers deferred done/failed main-job
  handoff and unchanged auxiliary immediate claims.
- Canonical architecture: [chat pipeline](../../../../docs/structure/chat-pipeline.md),
  coordinated with [client storage](../../../../docs/structure/client-storage.md)

## Original risk (historical)

Fast server-side completions claimed the job and removed the pending-send
tombstone before the debounced chat save committed. Losing the tab in that
window could strand the reply beyond both recovery paths.

## Original required fix and coverage (historical)

Place live main-job claim and tombstone deletion behind a committed-save
barrier and test tab loss at each ordering boundary.
