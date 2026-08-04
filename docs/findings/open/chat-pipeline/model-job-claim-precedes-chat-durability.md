# Live model-job claim precedes chat-row durability

- Status: Open
- Severity: Warning
- Owner: chat pipeline
- Source: [delta audit DA-5](../../../../.archived-docs/findings/2026-08-delta-audit/02-findings.md#da-5-live-model-job-claim-precedes-chat-row-durability-d-f1)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

Fast server-side completions claim the job and remove the pending-send
tombstone before the debounced chat save commits. Losing the tab in that window
can strand the reply beyond both recovery paths.

Place job claim and tombstone deletion behind a committed-save barrier and test
tab loss at each ordering boundary.
