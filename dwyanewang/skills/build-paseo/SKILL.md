---
name: build-paseo
description: 一键执行 Paseo 三端本地打包（服务端 / 安卓 APK / Windows x64 zip）并起下载服务。动手前先读仓库内 dwyanewang/打包流程.md、踩坑记录.md，再严格按流程逐步执行。触发：用户输入 /build-paseo，或自然语言说"打包"、"打包 paseo"、"打 APK"、"打 Windows 桌面端"、"按流程打包"、"三端打包"等。
---

# Build Paseo 三端本地打包

一键走完 Paseo 的服务端 / 安卓 / Windows 本地打包，替代每次手输"读取 memory 文件，严格按照打包流程和踩坑记录打包"。

## 触发场景

- 斜杠：`/build-paseo`
- 自然语言：用户说"打包"、"打包 paseo"、"打 APK"、"打 Windows 桌面端"、"按流程打包"、"三端打包"等

## 第一步（必做）：读权威文档

动手前**先读仓库内这两份**——跟仓库走、一定在，是打包的权威流程，命令与顺序以它们为准：

1. `dwyanewang/打包流程.md` —— 完整命令、顺序与校验
2. `dwyanewang/踩坑记录.md` —— 已知坑与排查

若 memory 里有 `paseo-build-workflow`（随 MEMORY.md 索引出现），一并读作补充；但它在 `~/.claude` 下、换机器会丢，**冲突时以仓库内两份文档为准**。

## 执行顺序（细节看打包流程.md）

激活仓库 mise 环境 → **拉代码（同步上游 → 自动维护清单 → 重建并验证 rw-main）** → `prepare-build` 清除精确旧产物并写本轮标记 → 重生成 terminal-webview → 服务端 → Android prebuild 后配置 Metro transform cache/worker → 安卓 APK → Windows x64 zip → 收尾还原 webview → 起 serve-dist 下载服务。

> **跳过拉代码（自测常用）**：用户明确说"不拉取最新代码""不同步上游代码"（或"不更新代码""用当前代码打包"等同义表达）时，**跳过拉代码这步**（打包流程.md 第 1 节），从重生成 terminal-webview 直接开始，其余流程不变。

## 固定 worktree 拓扑

- `/home/yangfei/Projects/paseo` 是专用构建 worktree，正常应停留在 `rw-main` 并保留 Android/Gradle/Electron 缓存。若开始时处于其他分支，只要工作区干净且不是 detached HEAD，重建脚本会安全切换并在成功后停留于 `rw-main`；有改动则立即停止，不 stash、不覆盖。
- `chore/build-paseo` 是唯一构建控制面，只维护清单、脚本和文档，**不再合并进 `rw-main`**。功能分支也各用自己的 worktree；所有 worktree 共享 Git refs，但各自保留源码、`dist`、`node_modules` 和构建缓存。
- 同步 `main` 时先查它是否已被某个 worktree 签出：已签出就在那个干净 worktree 执行 `merge --ff-only upstream/main`，未签出才从 chore worktree 用 `branch -f` 安全快进共享 ref；无法快进或对应 worktree 有改动时停止并报告路径。
- 清单修改和脚本调用都在 chore worktree 发起，但候选合并、仓库检查和分支切换必须通过 `--build-root /home/yangfei/Projects/paseo` 在专用构建 worktree 执行。开始前确认 chore、build root 和清单内功能分支的 worktree 都干净。

## rw-main 清单自动维护

完整同步模式下，在重建前运行 `dwyanewang/sync-rw-main-branches.sh`：

- 自动检查 `rw-main-branches.txt` 中带 `PR #编号` 的条目。PR 已合入且本地 `main` 已包含其 merge commit 时，自动删除该条目。
- 每个清单项都带 `reviewed-main:<SHA>` 与 `reviewed-head:<SHA>`，分别记录该分支上次审查时的上游 main 和功能分支 head。各分支基线独立；`main`、任一分支 head 前进或本次新增功能分支时，脚本按项列出自己的 main/head 审查区间、PR、独有/等价补丁和路径重叠证据，然后以退出码 `3` 暂停；这不是脚本故障。
- 收到退出码 `3` 后必须逐项浏览报告中的全部提交主题和路径。新分支从自己的 `merge-base(main, branch)` 开始；已有分支从自己的 `reviewed-main` 开始，分支 head 变化还要检查 `reviewed-head..当前 head`。任何可能覆盖同一用户能力的提交都继续查看 PR 说明和完整 diff。路径或 patch 等价只用于优先检查，不能证明语义相同或不同。
- 明确未吸收的分支保留；明确完整吸收的分支在确认命令中传 `--remove-branch <分支>`；部分吸收时先在该功能分支 worktree rebase 最新 `main`、删除重复部分并定向验证/推送，再重新审查。结论不明确时询问用户，禁止确认或继续重建。
- 审查结束后传 `--accept-main-review "$(git rev-parse main)"`，同步脚本会把每个保留项的两个坐标原子更新为当前 main/head。只接受当前 `main` 的完整 SHA；任一项的 main 或 head 未对齐时，`rebuild-rw-main.sh`（包括 `--dry-run`）会在 merge/npm 前拒绝执行。
- **不自动发现或加入所有开放 PR**。只有用户在本次指令中明确指定的新 PR/分支才长期加入清单，避免把 #1578 等有意排除的分支带回发行版。
- 用户说“把 PR #2345 加入 rw-main 清单”时传 `--add-pr 2345`；说“把 feat/example 作为长期个人分支加入清单”时传 `--add-branch feat/example`。多个参数严格保持用户给出的顺序。
- `--add-pr` 会从 `getpaseo/paseo` 解析源分支并要求 PR 归 `dwyanewang` 所有；`--add-branch` 作为无 PR 的长期个人分支处理。
- 若清单发生变化（包括只推进任一项的审查坐标），运行 `npm run format`，确认只有清单发生预期变化，然后提交 `chore(build): sync rw-main branches` 并正常推送 `origin/chore/build-paseo`。提交正文记录各分支审查区间，以及删除/修整项对应的上游提交或 PR；无变化则不提交。
- 用户同时要求“新增 PR/分支”和“不拉取/不同步”时，停止并说明两者冲突：长期新增必须走完整同步、清单提交和 rw-main 重建，不能直接从当前代码开始打包。

可直接使用的描述：

```text
/build-paseo，把 PR #2345 加入 rw-main 清单后执行完整三端打包
/build-paseo，把 feat/example 作为长期个人分支加入清单，然后完整打包
```

同步代码时严格执行 `打包流程.md` 第 1 节：`main` 只做上游镜像，先在 chore worktree 同步清单，再从 chore worktree 调用：

```bash
bash "$paseo_chore_root/dwyanewang/rebuild-rw-main.sh" \
  --build-root /home/yangfei/Projects/paseo \
  --push
```

`rw-main` 只由 `main` 和清单内功能分支组成。脚本输出 `No-op:` 表示现有产品 merge 链与全部输入完全一致；默认可复用，`--dry-run` 仍强制完整验证。从非 `rw-main` 分支进入时会无条件运行 `npm install`；原本已在 `rw-main` 时，仅当 package、lockfile、`patches/**` 或 postinstall 补丁脚本变化才安装。**禁止继续把 chore、main 或 rebase 后的 PR 分支追加合并到旧 rw-main。**

`rw-main` 重建是重型构建的 readiness gate。merge、format、typecheck、lint 任一失败时，禁止继续服务端、Android 或 Windows：

- 同一 workspace 内的源码 import 报“没有导出的成员”、helper 改名或参数不匹配，属于分支组合不兼容，**不是 `dist` 陈旧**。根据报错文件和 Git 归属定位源功能分支，在它自己的 worktree rebase 最新 `main`、修正、定向验证并 `--force-with-lease` 推送后，再重建 `rw-main`。
- 只有错误实际跨 workspace 解析生成声明（例如 client 读取 `packages/relay/dist/*.d.ts`）时，才按拥有方运行 `build:client` 或 `build:server`。不要看到 typecheck 失败就盲目重建整套声明。
- 本地 app Playwright 定向测试一律显式清空继承的主 daemon 密码：`PASEO_PASSWORD= npm run test:e2e --workspace=@getpaseo/app -- <spec>`。`.env.test` 没有该键并不会删除父进程已有变量。
- 不在临时候选或 `rw-main` 上直接修补产品源码。源分支修复通过后重新运行原子重建。

完整重建且未执行 `npm install` 时，服务端按权威流程复用重建阶段的 relay/protocol/client 声明，只补 highlight、server、CLI；no-op、重装依赖或状态不确定时运行完整 `build:server`。同轮 Windows 阶段只补 two-way-audio，单独从 Windows 开始则运行完整 `build:app-deps`。

**每步成功（校验产物）再进行下一步。** 任何非零退出立即停止，不得用结尾 `echo` 覆盖状态；生成 terminal-webview 前确认该文件原本干净，并安装 `EXIT` trap，使成功或失败都只还原这个生成文件。

## 铁律（最容易翻车的点，逐条照做）

- **不重启 6767 主 daemon**（会杀掉正在跑的 agent，包括自己）。
- **本地 app Playwright 定向测试必须带 `PASEO_PASSWORD=`**，隔离 daemon 不应继承 6767 主环境的密码。
- **环境从仓库 pin 获取**：进入 build root 后激活 mise，使用 `.tool-versions` 的 Java 21 / Android SDK 21.0 和 `.mise.toml` 的路径；不要硬编码 mise 安装目录。Windows 始终导出 `WINEPREFIX="$HOME/.local/share/paseo/wineprefix"`，不使用或删除默认 `~/.wine`。
- **每次 Android prebuild 后运行** `configure-android-build.sh --build-root "$paseo_build_root" --metro-workers 4`。它用 Expo 支持的后置 `--reset-cache false` 保留内容寻址的 Metro transform cache，并验证当前依赖仍支持该覆盖；不复用最终 bundle，也不跳过 Hermes。
- **长构建放后台**（gradle ~5–17min、electron-builder、expo export）；后台任务完成会自动通知，**不要主动轮询/定时唤醒**，等通知即可。
- **构建前先运行** `bash "$paseo_chore_root/dwyanewang/serve-dist.sh" prepare-build`。它从根 `package.json` 锁定版本、删除精确目标 APK/zip 并记录起点；下载脚本只接受标记之后生成的这两个文件。仍查看体积/mtime，但不再靠“最新 zip”猜本轮产物。
- **Windows expo export 用 bash 原生赋值**：`PASEO_WEB_PLATFORM=electron npx expo export`，**别用裸 `cross-env`**（不在 PATH，exit 127）。
- **Windows 只打 zip**（`--win zip`），不打 nsis。
- **Windows zip 固定快速压缩**：electron-builder 命令带 `ELECTRON_BUILDER_COMPRESSION_LEVEL=3`，仍使用标准 zip 目标；若它导致问题，去掉变量回退默认压缩。
- **收尾还原 terminal-webview**：打包前要求该文件无既有改动；随后用 `EXIT` trap 执行精确的 `git restore --worktree -- packages/app/src/terminal/webview/terminal-emulator-webview-html.ts`，中途失败也必须清理，且不还原其他文件。
- **打包成功后起下载服务**：从控制面运行 `bash "$paseo_chore_root/dwyanewang/serve-dist.sh"`（端口 8800，3h 后自动停服清理，重跑重置 3h）。脚本拒绝 6767 和非法 PORT/TTL，只管理状态文件中身份匹配的自有进程；未知端口占用时停止并报告，绝不杀进程。`rw-main` 不携带该脚本；物理机地址以输出为准。
- **Tailscale 是可选直连通道**：`serve-dist.sh` 会优先探测已登录的原生 Tailscale，其次复用已授权的 `paseo-tailscale-download` Docker 容器；容器存在但停止时自动启动，并在服务输出中给出 Tailnet 地址。首次安装/网页登录不是打包 gate，未就绪只保留 LAN 下载地址，不能让构建失败。

## 完成后汇报

清单增删及对应提交（若有）+ 三端产物（路径 + 体积 + mtime）+ serve-dist 打印的下载地址。耗时从用户发起 `$build-paseo` 起算并报告真实墙钟；可以补充分阶段数据，但不得用热缓存阶段或剔除排障后的合计代替总时间。除版本化清单维护和源功能分支的必要兼容修复外，不在打包 worktree 修改或提交产品源码。
