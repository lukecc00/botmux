#!/bin/sh
set -eu

REPO="lukecc00/botmux"
REF="p/ai_open"
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
attempt=1
while :; do
  if git clone --depth 1 --filter=blob:none --single-branch --branch "$REF" --progress "$URL" "$SOURCE_DIR"; then
    break
  fi
  rm -rf "$SOURCE_DIR"
  [ "$attempt" -lt 3 ] || fail "failed to download $REPO@$REF after 3 attempts"
  say "Download failed (attempt $attempt/3); retrying..."
  attempt=$((attempt + 1))
  sleep "$attempt"
done
REVISION="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
SHORT_REVISION="$(printf '%.8s' "$REVISION")"
VERSION="$(node -p "require(process.argv[1]).version" "$SOURCE_DIR/dev-version.json")"
rm -rf "$SOURCE_DIR/.git"
[ -f "$SOURCE_DIR/package.json" ] || fail "downloaded archive is not a botmux source tree"

# Prefer the repository-pinned pnpm from Corepack's local cache so updates keep
# working when npm/raw.githubusercontent.com are temporarily unreachable. Fall
# back to PATH, then npx only on a truly fresh machine.
COREPACK_PNPM="$HOME/.cache/node/corepack/v1/pnpm/9.5.0/bin/pnpm.cjs"
if [ -f "$COREPACK_PNPM" ]; then
  PNPM_CMD="node $COREPACK_PNPM"
elif command -v pnpm >/dev/null 2>&1; then
  PNPM_CMD="pnpm"
else
  PNPM_CMD="npx --yes pnpm@9.5.0"
fi
say "Installing locked dependencies"
(cd "$SOURCE_DIR" && $PNPM_CMD install --frozen-lockfile)
say "Building botmux"
(cd "$SOURCE_DIR" \
  && node scripts/clean-dist.mjs \
  && ./node_modules/.bin/tsc \
  && cp src/setup/lark-scopes.json dist/setup/ \
  && node scripts/build-dashboard.mjs \
  && chmod +x dist/cli.js \
  && node scripts/audit-dist.mjs)
[ -x "$SOURCE_DIR/dist/cli.js" ] || fail "build completed without dist/cli.js"

# Persist the source identity beside the built release. Future CLI, Dashboard,
# and scheduled updates read this file and return to the same personal repo.
BOTMUX_META_REPO="$REPO" BOTMUX_META_REF="$REF" \
BOTMUX_META_REVISION="$REVISION" BOTMUX_META_VERSION="$VERSION" \
BOTMUX_META_PREFIX="$PREFIX" node -e '
  const fs = require("fs");
  const path = require("path");
  const info = {
    schemaVersion: 1, method: "github-source",
    repo: process.env.BOTMUX_META_REPO, ref: process.env.BOTMUX_META_REF,
    revision: process.env.BOTMUX_META_REVISION, version: process.env.BOTMUX_META_VERSION,
    prefix: path.resolve(process.env.BOTMUX_META_PREFIX), installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(process.argv[1], ".botmux-install.json"), JSON.stringify(info, null, 2) + "\n");
' "$SOURCE_DIR"

mkdir -p "$APP_HOME/releases" "$BIN_DIR"
mv "$SOURCE_DIR" "$RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$APP_HOME/current.new"
mv -f "$APP_HOME/current.new" "$APP_HOME/current"
ln -sfn "$APP_HOME/current/dist/cli.js" "$BIN_DIR/botmux.new"
mv -f "$BIN_DIR/botmux.new" "$BIN_DIR/botmux"

say "Installed v$VERSION ($REPO@$REF, $SHORT_REVISION)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "Add to your shell profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
