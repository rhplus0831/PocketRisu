# Chat history is outside the default persistent Docker volume

- Status: Open
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

