# Draft-save failures have no retry or user signal

- Status: Open
- Severity: Warning
- Owner: client storage
- Source: [delta audit DA-9](../../../../.archived-docs/findings/2026-08-delta-audit/02-findings.md#da-9-draft-save-failures-are-swallowed-with-no-retry-or-signal-s)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

A failed draft write is silently dropped. Leaving the page afterwards can lose
the composer draft with no retry and no visible indication that persistence
failed.

Add bounded retry and surface a composer persistence indicator after repeated
failure.
