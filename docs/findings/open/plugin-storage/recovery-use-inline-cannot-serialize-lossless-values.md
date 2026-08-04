# Plugin recovery offers an inline repair it cannot serialize

- Status: Open
- Severity: Warning
- Owner: plugin storage
- Source: [delta audit DA-15](../../../../.archived-docs/findings/2026-08-delta-audit/02-findings.md#da-15-recovery-offers-use-inline-repairs-its-action-path-cannot-serialize-c-f3)

Recovery inspection uses the lossless fallback and can advertise `canUseInline`
for a value that the resolving transaction later passes through the strict-only
serializer. The action rolls back with
`PLUGIN_STORAGE_RECOVERY_ROLLED_BACK`, leaving the bad external row
authoritative.

Use the lossless optimized-row serializer in the action path and cover a
lossless inline recovery action through the real transaction.
