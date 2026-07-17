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

command -v git >/dev/null 2>&1 || fail "git is required"
command -v node >/dev/null 2>&1 || fail "Node.js 22+ is required"
command -v npm >/dev/null 2>&1 || fail "npm is required"

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js 22+ is required (found $(node --version))"

SOURCE_DIR="$TMP_DIR/source"
URL="https://github.com/$REPO.git"

say "Downloading latest $REPO@$REF"
# Git reports counting, compressing, receiving, and resolving percentages even
# when GitHub's archive endpoint does not provide a Content-Length header.
git clone --depth 1 --single-branch --branch "$REF" --progress "$URL" "$SOURCE_DIR"
rm -rf "$SOURCE_DIR/.git"
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
