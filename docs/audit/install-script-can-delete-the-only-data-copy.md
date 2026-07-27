# install.sh can delete the only copy of all user data

- Status: Fixed
- Severity: High
- Area: deployment scripts
- Affected code: historical overwrite flow in `install.sh`; fixed by the sibling staging and swap block and covered by `server/node/installScript.test.ts`

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

## Resolution

Fixed 2026-07-27. The installer now copies and fully builds the release in a
sibling staging directory while the existing installation remains untouched.
It renames the old installation aside, rolls it back if placing the staged tree
fails, transfers `save/` and `backups/` only through same-filesystem sibling
renames, and deletes the old tree only after both transfers succeed. The EXIT
trap cleans only the downloaded archive and incomplete release staging tree;
it never owns the old installation or user data.

`server/node/installScript.test.ts` exercises a successful overwrite and an
injected failure after the old tree is renamed but before data transfer. The
failure test verifies that the original installation, database, and backups
are restored and that staging cleanup cannot remove them.
