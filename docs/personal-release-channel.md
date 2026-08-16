# 个人版发布与更新提醒

本分支的个人发行通道固定为：

- 仓库：`lukecc00/botmux`
- 分支：`p/ai_open`
- 权威版本清单：`dev-version.json`
- 安装方式：仓库根目录的 `install.sh`

## 用户如何安装

要接收个人版更新，用户必须通过个人版安装器安装：

```bash
curl -fsSL https://raw.githubusercontent.com/lukecc00/botmux/p/ai_open/install.sh | sh
```

安装器会把源码安装到 `~/.local/share/botmux/releases/`，并在当前版本旁写入受信的 `.botmux-install.json`。该文件固定记录个人仓库和分支，是后续更新检测与升级的供应链边界。

`npm install -g botmux` 安装的是官方 npm 通道，不属于个人版。个人版不会把这种安装静默切换到 fork；已有 npm 用户需要显式运行上面的个人版安装命令完成迁移，并确保 `~/.local/bin` 位于 `PATH` 前部。

## 用户会在哪里看到提示

个人版有两层提示：

1. Dashboard 的顶部版本红点和「版本与更新」页面会读取个人 manifest；成功结果缓存 30 分钟。
2. 主 daemon 启动 30 秒后检查一次，之后每小时调度、每 24 小时实际联网检查一次。发现新版本时，仅由主 Bot 私聊第一位可解析 owner；同一个目标版本只提醒一次。

提醒不会自行安装。用户可在 Dashboard 中执行更新，也可在宿主终端运行：

```bash
botmux upgrade
botmux restart
```

如果已单独开启 Dashboard 中的自动更新维护策略，则仍由该策略按自己的时间和繁忙门控执行；主动提醒本身始终只读。

本地 git checkout 没有 `.botmux-install.json`，不会收到主动私聊提醒，避免开发分支把自己误当成已发布安装。Dashboard 仍可显示版本差异，但不会提供不安全的自动切换。

## 版本如何判定

`p/ai_open` 上的 `dev-version.json` 是唯一权威版本源，例如：

```json
{
  "version": "3.2.9"
}
```

检测优先通过 HTTPS 读取该文件；若 raw GitHub 不可达，则通过 SSH 对固定分支做 partial clone，只读取同一个文件。不会扫描 fork 的全部 Git tag，因为同步官方仓库时也会同步官方 tag，不能据此判断个人版最新版。

GitHub Release 仅用于更新说明和发布校验，不会覆盖 manifest 的版本。SSH 获取更新说明时，也只读取 manifest 指定的同名 tag，不会把官方同步 tag 当成个人版发行。

## 发布一个新版本

先确保 `p/ai_open` 当前 HEAD 已完成测试，且这次提交就是要交付给安装器的源码，然后：

```bash
# 1. 修改 dev-version.json，例如 3.2.9，并提交到个人分支
git add dev-version.json
git commit -m "chore(release): 发布个人版 3.2.9"
git push origin p/ai_open

# 2. 在同一个 HEAD 创建 annotated tag，tag message 会成为 Release notes
git tag -a v3.2.9 -m "个人版 3.2.9 更新内容"
git push origin v3.2.9
```

Release workflow 会拒绝以下情况：

- tag 不是 annotated tag；
- tag 指向的提交不是远端 `p/ai_open` 当前 HEAD；
- tag 版本与 `dev-version.json` 不一致；
- 构建失败。

校验通过后，CI 创建个人仓库的 GitHub Release，但不会发布或覆盖官方 npm 包。

发布后可直接检查权威 manifest：

```bash
curl -fsSL https://raw.githubusercontent.com/lukecc00/botmux/p/ai_open/dev-version.json
```

已安装个人版的用户将在下一次有效检查窗口收到 Dashboard 红点和一次 owner 私聊提醒。
