# List deltas can cache state that an import later rolls back

- Status: Open
- Severity: High
- Commit: `6792dc7f`
- Affected code: `server/node/server.cjs:2504-2683`, `server/node/server.cjs:3748-3774`, `server/node/server.cjs:5210-5254`, `src/ts/storage/nodeStorage.ts:488-500`

## Risk

Destructive imports run long transactions on the server's shared SQLite connection but are not isolated from `/api/list`. A list request on that connection can see uncommitted rows and deletion tombstones. The browser applies and persists the returned delta immediately.

If the import later rolls back, its epoch bump also rolls back. Restored rows keep their original `updated_at`, which predates the browser's newly advanced delta cursor. Later list requests therefore return no addition and the key remains absent from the browser's cached list until the six-day forced full refresh or another mutation touches it.

This sequence was reproduced with a durable plugin key: the import's uncommitted deletion was cached, rollback restored the physical key with the old epoch, and the next delta was empty. The cached omission can prevent plugin reconciliation and asset/chat cleanup from seeing live data. Conversely, a cached ghost snapshot key can cause snapshot-list cleanup to remove an extra real oldest snapshot.

## Required fix and coverage

Serialize list generation with every import/restore transaction and filesystem swap, or return a retryable response while the import barrier is held. Bumping the epoch after a handled rollback is useful defense in depth but does not cover process termination; startup must invalidate any cache that could have observed an unfinished import.

Add paused-import tests for both forced rollback and process death. A concurrent list must block/fail, or the first post-recovery response must force a full authoritative list before the browser applies cleanup decisions.

