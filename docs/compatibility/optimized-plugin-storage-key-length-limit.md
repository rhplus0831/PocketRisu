# Optimized plugin storage adds an undocumented key-length limit

- Status: Fixed 2026-07-31
- Severity: Low
- Confidence: High
- Introduced by: 9f276c43

## Difference

main's inline object storage accepted arbitrary-length property names. serve's
optimized backend limits encoded archive row names to 1,024 UTF-8 bytes. An
owned ASCII key is effectively limited to 752 bytes because its metadata path
is longer.

An ordinary 753-byte key can remain valid in inline V3 storage, then cause
externalization to reject before publication. A plugin already in optimized
mode receives RangeError from setItem(). The public pluginStorage declaration
does not state the limit.

## Compatibility impact

Users can be unable to enable optimization for a main-compatible inline store,
while plugins that derive long keys fail only after the mode changes. The
failure is safe and pre-commit, but the migration path and limit are obscure.

## Resolution

Optimized storage now retains the historical reversible physical name while it
fits. Longer logical keys use a fixed-size `sha256-v1.<digest>.json` component,
and manifest version 3 stores the exact logical key beside that component. The
digest covers the original JavaScript UTF-16 code units under a versioned domain,
so valid Unicode, lone surrogates, and future codec changes cannot alias.

The server accepts a mapped row only when the logical key recomputes to the same
component, requires exact mapping coverage, and publishes the row and manifest
mapping in the same transaction. Long-key mutations travel in the framed request
body rather than an HTTP header. Reads, enumeration, viewer pages, staged mode
changes, export/import, recovery, and removal all resolve through the selected
manifest. Removing the last mapped row also removes its mapping atomically.

The 752/753-byte owned-key boundary remains covered to prove that existing short
physical names do not churn and the first formerly rejected owner row takes the
mapped path. Multi-thousand-character keys are covered through mutation, viewer,
both transition directions, backup restore, and removal. Practical request and
memory bounds remain, but the archive's 1,024-byte entry-name ceiling no longer
defines a logical-key limit.
