# PocketRisu Node Server

This is PocketRisu's production self-hosted backend. It serves the built SPA, owns
authentication and persistence, and implements the APIs documented in
[`docs/structure/server-backend.md`](../../docs/structure/server-backend.md).

Run it from the repository/application root with `pnpm run runserver`; storage and
runtime paths are resolved from the current working directory. The sibling Hono tree
is an incomplete scaffold and is not a compatible replacement.
