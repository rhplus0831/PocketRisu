#!/usr/bin/env bash
set -euo pipefail

REPO="PocketRisu/PocketRisu"
INSTALL_DIR="${RISU_INSTALL_DIR:-$HOME/pocketrisu}"
PORT="${PORT:-6001}"

info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
warn()  { printf '\033[1;33m[WARN]\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*"; exit 1; }

# ── Prerequisites ──────────────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || error "Node.js is not installed. Please install Node.js 22.12+ first: https://nodejs.org/"

NODE_VER=$(node -e 'console.log(process.versions.node)')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VER" | cut -d. -f2)
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 12 ]; }; then
    error "Node.js v$NODE_VER detected. v22.12.0+ is required."
fi

if ! command -v pnpm >/dev/null 2>&1; then
    info "Installing pnpm..."
    npm install -g pnpm
fi

command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || error "curl or wget is required."

# ── Fetch latest release ───────────────────────────────────────────────────────

info "Fetching latest release from GitHub..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    || wget -qO- "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null) \
    || error "Failed to fetch release info. Check your internet connection."

TAG=$(echo "$RELEASE_JSON" | grep -o '"tag_name":[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$TAG" ] || error "Could not determine latest version."
info "Latest version: $TAG"

# ── Download source archive ────────────────────────────────────────────────────

TARBALL_URL="https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz"
TMP_DIR=$(mktemp -d)
STAGE_DIR=""

cleanup() {
    rm -rf "$TMP_DIR"
    if [ -n "$STAGE_DIR" ] && [ "$STAGE_DIR" != "/" ] && [ -d "$STAGE_DIR" ]; then
        rm -rf "$STAGE_DIR"
    fi
}
trap cleanup EXIT

info "Downloading $TAG..."
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

# ── Install ────────────────────────────────────────────────────────────────────

OVERWRITE=0
if [ -d "$INSTALL_DIR" ]; then
    warn "$INSTALL_DIR already exists."
    printf "Overwrite? (existing save/ and backups/ data will be preserved) [y/N]: "
    read -r answer
    [ "$answer" = "y" ] || [ "$answer" = "Y" ] || error "Aborted."
    OVERWRITE=1
fi

INSTALL_NAME=$(basename "$INSTALL_DIR")
case "$INSTALL_NAME" in
    ""|"."|".."|"/") error "Invalid install directory: $INSTALL_DIR" ;;
esac

INSTALL_PARENT=$(dirname "$INSTALL_DIR")
mkdir -p "$INSTALL_PARENT"
INSTALL_PARENT=$(cd "$INSTALL_PARENT" && pwd -P)
INSTALL_DIR="$INSTALL_PARENT/$INSTALL_NAME"

# Build a complete replacement beside the install directory. This keeps the
# existing tree and all user data untouched until every fallible build step has
# succeeded, and makes the final directory moves same-filesystem renames.
STAGE_DIR=$(mktemp -d "$INSTALL_PARENT/.${INSTALL_NAME}.install.XXXXXX")
cp -a "$EXTRACTED_DIR/." "$STAGE_DIR/"
chmod 755 "$STAGE_DIR"

cd "$STAGE_DIR"

info "Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

info "Building..."
NODE_OPTIONS="--max-old-space-size=4096" pnpm build

info "Removing dev dependencies..."
pnpm prune --prod

echo "$TAG" > "$STAGE_DIR/.installed-version"

cd "$INSTALL_PARENT"

if [ "$OVERWRITE" -eq 1 ]; then
    OLD_DIR=$(mktemp -d "$INSTALL_PARENT/.${INSTALL_NAME}.old.XXXXXX")
    rmdir "$OLD_DIR"

    mv "$INSTALL_DIR" "$OLD_DIR"
    if ! mv "$STAGE_DIR" "$INSTALL_DIR"; then
        if mv "$OLD_DIR" "$INSTALL_DIR"; then
            error "Failed to install the new release. The existing installation was restored."
        fi
        error "Failed to install the new release. Existing data remains at $OLD_DIR."
    fi
    STAGE_DIR=""

    # Move user data only between sibling directories on the same filesystem.
    # OLD_DIR is deliberately outside the cleanup trap and is removed only
    # after every preserved directory has reached the new installation.
    for data_dir in save backups; do
        if [ -d "$OLD_DIR/$data_dir" ]; then
            if [ -e "$INSTALL_DIR/$data_dir" ]; then
                error "Cannot preserve $data_dir/: the new release already contains that path. Existing data remains at $OLD_DIR/$data_dir."
            fi
            if ! mv "$OLD_DIR/$data_dir" "$INSTALL_DIR/$data_dir"; then
                error "Failed to restore $data_dir/. Existing data remains at $OLD_DIR/$data_dir."
            fi
            info "Restored existing $data_dir/ data."
        fi
    done

    rm -rf "$OLD_DIR"
else
    mv "$STAGE_DIR" "$INSTALL_DIR"
    STAGE_DIR=""
fi

cd "$INSTALL_DIR"

# ── Done ───────────────────────────────────────────────────────────────────────

info "Installation complete!"
echo ""
echo "  Start the server:"
echo "    cd $INSTALL_DIR && pnpm runserver"
echo ""
echo "  Then open http://localhost:$PORT in your browser."
echo ""
echo "  To update later:"
echo "    cd $INSTALL_DIR && ./update.sh"
echo ""
