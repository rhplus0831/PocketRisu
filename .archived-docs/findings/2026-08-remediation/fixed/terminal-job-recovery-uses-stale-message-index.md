# Terminal job recovery can overwrite a newer generation by stale index

- Status: Fixed (2026-08-07 remediation queue)
- Owner: chat pipeline
- Source: [delta audit DA-6](../../2026-08-delta-audit/02-findings.md#da-6-terminal-job-recovery-can-overwrite-a-newer-generation-via-stale-index-d-f2)
- Severity: Warning (at fix time)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the
  [revalidation register](../../2026-08-revalidation/README.md)
- Resolution: this remediation commit — terminal recovery now acquires a
  background generation guard keyed by the durable `Chat.id` before any
  hydration or journal suspension. Running-job polling lends its exact existing
  background ownership to terminal slot-in; unrelated live or background
  owners defer recovery, and cleanup releases only the ownership token acquired
  by that path. After journal replay, recovery re-locates the current hydrated
  chat and resolves the job through `generationInfo.generationId` or the stable
  message-level `chatId` before deciding whether to fill or insert. No numeric
  message index crosses the journal await. Existing longer text, failed-job
  handling, idempotent retry, save-before-claim ordering, and unclaimed
  save-failure behavior remain unchanged.
- Regression coverage: `src/ts/process/request/jobRecovery.test.ts` delays the
  journal response, replaces the entire chat/message slot with a newer
  generation during suspension, and proves the current message survives while
  the recovered identity is inserted into and saved from the re-resolved chat.
  It also proves the terminal background guard spans the suspension and is
  cleaned up afterward, while an unrelated background owner causes recovery to
  defer without reading, claiming, or releasing that owner. The existing
  recovery suite continues to cover continuation dual identity, partial fills,
  longer-text preservation, failed jobs, hydration/proxy writes,
  save-before-claim retries, live-owner races, and running-job polling.
- Canonical architecture: [chat pipeline](../../../../docs/structure/chat-pipeline.md),
  coordinated with [client storage](../../../../docs/structure/client-storage.md)

## Original risk (historical)

Job recovery captured a message index, awaited the journal, and later replaced
by that index without rechecking chat or generation identity. A reroll that
finished during the await could be replaced by older journal text and then
saved.

## Original required fix and coverage (historical)

Resolve the target by generation identity after every await and apply the
terminal result under a per-chat generation guard.
