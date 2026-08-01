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

环境变量 → **拉代码（同步上游 → 自动维护清单 → 重建并验证 rw-main）** → 重生成 terminal-webview → 服务端 → 安卓 APK → Windows x64 zip → 收尾还原 webview → 起 serve-dist 下载服务。

> **跳过拉代码（自测常用）**：用户明确说"不拉取最新代码""不同步上游代码"（或"不更新代码""用当前代码打包"等同义表达）时，**跳过拉代码这步**（打包流程.md 第 1 节），从重生成 terminal-webview 直接开始，其余流程不变。

## 固定 worktree 拓扑

- `/home/yangfei/Projects/paseo` 固定签出 `rw-main`，只在这里重建发行分支和生成三端产物；不要再切到 `main` 或 `chore/build-paseo`。
- `chore/build-paseo` 在独立 worktree 维护清单、脚本和文档；功能分支也各用自己的 worktree。所有 worktree 共享 Git refs，但各自保留独立源码、`dist`、`node_modules` 和构建缓存。
- 同步 `main` 时从 chore worktree 安全快进共享的本地 `main` ref；清单修改在 chore worktree 提交，随后回到固定主目录执行 `rebuild-rw-main.sh --push`。
- 开始前确认主目录确实为干净的 `rw-main`，chore 和清单内功能分支的 worktree 也都干净。不要为方便而在一个 worktree 内来回切分支，否则会重新制造“当前源码 + 上一分支 dist”的假错误。

## rw-main 清单自动维护

完整同步模式下，在重建前运行 `dwyanewang/sync-rw-main-branches.sh`：

- 自动检查 `rw-main-branches.txt` 中带 `PR #编号` 的条目。PR 已合入且本地 `main` 已包含其 merge commit 时，自动删除该条目。
- **不自动发现或加入所有开放 PR**。只有用户在本次指令中明确指定的新 PR/分支才长期加入清单，避免把 #1578 等有意排除的分支带回发行版。
- 用户说“把 PR #2345 加入 rw-main 清单”时传 `--add-pr 2345`；说“把 feat/example 作为长期个人分支加入清单”时传 `--add-branch feat/example`。多个参数严格保持用户给出的顺序。
- `--add-pr` 会从 `getpaseo/paseo` 解析源分支并要求 PR 归 `dwyanewang` 所有；`--add-branch` 作为无 PR 的长期个人分支处理。
- 若清单发生变化，运行 `npm run format`，确认只有清单发生预期变化，然后提交 `chore(build): sync rw-main branches` 并正常推送 `origin/chore/build-paseo`；无变化则不提交。
- 用户同时要求“新增 PR/分支”和“不拉取/不同步”时，停止并说明两者冲突：长期新增必须走完整同步、清单提交和 rw-main 重建，不能直接从当前代码开始打包。

可直接使用的描述：

```text
/build-paseo，把 PR #2345 加入 rw-main 清单后执行完整三端打包
/build-paseo，把 feat/example 作为长期个人分支加入清单，然后完整打包
```

同步代码时严格执行 `打包流程.md` 第 1 节：`main` 只做上游镜像，先在 chore worktree 同步清单，再在固定主目录运行 `dwyanewang/rebuild-rw-main.sh --push`，从清单整体生成个人发行分支。脚本输出 `No-op:` 表示现有 merge 链与全部输入完全一致；默认可复用，`--dry-run` 仍强制完整验证。**禁止继续把 main 或 rebase 后的 PR 分支追加合并到旧 rw-main。**

`rw-main` 重建是重型构建的 readiness gate。merge、format、typecheck、lint 任一失败时，禁止继续服务端、Android 或 Windows：

- 同一 workspace 内的源码 import 报“没有导出的成员”、helper 改名或参数不匹配，属于分支组合不兼容，**不是 `dist` 陈旧**。根据报错文件和 Git 归属定位源功能分支，在它自己的 worktree rebase 最新 `main`、修正、定向验证并 `--force-with-lease` 推送后，再重建 `rw-main`。
- 只有错误实际跨 workspace 解析生成声明（例如 client 读取 `packages/relay/dist/*.d.ts`）时，才按拥有方运行 `build:client` 或 `build:server`。不要看到 typecheck 失败就盲目重建整套声明。
- 本地 app Playwright 定向测试一律显式清空继承的主 daemon 密码：`PASEO_PASSWORD= npm run test:e2e --workspace=@getpaseo/app -- <spec>`。`.env.test` 没有该键并不会删除父进程已有变量。
- 不在临时候选或 `rw-main` 上直接修补产品源码。源分支修复通过后重新运行原子重建。

完整重建且未执行 `npm install` 时，服务端按权威流程复用重建阶段的 relay/protocol/client 声明，只补 highlight、server、CLI；no-op、重装依赖或状态不确定时运行完整 `build:server`。同轮 Windows 阶段只补 two-way-audio，单独从 Windows 开始则运行完整 `build:app-deps`。

**每步成功（校验产物）再进行下一步。**

## 铁律（最容易翻车的点，逐条照做）

- **不重启 6767 主 daemon**（会杀掉正在跑的 agent，包括自己）。
- **本地 app Playwright 定向测试必须带 `PASEO_PASSWORD=`**，隔离 daemon 不应继承 6767 主环境的密码。
- **环境变量每个构建 shell 都要显式 export**（`JAVA_HOME`/`ANDROID_HOME`/`PATH`，mise 没在 shell 激活）；shell state 不跨 Bash 调用，所以 export 与构建命令要写在**同一条**命令里。
- **长构建放后台**（gradle ~5–17min、electron-builder、expo export）；后台任务完成会自动通知，**不要主动轮询/定时唤醒**，等通知即可。
- **校验产物看 `ls -lh` 的 mtime 是不是本次**，别只信 exit code；用 `&&` 串命令、别用结尾 `echo` 兜底退出码（会把失败洗成成功）。
- **Windows expo export 用 bash 原生赋值**：`PASEO_WEB_PLATFORM=electron npx expo export`，**别用裸 `cross-env`**（不在 PATH，exit 127）。
- **Windows 只打 zip**（`--win zip`），不打 nsis。
- **Windows zip 固定快速压缩**：electron-builder 命令带 `ELECTRON_BUILDER_COMPRESSION_LEVEL=3`，仍使用标准 zip 目标；若它导致问题，去掉变量回退默认压缩。
- **收尾还原 terminal-webview**：三端打完 `git checkout -- packages/app/src/terminal/webview/terminal-emulator-webview-html.ts`，保持工作区干净（生成产物，别提交）。
- **打包成功后起下载服务**：`bash dwyanewang/serve-dist.sh`（端口 8800，3h 后自动停服清理，重跑重置 3h）。物理机浏览器拉取，地址以脚本输出为准。

## 完成后汇报

清单增删及对应提交（若有）+ 三端产物（路径 + 体积 + mtime）+ serve-dist 打印的下载地址。耗时从用户发起 `$build-paseo` 起算并报告真实墙钟；可以补充分阶段数据，但不得用热缓存阶段或剔除排障后的合计代替总时间。除版本化清单维护和源功能分支的必要兼容修复外，不在打包 worktree 修改或提交产品源码。
