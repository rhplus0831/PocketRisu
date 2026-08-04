# Build-mismatch reload can discard an undurable composer draft

- Status: Open
- Severity: Warning
- Owner: client storage
- Source: [delta audit DA-12](../../../../.archived-docs/findings/2026-08-delta-audit/02-findings.md#da-12-build-mismatch-reload-can-discard-an-undurable-composer-draft-a-f1)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

The HTTP 426 dirty probe checks database dirtiness but not composer text, draft
timers, or the draft-write queue. A deployment can therefore classify the page
as clean and reload while recently typed text is still undurable. Revalidation
found the scope has widened: the same draft-blind probe now also gates the
writer-epoch auto-reload added by `7dd00712`, so server restarts join
deployments as loss triggers.

Include nonempty composer state and pending, in-flight, or failed draft
persistence in the shared dirty probe.
