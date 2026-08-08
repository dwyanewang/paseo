---
name: build-paseo
description: 一键执行 Paseo 三端本地打包（服务端 / Android ARM64 APK / Windows x64 zip）并启动下载服务。触发：/build-paseo，或用户说“打包 Paseo”“打 APK”“打 Windows 桌面端”“三端打包”等。
---

# Build Paseo

## 动手前

1. 完整读取仓库内 `dwyanewang/打包流程.md`，以其中的入口、决策和交付要求为准。
2. `dwyanewang/踩坑记录.md` 不再每轮通读；构建失败、资源数据异常或修改构建工具时，按错误文本/症状查询对应章节。
3. 记录用户发起打包的时间。绝不重启或触碰 6767 主 daemon。

## 固定拓扑

- 产品构建目录固定为 `/home/yangfei/Projects/paseo`，正常停留在 `rw-main`，保留 Gradle、Metro、NDK 和 Electron 缓存。
- 当前 `chore/build-paseo` worktree 是唯一控制面，保存清单、脚本和文档，不合并进 `rw-main`。
- 有改动、detached HEAD、分支 worktree 不洁净或拓扑不符时停止；不 stash、不覆盖用户改动。

## 完整同步与 readiness gate

从控制面只调用一个前置命令；用户指定的新 PR/分支按原顺序追加 `--add-pr` / `--add-branch`：

```bash
paseo_preflight_state=/home/yangfei/Projects/paseo/.dev/build-paseo-preflight.env
bash "$paseo_chore_root/dwyanewang/prepare-rw-main-for-build.sh" \
  --build-root /home/yangfei/Projects/paseo \
  --state-file "$paseo_preflight_state" \
  --push
```

- 退出码 `3`：逐项完成报告要求的语义审查。未吸收则保留；完整吸收则传 `--remove-branch`；部分吸收则回源功能分支 rebase、删重、定向验证并推送；结论不明则询问用户。之后传 `--accept-main-review <当前 main 完整 SHA>` 重跑。
- 退出码 `4`：清单已更新但尚未 ready。运行 `npm run format`，确认仅有预期清单改动，提交并推送 `chore/build-paseo`，再不带增删参数重跑。
- 其他非零退出：停止并诊断。readiness gate 未成功，不得启动任一产物构建。

## 正式产物链

ready 后把同一个 state 文件交给版本化脚本；把整个命令作为一个长后台任务运行，等待平台的输出/完成通知，不现场拼 heredoc，也不定时轮询：

```bash
bash "$paseo_chore_root/dwyanewang/build-paseo-artifacts.sh" \
  --build-root /home/yangfei/Projects/paseo \
  --preflight-state "$paseo_preflight_state"
```

只有用户明确要求“不拉取/不同步”时才跳过前置并改传 `--skip-preflight`；它要求当前 checkout 洁净并走保守完整构建。新增 PR/分支与跳过同步互相冲突。脚本统一负责 mise、旧产物标记、terminal-webview 清理、服务端、Android 两段画像、Windows zip、产物校验和下载服务；不要在代理侧重复这些实现细节。

## 失败与交付

- 修改任意 `dwyanewang/*.sh` 或对应测试后，提交前运行 `bash "$paseo_chore_root/dwyanewang/check-build-paseo.sh"`；它只做 Shell 语法和定向构建控制测试，不代替真实三端打包。
- 任一步非零即停止，保留真实退出码。失败时按日志症状查询 `踩坑记录.md`；兼容修复只能落在源功能分支，不能直接修改临时候选或 `rw-main`。
- 证据优先读取 `.dev/build-paseo-runs/<轮次>/result.env`、`stages.log`、`build.log` 和 Android 两份 summary。
- 汇报清单增删与提交、三端产物路径/体积/mtime、Android 两段核心资源数据、下载地址，以及从用户消息到下载服务就绪的真实总墙钟；脚本自己的产物链计时只作分段数据。
