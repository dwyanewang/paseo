---
name: build-paseo
description: 执行 Paseo 本地打包，可选服务端、Android ARM64 APK、Windows x64 zip，支持不拉取代码时临时叠加本地测试分支并启动所选产物的下载服务。触发：/build-paseo，或用户说“打包 Paseo”“打 APK”“打 Windows 桌面端”“三端打包”等。
---

# Build Paseo

## 动手前

1. 完整读取仓库内 `dwyanewang/打包流程.md`，以其中的入口、决策和交付要求为准。
2. `dwyanewang/踩坑记录.md` 不再每轮通读；构建失败、资源数据异常或修改构建工具时，按错误文本/症状查询对应章节。
3. 记录用户发起打包的时间。绝不重启或触碰 6767 主 daemon。

## 固定拓扑

- 产品构建目录固定为 `/home/yangfei/Projects/paseo`，正常停留在 `rw-main`，保留 Gradle、Metro、NDK 和 Electron 缓存。
- 当前 `chore/build-paseo` worktree 是唯一控制面，保存清单、脚本和文档，不合并进 `rw-main`。
- `main` 镜像上游，`rw-base` 保存可追溯长期功能，`rw-main` 是 `rw-base` 加临时叠加层的最终产品树。禁止直接修改两个 rw 分支。
- 有改动、detached HEAD、分支 worktree 不洁净或拓扑不符时停止；不 stash、不覆盖用户改动。

## 模式选择

- 默认：完整同步并重建正式 `rw-main`，走下节 readiness gate。
- 用户明确要求“不拉取/不同步”，且没有临时测试分支：正式产物脚本传 `--skip-preflight`，构建当前洁净 checkout。
- 用户明确要求“不拉取/不同步”并临时加入测试分支：正式产物脚本同时传可重复的 `--local-branch BRANCH`。脚本在同一把锁内从当前 `rw-main` 创建 `rw-local-build-*` 候选，冻结分支 SHA、合并、运行声明刷新和 format/typecheck/lint，成功或失败后自动恢复 `rw-main` 并删除候选。它不 fetch、不修改 [`rw-main-branches.txt`](../../rw-main-branches.txt)、不移动产品 refs、不推送。

`--local-branch` 只与 `--skip-preflight` 同用。源分支必须存在；若有 worktree 则必须洁净。不要为了临时测试把分支写入持久清单。

## 完整同步与 readiness gate

从控制面只调用一个前置命令；用户指定的新 PR/临时叠加分支按原顺序追加 `--add-pr` / `--add-branch`：

```bash
paseo_preflight_state=/home/yangfei/Projects/paseo/.dev/build-paseo-preflight.env
bash "$paseo_chore_root/dwyanewang/prepare-rw-main-for-build.sh" \
  --build-root /home/yangfei/Projects/paseo \
  --state-file "$paseo_preflight_state" \
  --push
```

- 退出码 `3`：读取输出的 `PASEO_REVIEW_REQUEST_FILE` 并把值保存为 `paseo_review_request_file`。只有一个简单待审分支时由主代理审查；有至少两个独立待审分支时，按 request 中冻结的精确 SHA 区间启动最多 3 个只读 reviewer subagent 并行审查，禁止它们改文件、移动 refs 或运行测试。每项固定返回分支名、main/head 区间、`keep|remove|partial|uncertain`、提交/路径证据和所需动作。主代理核对待审集合和全部坐标；`partial` 则回源功能分支修整、定向验证并推送，`uncertain` 则询问用户。只有全部为 `keep|remove` 时，传 `--accept-review-request "$paseo_review_request_file"` 和必要的 `--remove-branch` 重跑；不要退回 main-only 接受方式。
- 退出码 `4`：清单已更新但尚未 ready。运行 `npm run format`，确认仅有预期清单改动，提交并推送 `chore/build-paseo`，再不带增删参数重跑。
- 其他非零退出：停止并诊断。readiness gate 未成功，不得启动任一产物构建。

前置脚本、长期功能管理与正式产物脚本使用同一把非阻塞锁。ready state 同时冻结控制面 HEAD、`main`、`rw-base` 和 `rw-main`，正式脚本会在删除旧产物前再次核对。

## 长期功能

- 用户明确要求把功能固化到基线时，完整读取 `打包流程.md` 第 1.3 节并使用 `manage-rw-base.sh promote|maintain|retire|status`；不要把它重新加入临时叠加清单。
- 退出码 `5` 表示生命周期操作保留了冲突 worktree。保存输出的 `PASEO_RW_BASE_OPERATION`；解决并 `git add` 后用 `continue --operation`，或用 `abort --operation` 放弃。不得手工移动 `rw-base`/`rw-main`。

## 正式产物链与端选择

ready 后把同一个 state 文件交给版本化脚本；把整个命令作为一个长后台任务运行，等待平台的输出/完成通知，不现场拼 heredoc，也不定时轮询：

```bash
bash "$paseo_chore_root/dwyanewang/build-paseo-artifacts.sh" \
  --build-root /home/yangfei/Projects/paseo \
  --preflight-state "$paseo_preflight_state"
```

按用户要求追加可重复的 `--target server|android|windows`；`desktop` 是 `windows` 别名。未传 `--target` 时保持三端默认。只选 Windows 时仍构建其内嵌 daemon 所需的 server/CLI 依赖，但只交付 Windows zip；只选 Android 时构建 app 依赖，不构建 Windows；只选 server 时不生成移动/桌面产物且不启动下载服务。

不拉取并临时测试一个 Windows 分支的标准命令：

```bash
bash "$paseo_chore_root/dwyanewang/build-paseo-artifacts.sh" \
  --build-root /home/yangfei/Projects/paseo \
  --skip-preflight \
  --local-branch fix/example \
  --target windows
```

脚本统一负责整轮独占锁、mise、临时分支清理、所选旧产物标记、terminal-webview 清理、依赖构建、Android/Windows 画像、三端同时选择时的 Android bundle gate 与 16 GiB 并发判定、产物校验和按目标下载服务；不要让多个 subagent 各自启动平台构建，也不要在代理侧重复这些实现细节。

## 失败与交付

- 修改任意 `dwyanewang/*.sh` 或对应测试后，提交前运行 `bash "$paseo_chore_root/dwyanewang/check-build-paseo.sh"`；它只做 Shell 语法和定向构建控制测试，不代替真实产物打包。
- 任一步非零即停止，保留真实退出码。失败时按日志症状查询 `踩坑记录.md`；临时叠加修复回源分支，长期功能修复经 `maintain`，不能直接修改候选、`rw-base` 或 `rw-main`。
- 证据优先读取 `.dev/build-paseo-runs/<轮次>/result.env`、`stages.log`、已选择端的分支日志、`build.log` 和资源 summary。核对 `paseo_artifact_targets`、`paseo_artifact_preflight_mode` 与临时分支 SHA。
- 只汇报所选端的产物路径/体积/mtime和资源数据；同时选择 Android 与 Windows 时再汇报并发/回退模式。还要汇报临时分支及冻结 SHA、下载地址，以及从用户消息到下载服务就绪的真实总墙钟；脚本自己的产物链计时只作分段数据。
