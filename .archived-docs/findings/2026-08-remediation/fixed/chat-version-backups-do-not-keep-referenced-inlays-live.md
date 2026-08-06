# Chat-version backups do not keep referenced inlays live

- Status: Fixed (2026-08-06 remediation queue)
- Owner: backup and recovery
- Source: [2026-07 data-loss audit](../../2026-07-data-loss-audit/PRIORITY-INDEX.md)
- Severity: Medium
- Lens: D3
- Area: Area 7 — server file stores
- Extends: [The inlay gallery's orphan scan classifies referenced inlays as deletable](../../2026-07-data-loss-audit/reports/inlay-orphan-scan-classifies-referenced-inlays-as-deletable.md)
- Affected code: `src/ts/process/files/inlays.ts:664-695`, `src/lib/Setting/Pages/InlayImageGallery.svelte:77-87`, `src/lib/Setting/Pages/InlayImageGallery.svelte:134-148`, `src/lib/Setting/Pages/InlayImageGallery.svelte:241-258`, `src/lib/Setting/ChatBackupList.svelte:133-150`, `server/node/server.cjs:5320-5336`
- Revalidated: 2026-08-05 against `57b7ea41` — dual-track pass, see the [revalidation register](../../2026-08-revalidation/README.md)
- Resolution: this remediation commit — the server now folds every independently
  restorable chat pre-image into the authoritative inlay reachability scan. The
  history visitor federates active, historical, and protected conflict roots and
  reads retained loose, gzip, framed, and legacy-bundle versions through their
  existing verified readers. A destructive-only inventory rejects unreadable or
  empty chat directories, recognized malformed frame/bundle metadata, and
  candidates that disappear before read. Its strict root discovery also propagates
  failures enumerating the reserved protected-conflict container and makes every
  discovered conflict namespace required through inventory. Each valid version is decoded and scanned one at a time;
  a recognized version that becomes unreadable or undecodable, or an explicitly
  retained history root that becomes unavailable, aborts deletion before any
  selected inlay is changed. Gallery scans therefore retain
  history-only IDs, while `/api/inlays/delete-unreferenced` and the compatibility
  `/api/remove` path repeat the combined live/history proof inside the storage
  queue. Loaded unsaved chats remain a client-supplied additional keep-set.
  True orphans are still deleted, and restoring a delete-chat pre-image leaves
  its referenced media readable through the direct asset route.
- Regression coverage: `server/node/chatBackups.test.ts` visits loose, gzip,
  framed, legacy-bundle, active-root, and federated historical-root versions and
  proves unreadable history and unavailable required roots fail closed.
  `test/compat/inlay-reference-guard.test.ts`
  covers unopened live rows, post-classification races, overwrite pre-images,
  required delete-chat capture, history-only message and swipe references, true
  orphan deletion, byte-exact version restore, direct media readability, and an
  undecodable retained version blocking deletion. It also covers unreadable
  directories, malformed frame and bundle metadata, inaccessible protected-conflict
  discovery, conflict-root disappearance, and inventory-to-read disappearance.
- Canonical architecture: [per-chat pre-image history](../../../../docs/structure/backup-recovery.md#per-chat-pre-image-history) and [media inlay conventions](../../../../docs/structure/media-translation.md#5-conventions--gotchas)

## Original risk (historical)

Chat-version files and bundles are independently listed and restorable, but the
gallery's orphan classifiers scan only the current live chat index and in-memory
messages. Neither includes references that survive only in retained version
history, and deletion has no server-side recheck against those versions.

After a live chat is deleted, an inlay referenced by its pre-image appears safe
under “Orphan Chat.” Deleting it succeeds; later importing that supported backup
version restores the chat text with a permanently dangling inlay token. This
extends v2 with a distinct reference source even when live chats are hydrated.

## Original required fix and coverage (historical)

Build reachability server-side over live rows and every retained loose, gzip, and
bundle version. Revalidate selected IDs under the storage queue before deletion
and prefer a trash/grace generation.

Test delete-live-chat, classify, restore-version, and media rendering end to end.
