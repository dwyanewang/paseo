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

环境变量 → **拉代码（同步上游 → 自动维护清单 → 重建 rw-main）** → 重生成 terminal-webview → 服务端 → 安卓 APK → Windows x64 zip → 收尾还原 webview → 起 serve-dist 下载服务。

> **跳过拉代码（自测常用）**：用户明确说"不拉取最新代码""不同步上游代码"（或"不更新代码""用当前代码打包"等同义表达）时，**跳过拉代码这步**（打包流程.md 第 1 节），从重生成 terminal-webview 直接开始，其余流程不变。

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

同步代码时严格执行 `打包流程.md` 第 1 节：`main` 只做上游镜像，先同步清单，再运行 `dwyanewang/rebuild-rw-main.sh --push` 从清单整体生成个人发行分支。脚本输出 `No-op:` 表示现有 merge 链与全部输入完全一致；默认可复用，`--dry-run` 仍强制完整验证。**禁止继续把 main 或 rebase 后的 PR 分支追加合并到旧 rw-main。** 若清单同步或重建脚本失败，停止打包；分支冲突应先在源 PR 分支完成 rebase、冲突解决和测试。

完整重建且未执行 `npm install` 时，服务端按权威流程复用重建阶段的 relay/protocol/client 声明，只补 highlight、server、CLI；no-op、重装依赖或状态不确定时运行完整 `build:server`。同轮 Windows 阶段只补 two-way-audio，单独从 Windows 开始则运行完整 `build:app-deps`。

**每步成功（校验产物）再进行下一步。**

## 铁律（最容易翻车的点，逐条照做）

- **不重启 6767 主 daemon**（会杀掉正在跑的 agent，包括自己）。
- **环境变量每个构建 shell 都要显式 export**（`JAVA_HOME`/`ANDROID_HOME`/`PATH`，mise 没在 shell 激活）；shell state 不跨 Bash 调用，所以 export 与构建命令要写在**同一条**命令里。
- **长构建放后台**（gradle ~5–17min、electron-builder、expo export）；后台任务完成会自动通知，**不要主动轮询/定时唤醒**，等通知即可。
- **校验产物看 `ls -lh` 的 mtime 是不是本次**，别只信 exit code；用 `&&` 串命令、别用结尾 `echo` 兜底退出码（会把失败洗成成功）。
- **Windows expo export 用 bash 原生赋值**：`PASEO_WEB_PLATFORM=electron npx expo export`，**别用裸 `cross-env`**（不在 PATH，exit 127）。
- **Windows 只打 zip**（`--win zip`），不打 nsis。
- **Windows zip 固定快速压缩**：electron-builder 命令带 `ELECTRON_BUILDER_COMPRESSION_LEVEL=3`，仍使用标准 zip 目标；若它导致问题，去掉变量回退默认压缩。
- **收尾还原 terminal-webview**：三端打完 `git checkout -- packages/app/src/terminal/webview/terminal-emulator-webview-html.ts`，保持工作区干净（生成产物，别提交）。
- **打包成功后起下载服务**：`bash dwyanewang/serve-dist.sh`（端口 8800，3h 后自动停服清理，重跑重置 3h）。物理机浏览器拉取，地址以脚本输出为准。

## 完成后汇报

清单增删及对应提交（若有）+ 三端产物（路径 + 体积 + mtime）+ serve-dist 打印的下载地址。除版本化清单维护外，打包不修改或提交产品源码。
