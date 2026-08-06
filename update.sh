#!/usr/bin/env bash
set -euo pipefail

REPO="PocketRisu/PocketRisu"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*"; exit 1; }

# Return every top-level app entry containing a marker-declared recovery path.
# The shared dependency-free Node helper understands crash-transition records,
# canonical filesystem identities, and platform case folding.
custom_data_keep_entries() {
    local marker_path="$1"
    local label="$2"

    node - "$SCRIPT_DIR" "$marker_path" "$label" "$SCRIPT_DIR/server/node/recoveryPathMarkers.cjs" <<'NODE'
const [root, markerPath, label, helperPath] = process.argv.slice(2);
try {
    const {
        readRecoveryPathMarkerTargetsSync,
        recoveryPathKeepEntries,
    } = require(helperPath);
    const platform = process.env.NODE_ENV === 'test'
        && process.env.POCKETRISU_TEST_RECOVERY_PLATFORM === 'win32'
        ? 'win32'
        : process.platform;
    const entries = new Set();
    for (const target of readRecoveryPathMarkerTargetsSync(markerPath, { platform })) {
        for (const entry of recoveryPathKeepEntries(root, target, label, { platform })) entries.add(entry);
    }
    process.stdout.write([...entries].join('\n'));
} catch (error) {
    const rawDetail = error && error.message ? error.message : String(error);
    const detail = rawDetail.startsWith(`${label} `)
        ? rawDetail
        : `${label} preservation marker ${rawDetail.replace(/^marker /, '')}`;
    process.stderr.write(`[ERROR] Cannot safely update: ${detail}. Start PocketRisu once to republish recovery metadata, then retry the update.\n`);
    process.exit(1);
}
NODE
}

wait_at_update_test_gate() {
    local stage="$1"
    if [ "${NODE_ENV:-}" != "test" ] || [ -z "${POCKETRISU_TEST_UPDATE_SH_GATE_DIR:-}" ]; then
        return 0
    fi
    local update_gate_dir
    update_gate_dir=$(cd "$POCKETRISU_TEST_UPDATE_SH_GATE_DIR" 2>/dev/null && pwd || true)
    if [ -z "$update_gate_dir" ] \
        || [ ! -f "$update_gate_dir/stage" ] \
        || [ "$(cat "$update_gate_dir/stage")" != "$stage" ] \
        || [ ! -e "$update_gate_dir/hold" ]; then
        return 0
    fi
    printf '%s' "$stage" > "$update_gate_dir/entered"
    while [ -e "$update_gate_dir/hold" ] && [ ! -e "$update_gate_dir/release" ]; do
        sleep 0.01
    done
}

UPDATE_LOCK_TOKEN=""
TMP_DIR=""
UPDATE_LOCK_HELPER=""

release_update_lock() {
    if [ -z "$UPDATE_LOCK_TOKEN" ] || [ -z "$UPDATE_LOCK_HELPER" ]; then
        return 0
    fi
    node - "$SCRIPT_DIR/save" "$UPDATE_LOCK_TOKEN" "$UPDATE_LOCK_HELPER" <<'NODE'
const [markerDirectory, token, helperPath] = process.argv.slice(2);
const { releaseRecoveryPathStateLockSync } = require(helperPath);
releaseRecoveryPathStateLockSync(markerDirectory, token);
NODE
    UPDATE_LOCK_TOKEN=""
}

cleanup() {
    local status=$?
    trap - EXIT
    set +e
    release_update_lock
    local release_status=$?
    if [ -n "$TMP_DIR" ]; then
        rm -rf -- "$TMP_DIR"
    fi
    if [ "$status" -eq 0 ] && [ "$release_status" -ne 0 ]; then
        status=$release_status
    fi
    exit "$status"
}

trap cleanup EXIT

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
UPDATE_LOCK_HELPER="$TMP_DIR/recoveryPathMarkers.cjs"
cp "$SCRIPT_DIR/server/node/recoveryPathMarkers.cjs" "$UPDATE_LOCK_HELPER"
UPDATE_LOCK_TOKEN=$(node - "$SCRIPT_DIR/save" "$UPDATE_LOCK_HELPER" <<'NODE'
const [markerDirectory, helperPath] = process.argv.slice(2);
try {
    const { acquireRecoveryPathStateLockSync } = require(helperPath);
    const lock = acquireRecoveryPathStateLockSync(markerDirectory, {
        purpose: 'update.sh standalone updater',
    });
    process.stdout.write(lock.token);
} catch (error) {
    process.stderr.write(`[ERROR] Cannot safely update: ${error?.message || error}\n`);
    process.exit(1);
}
NODE
)

# A startup quarantine is a durable transaction record containing the complete
# historical recovery-root set. Its mere presence (including corruption) is a
# hard stop until a successful server startup republishes both valid markers.
node - "$SCRIPT_DIR/save" "$UPDATE_LOCK_HELPER" <<'NODE'
const [markerDirectory, helperPath] = process.argv.slice(2);
try {
    const { assertRecoveryPathStartupQuarantineAbsentSync } = require(helperPath);
    assertRecoveryPathStartupQuarantineAbsentSync(markerDirectory);
} catch (error) {
    process.stderr.write(`[ERROR] ${error?.message || error}\n`);
    process.exit(1);
}
NODE

if [ -d save ]; then
    info "Backing up save/ ..."
    cp -r save "$TMP_DIR/_save_backup"
    # The live token-owned lock is not backup payload. Restoring a copied owner
    # record would manufacture stale metadata, so exclude it explicitly.
    rm -rf -- "$TMP_DIR/_save_backup/__recovery_path_state.lock"
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
CASE_INSENSITIVE_KEEP=$(node -p \
    "process.platform === 'win32' || (process.env.NODE_ENV === 'test' && process.env.POCKETRISU_TEST_RECOVERY_PLATFORM === 'win32') ? '1' : '0'")
for marker_name in '__backup_path' '__chat_backup_path'; do
    case "$marker_name" in
        '__backup_path') label='Server-backup directory' ;;
        '__chat_backup_path') label='Chat-backup directory' ;;
    esac
    custom_keeps=$(custom_data_keep_entries "$SCRIPT_DIR/save/$marker_name" "$label")
    while IFS= read -r custom_keep; do
        if [ -n "$custom_keep" ]; then
            info "Preserving $label: $custom_keep/"
            KEEP_ENTRIES+=("$custom_keep")
        fi
    done <<< "$custom_keeps"
done

wait_at_update_test_gate 'before-destructive-enumeration'

shopt -s nullglob
for entry_path in "$SCRIPT_DIR"/* "$SCRIPT_DIR"/.[!.]* "$SCRIPT_DIR"/..?*; do
    entry_name=${entry_path##*/}
    preserve_entry=0
    for keep_entry in "${KEEP_ENTRIES[@]}"; do
        if [ "$entry_name" = "$keep_entry" ] \
            || { [ "$CASE_INSENSITIVE_KEEP" -eq 1 ] \
                && [ "${entry_name,,}" = "${keep_entry,,}" ]; }; then
            preserve_entry=1
            break
        fi
    done
    if [ "$preserve_entry" -eq 0 ]; then
        rm -rf -- "$entry_path"
    fi
done
shopt -u nullglob

# `save/` is live preservation state, including the active lock. Never merge or
# recursively replace a release-provided save tree over it.
rm -rf -- "$EXTRACTED_DIR/save"

# Move new files in
mv "$EXTRACTED_DIR"/* "$EXTRACTED_DIR"/.[!.]* "$SCRIPT_DIR/" 2>/dev/null || true

# Historical scripts recursively replaced save/ here. The live tree is now
# untouched throughout; this exact former restore window exists only as a test
# boundary proving both the data and lock survive normal operation and SIGKILL.
wait_at_update_test_gate 'during-save-restore'

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
