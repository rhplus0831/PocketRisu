# Chat-row migration makes a direct rollback to main unreadable

- Status: Fixed 2026-07-31 with a dedicated main-target downgrade export
- Severity: High
- Confidence: High
- Introduced by: 9cb0086d

## Difference

serve migrates chat bodies from database.bin to chats/<character>/<chat> rows
and replaces database entries with bare _stub objects. main only builds its
fullChatStore from payload-bearing chats and has no reader for the chats/
namespace.

## Compatibility impact

After serve has migrated a save directory, starting main returns bare stubs
instead of messages. The message bytes remain physically present but are
unreachable to main; backups or edits performed while downgraded can cement the
incomplete view.

serve creates a pre-chat-externalization migration copy, but main's normal
recovery UI only discovers database/dbbackup-* entries. A serve full export
always folds chat rows into a chat-self-contained database, but default
Node-only export can keep optimized plugin rows separate; upstream-target
export folds them and has its own documented interchange caveats. It is not an
automatic, universally main-compatible downgrade archive.

## Recommendation

Provide an explicit atomic downgrade/fold command or backport row-aware reads
to the rollback target. Surface the migration backup and document the mandatory
procedure. Add a real main -> serve migration -> main rollback test requiring
every chat message to remain readable.

## Resolution

`GET /api/backup/export?target=main` now provides the explicit non-destructive downgrade
operation. It takes the existing pinned SQLite/filesystem full-export cut, fails closed
when any referenced chat row is missing, folds every chat body and the selected optimized
plugin publication into `database.risudat`, retains ordinary assets and the inlay entry
families accepted by `main`, and omits serve-only draft and remembered-MCP namespaces that
the rollback importer rejects. The resulting download is named `*-main.bin`; the Data
Migration page exposes it with the mandatory fresh-directory and omission warnings.

The exporter additionally checks the assembled database header before publishing archive
headers. Plugin keys requiring PocketRisu's escape-aware version 10 format receive
`BACKUP_MAIN_UNSUPPORTED_PLUGIN_KEYS` instead of an archive that `main` cannot decode.
The live `serve` store is never rewritten.

Compatibility coverage starts with a main-shaped multi-character/multi-chat save, proves
that `serve` externalized it to stubs plus `chats/*` rows, performs the main-target export,
checks the exact `main` v1.8.1 archive-name and version-7 decoder contract, and requires
every message, plugin value, asset/inlay family, and chat metadata field to survive while
the source rows remain byte-exact. Missing chat rows, corrupt plugin publications, unknown
targets, unsupported plugin keys, client target routing, and the migration download UI
are covered separately.

A raw data-directory rollback without this operation remains unsupported. The dedicated
export is the mandatory downgrade boundary; users should restore it into a fresh `main`
directory and retain the original `serve` data until verification.
