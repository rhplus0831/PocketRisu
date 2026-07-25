# install.sh can delete the only copy of all user data

- Status: Open
- Severity: High
- Area: deployment scripts
- Affected code: `install.sh:2` (`set -euo pipefail`), `install.sh:44-45` (mktemp + unconditional `rm -rf` EXIT trap), `install.sh:74-80` (save/backups moved — not copied — into the temp dir, then `rm -rf "$INSTALL_DIR"`), `install.sh:83-93` (restore only after the new tree is in place)

## Risk

When overwriting an existing installation, `install.sh` **moves** `save/` and
`backups/` into `$(mktemp -d)` — a directory protected by an unconditional
`trap 'rm -rf "$TMP_DIR"' EXIT` — then deletes the whole installation directory
and moves the extracted release into place. The user data is restored only
after that move succeeds.

With `set -e` active, any failure between the move and the restore (a
cross-device `mv` hitting ENOSPC — `/tmp` is commonly tmpfs and the extracted
tree plus the user's save data may not fit in RAM-backed storage — permission
errors, the extracted-dir move failing) exits the script, and the EXIT trap
deletes the temp directory holding the **only remaining copy** of the database,
assets, inlays, chat history, and server backups. A reboot or crash while data
sits in tmpfs loses it the same way.

The overwrite prompt explicitly promises "existing save/ and backups/ data will
be preserved", so the user has no reason to make a manual copy first.

## Required fix and coverage

Never place the only copy of user data under an unconditional cleanup trap.
Stage the new release in a sibling directory on the same filesystem, keep
`save/`/`backups/` in place (or copy, not move), swap directories only after the
new tree is complete, and delete the old tree last. At minimum, make the EXIT
trap restore `_save_backup`/`_backups_backup` into a survivable location before
removing the temp directory.

Cover with a scripted test that forces a failure between the move and the
restore (e.g. read-only `$INSTALL_DIR` parent) and asserts `save/` still exists
somewhere durable.
