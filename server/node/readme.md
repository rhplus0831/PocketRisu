# PocketRisu Node Server

This is PocketRisu's production self-hosted backend. It serves the built SPA, owns
authentication and persistence, and implements the APIs documented in
[`docs/structure/server-backend.md`](../../docs/structure/server-backend.md).

- `db/` — KV storage, chunks, revisions, caches, and deltas.
- `chat/` — chat rows, deltas, backups, defaults, and ingress.
- `plugin-storage/` — optimized plugin keys, codecs, limits, manifests, and viewer facets.
- `backup/` — interchange codecs, export/import streams, journals, and spools.
- `assets/` — asset storage, deduplication, garbage collection, and maintenance locking.
- `runtime/` — jobs, logging, tracing, sessions, build metadata, and proxy infrastructure.

Run it from the repository/application root with `pnpm run runserver`; storage and
runtime paths are resolved from the current working directory. The sibling Hono tree
is an incomplete scaffold and is not a compatible replacement.
