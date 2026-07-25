# Docker server-side backups live in the container's writable layer

- Status: Open
- Severity: Medium
- Area: deployment (Docker)
- Affected code: `docker-compose.yml:14-15` (only `/app/save` mounted), `Dockerfile:34` (WORKDIR `/app`), `server/node/server.cjs:905` (default backups dir = `<cwd>/backups`)

## Risk

The shipped Compose file persists only `risuai-save:/app/save`. Server `.bin`
backups default to `/app/backups`, which stays in the container's writable
layer, so an ordinary image update or container recreation silently deletes
every server-side backup while the live database survives. Users discover the
loss exactly when they need a backup.

## Required fix and coverage

Mount a named volume for `/app/backups`, or default the server backup
directory beneath the save volume when running in a container. Document the
migration for existing deployments.
