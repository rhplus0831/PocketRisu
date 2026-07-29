# Chat-row migration makes a direct rollback to main unreadable

- Status: Confirmed downgrade incompatibility
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
