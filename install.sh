#!/bin/sh
set -eu

REPO="${BOTMUX_INSTALL_REPO:-lukecc00/botmux}"
REF="${BOTMUX_INSTALL_REF:-p/ai_open}"
PREFIX="${BOTMUX_INSTALL_PREFIX:-$HOME/.local}"
APP_HOME="$PREFIX/share/botmux"
BIN_DIR="$PREFIX/bin"
STAMP="$(date -u +%Y%m%d%H%M%S)-$$"
RELEASE_DIR="$APP_HOME/releases/$STAMP"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/botmux-install.XXXXXX")"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT HUP INT TERM

say() {
  printf '%s\n' "[botmux] $*"
}

fail() {
  printf '%s\n' "[botmux] ERROR: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v node >/dev/null 2>&1 || fail "Node.js 22+ is required"
command -v npm >/dev/null 2>&1 || fail "npm is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22+ is required (found $(node --version))"

ARCHIVE="$TMP_DIR/source.tar.gz"
SOURCE_DIR="$TMP_DIR/source"
URL="https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF"

say "Downloading latest $REPO@$REF"
# Keep the progress bar visible: codeload.github.com can be very slow on some
# networks, and silent curl otherwise makes a healthy download look hung.
# Abort only when transfer speed stays below 1 KiB/s for 30 seconds; do not use
# a fixed total timeout that would restart a large but steadily moving download.
curl -fL --progress-bar --connect-timeout 10 \
  --speed-limit 1024 --speed-time 30 --retry 5 --retry-delay 1 \
  --retry-all-errors "$URL" -o "$ARCHIVE"
mkdir -p "$SOURCE_DIR"
tar -xzf "$ARCHIVE" -C "$SOURCE_DIR" --strip-components=1
[ -f "$SOURCE_DIR/package.json" ] || fail "downloaded archive is not a botmux source tree"

# Use the repository-pinned pnpm version without relying on a globally working
# Corepack installation. npx caches it after the first successful install.
PNPM="npx --yes pnpm@9.5.0"
say "Installing locked dependencies"
(cd "$SOURCE_DIR" && $PNPM install --frozen-lockfile)
say "Building botmux"
(cd "$SOURCE_DIR" && $PNPM build)
[ -x "$SOURCE_DIR/dist/cli.js" ] || fail "build completed without dist/cli.js"

mkdir -p "$APP_HOME/releases" "$BIN_DIR"
mv "$SOURCE_DIR" "$RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$APP_HOME/current.new"
mv -f "$APP_HOME/current.new" "$APP_HOME/current"
ln -sfn "$APP_HOME/current/dist/cli.js" "$BIN_DIR/botmux.new"
mv -f "$BIN_DIR/botmux.new" "$BIN_DIR/botmux"

say "Installed $("$BIN_DIR/botmux" --version 2>/dev/null || printf '%s' "$REPO@$REF")"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Add to your shell profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
