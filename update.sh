#!/usr/bin/env bash
set -euo pipefail

REPO="PocketRisu/PocketRisu"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*"; exit 1; }

# Return the top-level app entry containing a marker-declared recovery path.
# Paths outside the app root need no protection. Refuse managed app roots so a
# stale or hand-edited marker cannot preserve old executable files over a new
# release. Node is already a requirement for source installations and gives us
# portable path normalization without relying on platform-specific realpath
# flags.
custom_data_keep_entry() {
    local marker_path="$1"
    local label="$2"
    [ -f "$marker_path" ] || return 0

    node - "$SCRIPT_DIR" "$marker_path" "$label" <<'NODE'
const fs = require('fs');
const path = require('path');

const [root, markerPath, label] = process.argv.slice(2);
let raw;
try {
    raw = fs.readFileSync(markerPath, 'utf8').trim();
} catch {
    process.exit(0);
}
if (!raw) process.exit(0);

let relative;
try {
    relative = path.relative(root, path.resolve(root, raw));
} catch {
    process.exit(0);
}
if (relative.startsWith('..') || path.isAbsolute(relative)) process.exit(0);
if (!relative) {
    process.stderr.write(`[ERROR] ${label} points at the PocketRisu app root. Move it to a separate folder before updating.\n`);
    process.exit(1);
}

const top = relative.split(path.sep)[0];
const managedRoots = new Set(['server', 'dist', 'scripts', 'bin', 'node_modules', '.update-tmp']);
if (managedRoots.has(top)) {
    process.stderr.write(`[ERROR] ${label} is inside PocketRisu app files (${relative}). Move it to a separate folder such as data/backups before updating.\n`);
    process.exit(1);
}
process.stdout.write(top);
NODE
}

# ── Check current version ─────────────────────────────────────────────────────

CURRENT=""
if [ -f .installed-version ]; then
    CURRENT=$(cat .installed-version)
fi

if [ -z "$CURRENT" ]; then
    # Fallback: read from package.json
    CURRENT="v$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")"
fi

info "Current version: $CURRENT"

# ── Fetch latest release ───────────────────────────────────────────────────────

info "Checking for updates..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    || wget -qO- "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null) \
    || error "Failed to fetch release info."

LATEST=$(echo "$RELEASE_JSON" | grep -o '"tag_name":[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$LATEST" ] || error "Could not determine latest version."

if [ "$CURRENT" = "$LATEST" ]; then
    info "Already up to date ($CURRENT)."
    exit 0
fi

info "New version available: $LATEST"

# ── Confirm ────────────────────────────────────────────────────────────────────

printf "Update from %s to %s? [Y/n]: " "$CURRENT" "$LATEST"
read -r answer
[ "$answer" = "n" ] || [ "$answer" = "N" ] && { info "Aborted."; exit 0; }

# ── Backup save/ ───────────────────────────────────────────────────────────────

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

if [ -d save ]; then
    info "Backing up save/ ..."
    cp -r save "$TMP_DIR/_save_backup"
fi

# ── Download and extract ───────────────────────────────────────────────────────

TARBALL_URL="https://github.com/$REPO/archive/refs/tags/$LATEST.tar.gz"

info "Downloading $LATEST..."
if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$TARBALL_URL" -o "$TMP_DIR/release.tar.gz"
else
    wget -qO "$TMP_DIR/release.tar.gz" "$TARBALL_URL"
fi

info "Extracting..."
tar -xzf "$TMP_DIR/release.tar.gz" -C "$TMP_DIR"
# Match both PocketRisu-* (current) and Risuai-NodeOnly-* (legacy repo name)
# in case an older script encounters a redirected source archive.
# Use find rather than ls: ls exits non-zero when one branch has no match,
# which `set -euo pipefail` would propagate and abort the script.
EXTRACTED_DIR=$(find "$TMP_DIR" -maxdepth 1 -type d \
    \( -name 'PocketRisu-*' -o -name 'Risuai-NodeOnly-*' \) \
    -print -quit)
[ -d "$EXTRACTED_DIR" ] || error "Extraction failed."

# ── Replace files (preserve save/) ─────────────────────────────────────────────

info "Updating files..."

# Remove old app files but keep the default data roots and any custom in-tree
# recovery roots recorded by the server for dependency-free updaters.
KEEP_ENTRIES=('save' 'backups' '.installed-version')
for marker_name in '__backup_path' '__chat_backup_path'; do
    case "$marker_name" in
        '__backup_path') label='Server-backup directory' ;;
        '__chat_backup_path') label='Chat-backup directory' ;;
    esac
    custom_keep=$(custom_data_keep_entry "$SCRIPT_DIR/save/$marker_name" "$label")
    if [ -n "$custom_keep" ]; then
        info "Preserving $label: $custom_keep/"
        KEEP_ENTRIES+=("$custom_keep")
    fi
done

shopt -s nullglob
for entry_path in "$SCRIPT_DIR"/* "$SCRIPT_DIR"/.[!.]* "$SCRIPT_DIR"/..?*; do
    entry_name=${entry_path##*/}
    preserve_entry=0
    for keep_entry in "${KEEP_ENTRIES[@]}"; do
        if [ "$entry_name" = "$keep_entry" ]; then
            preserve_entry=1
            break
        fi
    done
    if [ "$preserve_entry" -eq 0 ]; then
        rm -rf -- "$entry_path"
    fi
done
shopt -u nullglob

# Move new files in
mv "$EXTRACTED_DIR"/* "$EXTRACTED_DIR"/.[!.]* "$SCRIPT_DIR/" 2>/dev/null || true

# Restore save/
if [ -d "$TMP_DIR/_save_backup" ]; then
    rm -rf "$SCRIPT_DIR/save"
    mv "$TMP_DIR/_save_backup" "$SCRIPT_DIR/save"
fi

# ── Rebuild ────────────────────────────────────────────────────────────────────

info "Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

info "Building..."
NODE_OPTIONS="--max-old-space-size=4096" pnpm build

info "Removing dev dependencies..."
pnpm prune --prod

echo "$LATEST" > "$SCRIPT_DIR/.installed-version"

info "Update complete! $CURRENT → $LATEST"
echo ""
echo "  Restart the server to apply the update:"
echo "    pnpm runserver"
echo ""
