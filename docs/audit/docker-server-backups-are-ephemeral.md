# Docker server-side backups live in the container's writable layer

- Status: Fixed
- Severity: Medium
- Area: deployment (Docker)
- Formerly affected code: `docker-compose.yml` (only `/app/save` was mounted),
  `Dockerfile:34` (WORKDIR `/app`), `server/node/server.cjs:2263` (default
  backups dir = `<cwd>/backups`)

## Risk

The shipped Compose file persisted only `risuai-save:/app/save`. Server `.bin`
backups defaulted to `/app/backups`, which stayed in the container's writable
layer, so an ordinary image update or container recreation silently deleted
every server-side backup while the live database survived. Users could discover
the loss exactly when they needed a backup.

## Required fix and coverage

Mount a named volume for `/app/backups`, or default the server backup
directory beneath the save volume when running in a container. Document the
migration for existing deployments.

## Resolution

Fixed 2026-07-31. The shipped Compose file now mounts the explicitly named
`risuai-nodeonly_risuai-backups` volume at `/app/backups`, preserving the
established server default without changing portable or custom-path behavior.
The Docker installation guide includes a stop-and-copy migration that saves
archives from the old container layer before the first recreation, installs
the revised Compose file, and copies those archives into the new volume. It
also distinguishes the save and backup volumes and warns that `down -v`
removes both. A compatibility test locks the two mounts and their stable volume
names so a later Compose edit cannot silently make either data class ephemeral.
