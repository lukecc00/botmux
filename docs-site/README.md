# AI CLI 文档站

中英文功能文档站，基于 [Rspress](https://rspress.dev/) 构建。文档源码位于 `docs/`，构建配置位于 `rspress.config.ts`。

## 本地预览

```bash
cd docs-site
pnpm install
pnpm dev
```

生产构建：

```bash
pnpm build
```

产物写入 `doc_build/`。默认情况下页面与静态资源都使用 `BOTMUX_DOCS_BASE`（未设置时为 `/`），不会请求上游仓库资源。

## 托管配置

普通静态托管直接发布完整的 `doc_build/` 即可。部署到子路径时同时设置文档基址和同源资源前缀，例如：

```bash
BOTMUX_DOCS_BASE=/docs/ BOTMUX_DOCS_ASSET_PREFIX=/docs/ pnpm build
```

若托管平台只服务 HTML、不服务打包出的 JS/CSS，可显式把静态资源放到自己的 CDN：

```bash
BOTMUX_DOCS_BASE=/docs/ \
BOTMUX_DOCS_ASSET_PREFIX=https://cdn.example.com/ai-cli-docs/ \
pnpm build
```

当前仓库的 CI/Pages 目标由 `.github/workflows/docs-deploy.yml` 配置；文档内容本身不绑定外部官方站点。

## 妙搭镜像

`deploy.sh` 可将 `static/` 发布到维护方自己的 GitHub 仓库标签，并把 HTML 壳发布到妙搭。执行前设置：

- `BOTMUX_DOCS_APP_ID`：妙搭应用 ID；
- `BOTMUX_DOCS_BASE`：妙搭路由基址；
- `BOTMUX_DOCS_ASSET_REPO`：用于保存静态资源标签的 `owner/repository`；
- `BOTMUX_DOCS_ASSET_REPO_GIT_URL`：可选，资源仓库的 Git push 地址；
- `BOTMUX_DOCS_ASSET_PREFIX`：可选，完整 CDN 前缀；未设置时按资源仓库和标签生成 jsDelivr 地址。

```bash
cd docs-site
BOTMUX_DOCS_APP_ID=... \
BOTMUX_DOCS_BASE=/docs/ \
BOTMUX_DOCS_ASSET_REPO=owner/repository \
./deploy.sh 30
```

每次发布使用新的版本号，避免不可变 CDN 缓存复用旧资源。

## 内容约定

- 页面间跳转使用站内路由，如 `[文字](/relay)`；
- 新增页面后在 `rspress.config.ts` 的 sidebar 中注册；
- 视频放在 `.mdx` 中，以 JSX `<video>` 标签嵌入；
- 图片使用项目自有或明确授权的资源地址。
