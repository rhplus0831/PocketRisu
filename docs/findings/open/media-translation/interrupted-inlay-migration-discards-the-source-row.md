# A crash during inlay migration can discard inlay metadata

- Status: Open
- Owner: media and translation
- Source: [2026-07 data-loss audit](../../../../.archived-docs/findings/2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Low
- Area: server file stores (inlay migration)
- Affected code: `server/node/server.cjs:4210` (payload rename), `server/node/server.cjs:4215` (sidecar rename), `server/node/server.cjs:4471-4477` (existing-file resume branch deletes `inlay_info/<id>` and the KV payload JSON), `server/node/server.cjs:4443-4460` (sidecar-less fallback serves an image data URI)
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../../../.archived-docs/findings/2026-08-revalidation/README.md)

## Risk

The original torn-payload mechanism is gone: `5ef61ed2` stages payload and
sidecar to fsynced temp files and publishes through ordered atomic renames,
and boot reconciliation removes interrupted temporaries, so a partial file can
no longer exist under a final name and the payload bytes survive every crash
timing.

A narrower metadata-only window remains. A crash between the payload rename
and the sidecar rename leaves a complete payload with no sidecar; the next
boot's existing-file resume branch trusts the payload and deletes the
`inlay_info/<id>` row and the KV payload JSON that carried name, dimensions,
and type. The payload survives but its display metadata is permanently lost,
and a signature inlay is thereafter served as an image data URI. The
byte-equality-before-source-deletion pattern the report demanded
(`assetStore.cjs:163-172`) was never adopted, so a torn file created by
pre-`5ef61ed2` code that survived an upgrade without the migration marker
would still be adopted verbatim — but that requires the old bug to have
already fired.

## Required fix and coverage

Publish the sidecar (or verify an equivalent metadata source) before deleting
the KV source and legacy info rows in the resume branch. Fault-injection test:
kill between the two renames, restart, and assert the inlay retains its name,
type, and signature semantics from either source.
