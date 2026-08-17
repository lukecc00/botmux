#!/usr/bin/env bash
# 部署文档站：rspress 构建 → static 推到维护方资源仓库标签 → HTML 壳发飞书妙搭。
#
#   用法：./deploy.sh <版本号>     例：./deploy.sh 3   （把资源发到 tag docs-assets-v3）
#
# 前提：
#   - 已 `pnpm install`
#   - lark-cli 已登录妙搭域（lark-cli auth login --domain apps）
#   - 已设置 BOTMUX_DOCS_ASSET_REPO=owner/repository，并能 push 到该仓库
#
# 为什么这么绕：飞书妙搭只服务 HTML 页面、不服务本地 JS/CSS 资源，所以把构建产物 static/
# 放到维护方自己的 GitHub 仓库、用 CDN 提供资源，妙搭只发 HTML 壳。
set -euo pipefail

V="${1:?用法: ./deploy.sh <N>   N=资源 tag 版本号，例 3}"
TAG="docs-assets-v${V}"
APP_ID="${BOTMUX_DOCS_APP_ID:?请先设置 BOTMUX_DOCS_APP_ID}"
ASSET_REPO="${BOTMUX_DOCS_ASSET_REPO:?请先设置 BOTMUX_DOCS_ASSET_REPO=owner/repository}"
REPO="${BOTMUX_DOCS_ASSET_REPO_GIT_URL:-git@github.com:${ASSET_REPO}.git}"
ASSET_PREFIX="${BOTMUX_DOCS_ASSET_PREFIX:-https://cdn.jsdelivr.net/gh/${ASSET_REPO}@${TAG}/}"
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

echo "==> 构建（assetPrefix=${ASSET_PREFIX}）"
pnpm install --frozen-lockfile
BOTMUX_DOCS_ASSET_PREFIX="$ASSET_PREFIX" pnpm build

echo "==> 把 static/ 推到不可变 tag ${TAG}（孤儿提交，临时仓库隔离）"
TMP="$(mktemp -d)"
cp -r doc_build/static "$TMP/static"
( cd "$TMP" && git init -q && git add static \
  && git commit -q -m "docs assets ${TAG}" \
  && git tag -f "$TAG" && git push -f "$REPO" "$TAG" )
rm -rf "$TMP"

echo "==> 把 HTML 壳（去掉 static/）发到妙搭 ${APP_ID}"
HTMLDIR="$(mktemp -d)"
cp -r doc_build/* "$HTMLDIR"/ && rm -rf "$HTMLDIR/static"
( cd "$HTMLDIR" && lark-cli apps +html-publish --app-id "$APP_ID" --path . )
rm -rf "$HTMLDIR"

echo "==> 完成：文档应用 ${APP_ID} 已更新（资源 @${TAG}）"
