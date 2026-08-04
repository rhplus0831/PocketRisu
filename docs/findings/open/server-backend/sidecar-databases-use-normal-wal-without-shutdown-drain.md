# Sidecar databases use NORMAL WAL without a shutdown drain

- Status: Open
- Severity: Warning
- Owner: server backend
- Source: [delta audit DA-7](../../../../.archived-docs/findings/2026-08-delta-audit/02-findings.md#da-7-sidecar-dbs-reintroduce-normal-wal-rollback-shutdown-does-not-drain-d-f5)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

`model-jobs.db` and `request-logs.db` use `synchronous=NORMAL`, reintroducing
the rollback class removed from the primary database. Shutdown closes the store
without draining active jobs, so a completed journal can later recover as an
error.

Use the FULL durability profile, sync the journal before terminal status, and
perform a bounded active-job drain during shutdown.
