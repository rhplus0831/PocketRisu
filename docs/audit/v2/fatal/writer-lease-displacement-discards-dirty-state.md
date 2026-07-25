# A new tab silently steals the writer lease and the displaced tab discards its dirty state

- Status: Open
- Severity: High
- Area: client save loop / single-writer lock
- Affected code: `server/node/server.cjs:3663-3671` (`/api/session` unconditionally reassigns `activeSessionId`), `server/node/server.cjs:1690-1697` (displaced writer gets 423), `src/ts/storage/nodeStorage.ts:154-198` (unique per-load session, initialized on first authenticated call), `src/ts/globalApi.svelte.ts:411-418` (deactivation → alert → `location.reload()`), `src/ts/globalApi.svelte.ts:769-781` (`persistTrackedChanges` returns `noop` once displaced)

## Risk

The cross-device single-writer lock is last-caller-wins with no handoff. Every
page load registers a fresh session ID during its first authenticated request —
including read-only visits — and the server replaces the active writer
unconditionally at that moment.

The displaced tab discovers the loss only when it next tries to write: the 423
sets `gotChannel`, after which `persistTrackedChanges()` permanently returns
`noop` (its unload save included), an alert is shown, and the tab reloads —
discarding every dirty change still in memory. There is no flush-before-handoff
step anywhere.

Concrete trigger: a generation is running on the desktop; the user glances at
the app on their phone (or opens a second window). The desktop's next
checkpoint or final save is rejected, and the generated response plus any edits
since the last successful save are gone after the forced reload. The same
applies to edits inside the 500 ms debounce window or a queued retry.

## Required fix and coverage

Add a handoff protocol: before activating a new session, let the current writer
flush (server-coordinated grace period, or client-side "flush then release"
triggered by a push/poll), and keep the newcomer read-only until the transfer
completes. At minimum, on the first 423 attempt one final immediate flush using
the old session before marking the tab inert, and only reload after it is
accepted or explicitly abandoned by the user.

Cover with a two-client test: client A has unsaved tracked changes; client B
registers a session; assert A's data reaches the server (or A is not asked to
reload while holding unsaved data).
