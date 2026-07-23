#!/usr/bin/env bash
# Cross-instance asset deduplication for multi-PocketRisu hosting.
#
# Each PocketRisu instance stores assets as plain files in <instance>/save/assets/,
# named by the SHA-256 of their content. When several users import the same bot,
# each instance holds an identical copy. This script replaces duplicates with
# hardlinks so identical content is stored once per filesystem.
#
# How it works: duplicates are found by BYTE COMPARISON (never by filename alone),
# then merged with hardlinks. A hardlink is what `ln` creates: one inode, several
# directory entries, reference-counted by the filesystem. Each instance can still
# delete its own copy normally — the data is freed only when the last link goes.
#
# Requirements:
#   - All instance directories must be on the SAME filesystem (hardlinks cannot
#     cross mount points).
#   - jdupes (preferred) or util-linux `hardlink` must be installed.
#   - Safe to run while instances are live: PocketRisu writes assets via
#     temp-file + rename, never in place, so a shared inode is never mutated.
#
# Usage:
#   scripts/dedup-assets.sh /srv/pocketrisu/*/save/assets
#
# Cron example (nightly at 04:30):
#   30 4 * * * /srv/pocketrisu/scripts/dedup-assets.sh /srv/pocketrisu/*/save/assets
set -euo pipefail

if [ "$#" -lt 1 ]; then
    echo "usage: $0 <assets-dir> [<assets-dir> ...]" >&2
    echo "example: $0 /srv/pocketrisu/*/save/assets" >&2
    exit 2
fi

# Keep only directories that actually exist (globs for not-yet-created instances).
dirs=()
for d in "$@"; do
    [ -d "$d" ] && dirs+=("$d")
done
if [ "${#dirs[@]}" -lt 2 ]; then
    echo "[dedup-assets] fewer than two existing asset directories — nothing to dedup." >&2
    exit 0
fi

if command -v jdupes >/dev/null 2>&1; then
    # -L: replace duplicates with hardlinks; -r: recurse; -A: exclude hidden
    # files (PocketRisu's .tmp-* staging files and .migrated_to_fs marker).
    exec jdupes -r -A -L "${dirs[@]}"
elif command -v hardlink >/dev/null 2>&1; then
    # util-linux hardlink byte-compares before linking, but by default refuses
    # to merge files whose mtime or mode differ. PocketRisu writes assets via
    # temp-file + rename, so identical content across instances always has
    # different timestamps — ignore them (-t) and mode (-p). Owner differences
    # still block linking on purpose: run all instances as one user, or a
    # merged inode would be accessible to only one of them.
    exec hardlink -t -p -m "${dirs[@]}"
else
    echo "[dedup-assets] neither 'jdupes' nor 'hardlink' found." >&2
    echo "install one of them, e.g.: apt install jdupes   (or: apt install util-linux)" >&2
    exit 3
fi
