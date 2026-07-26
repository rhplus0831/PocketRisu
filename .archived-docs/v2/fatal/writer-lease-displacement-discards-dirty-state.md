# A new tab silently steals the writer lease and the displaced tab discards its dirty state

- Status: Partially Fixed
- Severity: High
- Area: client save loop / single-writer lock
- Affected code: `server/node/server.cjs:3663-3671` (`/api/session` unconditionally reassigns `activeSessionId`), `server/node/server.cjs:1690-1697` (displaced writer gets 423), `src/ts/storage/nodeStorage.ts:154-198` (unique per-load session, initialized on first authenticated call), `src/ts/globalApi.svelte.ts:397-416` (same-browser and cross-device displacement), `src/ts/storage/writerTakeover.ts` (explicit freeze-or-reload flow)

## Risk

The cross-device single-writer lock is last-caller-wins with no handoff. Every
page load registers a fresh session ID during its first authenticated request —
including read-only visits — and the server replaces the active writer
unconditionally at that moment.

The displaced tab discovers the loss only when it next tries to write: the 423
sets `gotChannel`, after which `persistTrackedChanges()` permanently returns
`noop` (its unload save included). There is no flush-before-handoff step.

Concrete trigger: a generation is running on the desktop; the user glances at
the app on their phone (or opens a second window). The desktop's next
checkpoint or final save is rejected, leaving the generated response plus any
edits since the last successful save only in desktop memory. The same applies
to edits inside the 500 ms debounce window or a queued retry.

## Partial resolution

Writer fencing remains unchanged so a deferred client still cannot overwrite
newer server state. The displaced page no longer reloads automatically:

- Server-side 423 displacement and same-browser `BroadcastChannel`
  displacement enter one shared, one-way takeover flow.
- The active chat request is aborted, stale save retries pause, and the user is
  asked either to remain on the page or explicitly discard local unsaved state,
  reload, and take write access from the other session.
- Staying puts the page into a frozen read-only mode. Existing text remains
  selectable, editable controls and application interactions are blocked, and
  a persistent banner provides the explicit reload/takeover action.
- Regression coverage verifies that takeover is latched once, staying does not
  reload, current and newly mounted editors remain read-only, interactions are
  blocked, and reload occurs only after an explicit choice.

This removes the involuntary refresh that immediately discarded dirty browser
state and gives the user an opportunity to copy visible work without weakening
the original deferred-client protection.

## Remaining risk

This is not a writer handoff and does not make dirty state durable. A read-only
visit still takes the lease immediately. Closing or crashing the frozen page,
or explicitly choosing reload, still loses changes the server never accepted;
non-visible structural or plugin changes may not be recoverable by copying.
Reload also takes write access back from the other session, so repeated choices
can move the freeze between clients.

A complete fix would keep the newcomer read-only while the current writer
flushes and releases through a server-coordinated handoff, or would journal all
dirty client mutations durably for later recovery. Any handoff must preserve
the stale-writer fence: allowing an unconditional post-423 flush could restore
the original deferred-client overwrite bug.
