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
#   - All target directories and candidate assets must have one UID/GID, with
#     one directory mode and one candidate-file mode. Mixed metadata is refused.
#   - Node.js 22.12 or newer (the same runtime PocketRisu requires).
#   - Every live instance must run a build with the shared asset-maintenance
#     lock contract. Runtime writes that meet maintenance are refused retryably.
#
# Usage:
#   scripts/dedup-assets.sh /srv/pocketrisu/*/save/assets
#
# Cron example (nightly at 04:30):
#   30 4 * * * /srv/pocketrisu/scripts/dedup-assets.sh /srv/pocketrisu/*/save/assets
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_dir/dedup-assets.cjs" "$@"
