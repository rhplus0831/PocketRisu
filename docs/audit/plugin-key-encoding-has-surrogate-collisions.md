# Plugin-key encoding collides on unpaired UTF-16 surrogates

- Status: Open
- Severity: Medium
- Commit: `e2bc8e5b`
- Affected code: `src/ts/storage/persistentKv.ts:16-29`, `src/ts/plugins/pluginSaveStorage.ts:173-211`, `server/node/server.cjs:2138-2159`

## Risk

Plugin keys are converted to UTF-8 and then base64url-encoded. JavaScript strings may contain unpaired UTF-16 surrogates, but UTF-8 conversion replaces each such code unit with U+FFFD. Distinct keys can therefore map to the same persistent row.

For example, `"\uD800"`, `"\uD801"`, and `"�"` all encode to `77-9`. During externalization, each value is written to that same row and each inline property is then deleted. The last write wins, and both the other values and the original key identities are lost when the empty inline map is persisted.

This input is uncommon, but plugin APIs accept arbitrary JavaScript string keys and the collision is deterministic and reproducible.

## Required fix and coverage

Encode raw UTF-16 code units losslessly, for example by encoding a well-defined sequence of 16-bit units, or reject non-Well-Formed Unicode keys before any inline value is deleted. Externalization should precompute all destination keys and abort without mutation if any encoded collision exists.

Add round-trip tests using two different lone-surrogate keys plus a literal U+FFFD key, covering externalization, normal reads/writes, backup export/import, and internalization.

