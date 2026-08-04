# Build-mismatch reload can discard an undurable composer draft

- Status: Open
- Severity: Warning
- Owner: client storage
- Source: [delta audit DA-12](../../../../.archived-docs/findings/2026-08-delta-audit/02-findings.md#da-12-build-mismatch-reload-can-discard-an-undurable-composer-draft-a-f1)

The HTTP 426 dirty probe checks database dirtiness but not composer text, draft
timers, or the draft-write queue. A deployment can therefore classify the page
as clean and reload while recently typed text is still undurable.

Include nonempty composer state and pending, in-flight, or failed draft
persistence in the shared dirty probe.
