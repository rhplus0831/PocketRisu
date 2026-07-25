# Chat history is outside the default persistent Docker volume

- Status: Fixed
- Severity: High
- Commits: `f8aac548`, aggravated in hub mode by `41ab5bb5`
- Affected code: `docker-compose.yml:14-15`, `server/node/server.cjs:138-145`, `server/node/chatBackups.cjs:652-680`, `server/node/server.cjs:6148-6163`

## Risk

Chat pre-image history is stored under `<backupsDir>/chat-backups`, which defaults to `/app/backups/chat-backups` in the container. The supplied Docker Compose file persists only `/app/save`. Replacing or recreating the container therefore removes all chat recovery history while preserving the live database, even though container replacement is a normal update/deployment operation.

The history is not embedded in portable or server `.bin` backups, so another recovery representation does not automatically retain it.

Hub mode makes remediation harder: it documents chat backups as enabled but returns 403 from the backup-path configuration endpoints. A fresh hub user therefore cannot redirect chat history into the persistent `/app/save` volume through the supported API. On a read-only application root, startup reconciliation cannot create the default history directory at all.

## Required fix and coverage

Store chat history under a separately configured recovery root that is persistent by default, preferably below the save volume for container deployments. If it intentionally remains separate, the default Compose configuration must mount a named volume at `/app/backups`, and hub mode must expose a safe operator-level path setting independent of the disabled server-file-backup UI.

Add an integration test that captures a chat pre-image, recreates the container while retaining the declared volumes, and verifies the version is still listed and readable. Add the same expectation for hub mode.

## Resolution

Chat history now has an independent final root. It defaults to `<savePath>/chat-backups` (`/app/save/chat-backups` in the supplied container), so the existing `risuai-save` volume retains recovery versions across container replacement. `POCKETRISU_CHAT_BACKUP_DIR` lets operators select an absolute path or a path relative to the process working directory without changing the server-file-backup `backupsDir` or its KV configuration.

Startup now creates the chat-history root regardless of hub mode and migrates files from the legacy `<backupsDir>/chat-backups` location before the first reconciliation. Migration moves each file with `renameSync`; an `EXDEV` result falls back to copy, byte verification, and unlink. An existing destination is kept: an identical legacy copy is removed, while different bytes leave the legacy file in place and produce a warning. Failed copies and other migration errors are logged without blocking startup, sources are retained unless their move or verified copy succeeded, and empty legacy directories are pruned.

Hub mode uses the same writable `../../save` default and the operator-only environment override; the disabled server-backup path endpoints no longer affect chat recovery. Storage statistics account for chat-history filesystem bytes on the save disk, and updater keep logic preserves an in-tree environment override through its marker while portable and server `.bin` backup assembly continues to exclude chat history.

Regression tests capture and byte-verify a version after simulated container replacement that retains only `../../save`, exercise capture in hub mode with an unwritable application root when permissions can be enforced, cover startup migration including the cross-device fallback and destination conflicts, and verify the hub compatibility routes can list and read a captured version from `save/chat-backups`.
