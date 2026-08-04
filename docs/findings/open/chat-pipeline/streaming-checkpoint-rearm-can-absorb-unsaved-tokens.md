# Streaming checkpoint re-arm can absorb unsaved tokens

- Status: Open
- Severity: Warning
- Owner: chat pipeline
- Source: [delta audit DA-8](../../../../.archived-docs/findings/2026-08-delta-audit/02-findings.md#da-8-post-snapshot-streaming-tokens-can-stay-unsaved-past-the-checkpoint-interval-b-f2)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

The active-chat tracker re-arms its timer by touching the subscription without
queueing persistence. A token arriving in the dropped-subscription window can
become the new baseline, allowing a stalled generation and crash to lose the
coalesced tail.

Re-arming during a live generation must queue another checkpoint. Cover a
mutation at the subscription handoff boundary.
