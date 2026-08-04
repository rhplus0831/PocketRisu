# Terminal job recovery can overwrite a newer generation by stale index

- Status: Open
- Severity: Warning
- Owner: chat pipeline
- Source: [delta audit DA-6](../../../../.archived-docs/findings/2026-08-delta-audit/02-findings.md#da-6-terminal-job-recovery-can-overwrite-a-newer-generation-via-stale-index-d-f2)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

Job recovery captures a message index, awaits the journal, and later replaces
by that index without rechecking chat or generation identity. A reroll that
finishes during the await can be replaced by older journal text and then saved.

Resolve the target by generation identity after every await and apply the
terminal result under a per-chat generation guard.
