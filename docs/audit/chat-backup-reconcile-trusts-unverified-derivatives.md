# Chat-backup reconciliation trusts unverified derivative files

- Status: Open
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

