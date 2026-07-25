# Chat-backup reconciliation trusts unverified derivative files

- Status: Fixed
- Severity: High
- Commit: `f8aac548`
- Affected code: `server/node/chatBackups.cjs:427-447`, `server/node/chatBackups.cjs:459-519`, `server/node/chatBackups.cjs:538-546`

## Risk

Reconciliation deletes known-good source versions after checking only that a derived filename or metadata entry exists:

- If a same-name `.gz` already exists, the raw `.bin` is deleted without gunzipping or comparing it.
- If a bundle and metadata file list the expected version IDs, loose inputs are deleted without validating bundle decompression, offsets, sizes, or payload bytes.
- Startup duplicate cleanup removes loose versions merely because readable metadata names the same IDs.

A reproduction with a good raw pre-image and a corrupt seven-byte `.gz` caused reconcile to delete the raw file; `readChatBackup()` then returned `null`. A corrupt bundle with plausible metadata likewise caused good loose gzip inputs to be removed.

Atomic rename alone does not establish that a pre-existing derivative is complete or that its bytes match the source. The writer also does not fsync the file and parent before deleting its source, leaving a related power-loss exposure.

## Required fix and coverage

Before deleting a raw source, gunzip an existing derivative and compare its bytes. Before deleting loose bundle inputs, fully validate the bundle, metadata bounds, and each extracted slice against its source. Regenerate invalid derivatives atomically, fsync published data where supported, and retain sources on any validation failure.

Add regressions for corrupt pre-existing gzip and bundle/meta pairs, plus an interrupted publication case. In each case the good source must remain readable after reconcile.

## Resolution

Reconciliation now proves a derivative's bytes before deleting its source:

- `gzipLooseFiles()` gunzips a pre-existing `.gz` and byte-compares it against the raw `.bin`; on any mismatch or decompression failure it atomically regenerates the `.gz` from the raw source before the source is removed.
- `createBundle()` validates an existing same-name bundle/meta pair before trusting it: the bundle is decompressed, every meta entry's offset/size is bounds-checked, and each slice is byte-compared against the freshly gunzipped loose input. A corrupt or mismatched pair is regenerated from the loose inputs (which remain the authority); only a validated bundle permits input deletion.
- `removeBundledLooseDuplicates()` deletes a loose version only after extracting its slice from the claiming bundle and proving byte equality; bundle decompression is lazy and cached per pass, so directories without loose duplicates pay no validation cost.
- `writeFileAtomic()` fsyncs the temp file before rename and best-effort fsyncs the parent directory after, closing the rename-published-but-unflushed power-loss window.

Regression tests cover a corrupt `.gz`, a valid gzip of the wrong bytes, an empty rename-published `.gz`, a corrupt bundle claiming loose versions below the bundling threshold (sources retained), and a corrupt bundle claiming a full batch (bundle regenerated, versions readable). In every case the affected version reads back with its exact original bytes after reconcile.

