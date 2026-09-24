---
name: build-paseo
description: 执行 Paseo 本地打包，可选服务端、Android ARM64 APK、Windows x64 zip，支持不拉取代码时临时叠加本地测试分支并启动所选产物的下载服务。触发：/build-paseo，或用户说“打包 Paseo”“打 APK”“打 Windows 桌面端”“三端打包”等。
---

# Build Paseo

## 动手前

1. 完整读取仓库内 `dwyanewang/打包流程.md`，以其中的入口、决策和交付要求为准。
2. `dwyanewang/踩坑记录.md` 不再每轮通读；构建失败、资源数据异常或修改构建工具时，按错误文本/症状查询对应章节。
3. 记录用户发起打包的 epoch 秒为 `paseo_requested_at`，生成本轮唯一 `paseo_run_id`；整个请求（含审查、修复、重试）沿用它们。prepare 强制要求显式 `--run-id`，漏传时在同步和状态清理前拒绝；不能为一次重试重新生成 ID。不能恢复消息时间时明确标注计时起点，不把首次命令时间冒充消息时间。绝不重启或触碰 6767 主 daemon。

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

首次从控制面调用前置命令；一次收齐本轮清单变更，用户指定的新 PR/临时叠加分支按原顺序追加 `--add-pr` / `--add-branch`，已有分支改 PR 用 `--update-pr BRANCH NUMBER`：

```bash
paseo_preflight_state=/home/yangfei/Projects/paseo/.dev/build-paseo-preflight.env
bash "$paseo_chore_root/dwyanewang/prepare-rw-main-for-build.sh" \
  --build-root /home/yangfei/Projects/paseo \
  --run-id "$paseo_run_id" --requested-at "$paseo_requested_at" \
  --state-file "$paseo_preflight_state" \
  --push
```

首次同步后固定本轮 main 快照，并向请求目录的 `main.refreshes` 追加 `initial` 事件。后续每次 prepare（包括接受审查和提交清单后重建）保留 `--run-id` 并加 `--no-fetch`；它仍检查洁净度、上游祖先和精确审查坐标，不是 `--skip-preflight`。只有明确刷新本轮上游时改用 `--refresh-main`，随后重新审查失效 request；刷新会追加 `refresh` 事件而不改变 `main.snapshot` 的单行格式。源分支修复必须 rebase 本轮快照 main，不能借 overlay 带入更晚的上游。

前置日志保存在产品目录 `.dev/build-paseo-runs/$paseo_run_id/`。审查、源分支修复、提交开始/结束时，用 `build-paseo-state.sh` 的 `paseo_build_stage` 追加事件到同目录 `preflight-stages.log`（设置 `PASEO_BUILD_REQUEST_STAGE_LOG`）；命令阶段、失败状态和正式产物阶段由脚本自动记录。`PASEO_BUILD_STAGE_LOG` 仅是产物 attempt 日志的输出路径，不能作为请求日志输入。请求目录还保存快照和起点，完成或明确放弃前不能清理。不要只累计成功阶段。

- 退出码 `3`：读取输出的 `PASEO_REVIEW_REQUEST_FILE` 并把值保存为 `paseo_review_request_file`。只有一个简单待审分支时由主代理审查；有至少两个独立待审分支时，按 request 中冻结的精确 SHA 区间启动最多 3 个只读 reviewer subagent 并行审查，禁止它们改文件、移动 refs 或运行测试。每项固定返回分支名、main/head 区间、`keep|remove|partial`、提交/路径证据和所需动作。主代理核对待审集合和全部坐标，并由 AI 自行完成接受决策；不向用户请求人工确认。
- rebase 后优先使用报告中的 `git range-diff`：若旧 feature commits 均能与新 commits 对应，且变化仅限冲突解决带来的必要调整，执行增量语义审查；否则执行完整区间审查。AI 必须继续查看冲突解决 diff、路径和验证结果，不能仅凭 patch 等价自动接受。
- 同一 request 中某分支已完成最终 `keep|remove` 审查、但另一分支要回源时，在其他分支 head 改变之前，把该分支的非空证据文件通过 prepare 的 `--record-review-result REQUEST BRANCH DECISION EVIDENCE` 记录；旧 request 已失效则先生成新 request。同 run 后续 request 会按 branch 行、PR 映射和规则哈希精确复用；`remove` 仍须最终显式传 `--remove-branch`。该缓存不免除依赖替代、冲突、组合验证或 readiness。
- 记录命令必须带原 `--run-id --no-fetch`；成功退出 `0` 并打印 `PASEO_PREFLIGHT_STATUS=review-recorded`，只代表证据已记录，不继续重建、不接受清单、不生成 ready state。完成其余审查后另行接受清单，不能把记录成功当作已可打包。
- `partial` 则回源功能分支修整、定向验证并推送。`uncertain` 只作为 AI 内部中间态：继续扩大证据范围；仍无法证明上游完整吸收时默认 `keep`，不得自动 `remove`。必须等所有 reviewer 的最终结论返回且集合、坐标核对一致，才能传 `--accept-review-request "$paseo_review_request_file"` 接受；中途的 keep 不算最终结论。接受轮原样重传 request 轮的新增和 PR 重映射参数，再加必要的 `--remove-branch`，并使用同一 `--run-id --no-fetch`；不要退回 main-only 接受方式。
- 完整同步的前置命令会在语义审查 request 输出前运行一次只读 mergeability 预检：在临时 detached worktree 中按真实顺序模拟 `rw-base + main + overlays` 的合并。支持的文本/`.patch` 冲突只诊断具体阶段和文件，继续原 exit 3/4；未支持冲突仍停止。预检不解决冲突、不学习 rerere、不移动 `rw-base`/`rw-main`、不改清单、不安装依赖，也不运行构建。预检打印冲突文件时，主代理在审查等待期按 `打包流程.md` 第 1.1 节，把冲突路径的直接回归在冲突一方的冻结 head 和 main 快照上各跑一次；该方红而 main 绿即基线测试债，立即回源修复，与审查并行。
- 支持的文本冲突优先在 operation 内解决，不因冲突存在就默认回源 rebase。需要修改非冲突文件、删除部分吸收的重复实现、处理未支持冲突或明确安排源维护时，才回源/适配。类型或接口删除/替换的审查须查看调用方，避免无冲突的旧引用拖到 readiness 才发现。
- 正式 readiness 不是对 `rw-base` 和每条 overlay 分别校验。脚本先顺序合并全部层；stamp miss 时先跑不读构建产物的 format:check 和 lint，再构建 server 共用依赖与 app audio 依赖，立即运行 app typecheck，成功后才构建 server/CLI，最后执行全仓 typecheck。同一请求内若重试产生不同 commit 但完全相同的 Git tree，且固定工具链、实际 Node/npm、依赖输入和完整 dist 摘要仍匹配可信 readiness stamp，则复用该结果；任一项变化都完整重跑。
- 退出码 `4`：清单已更新但尚未 ready。集中提交本轮清单变更，不为每项 PR/分支单独提交；校验按下方 hook 规则执行，推送 `chore/build-paseo` 后，保留 `--run-id --no-fetch`、不带增删/重映射/接受参数重跑。若预检已查出 `rw-base` 基线测试债要 maintain，推送清单后不重跑 prepare，等源修复推送后直接跑 run-bound `maintain`。
- 退出码 `6`：清单提交后的 rebuild 在隔离 rw-main operation 中遇到支持的 sync/main/overlay 文本冲突。保存 `PASEO_RW_MAIN_OPERATION` 与 worktree；只修改冲突路径并 `git add`，运行 `git write-tree`，把 tree SHA 填入 `conflict-review.tsv` 的 `resolution-tree` 行，并为所有生成行填写非空证据说明，续跑前按 `打包流程.md` 第 1.5 节在临时副本对冲突路径做 lint、format 与直接回归快检（只作反馈，不记 PASS），然后原样重跑同一 `--run-id --no-fetch` prepare。不要手工 commit/reset/rebase。可用 rebuild 的 `--operation-status` 查看；仅尚未进入发布阶段的现场可用 `--abort-operation` 放弃，`publishing`/`awaiting-ready` 必须恢复完成。多个冲突逐次暂停，已完成前缀不重做；clean merge 在调用 Git merge 前保存冻结双父/说明，随后补记经双父重建核对的 tree，因此首次 tree 记录前或 commit 后首次完成记录前中断均可恢复；已包含在合法前缀中的 overlay 记为 no-op，不造空提交。rerere 匹配只恢复内容，仍须审查和暂存。重复冲突会给出不阻断的源维护建议，不会自动 rebase。
- 冲突/依赖候选测试在 readiness 完成后运行：精确同名直接回归及平台变体，加上变化区间内的同名相关测试；排除 e2e/browser/real/local 并记录覆盖缺口。按 workspace 的 Vitest 配置执行，app 指定 `--project unit`，每批最多 8 个。适用集合超过 32 个时，在当前 operation 的 `capability-test-selection.tsv` 中对每行填写 `run|skip` 和依据，直接回归必须保留；清单绑定候选 tree 和完整集合。原样重试即可，逐项审查后可运行超过 32 个必要测试，无需 abort 或回源。测试使候选变脏时不得记录 PASS 或发布。
- 候选测试固定 `LC_ALL=C LANG=C LANGUAGE=C` 并纳入审计/PASS 输入，避免 Git 中文报错导致英文断言失败。源分支手工定向测试也显式传这些变量，从所属 workspace 执行；不改机器 locale 或共享 Git 配置。
- `.test.` 文件名不代表可交给 Vitest：导入或 require `node:test` 的文件记为 `node-test-runner` 覆盖缺口，CLI `tests/` 的脚本测试及不支持的路径/扩展名同样排除。app 已知 unit 范围包括 `src/` 下 ts/tsx 和显式包含的 `native-release-version.test.ts`。发布恢复中的能力测试失败保留发布进度，不能改用 abort；修复环境后仍按原请求续跑。
- 其他非零退出：停止并诊断。readiness gate 未成功，不得启动任一产物构建。

前置脚本、长期功能管理与正式产物脚本使用同一把非阻塞锁。ready state 同时冻结控制面 HEAD、`main`、`rw-base` 和 `rw-main`，正式脚本会在删除旧产物前再次核对。

## 长期功能

- 用户明确要求把功能固化到基线时，完整读取 `打包流程.md` 第 1.3 节并使用 `manage-rw-base.sh promote|maintain|retire|status`；不要把它重新加入临时叠加清单。先检查 `status` 的 `UNMANAGED` 行；存在时 lifecycle 会拒绝自动推断，不能再次 promote。若已证明某个历史直提提交被当前受管功能完整接管，则在修复该功能的同一次 `maintain` 中显式传 `--adopt-commit <SHA>`；它会写入追加式 trailer 并让后续 status 不再报该项。禁止为清掉 `UNMANAGED` 而重写或删除已推送的 `rw-base` 历史。
- 打包请求内的 `promote|maintain|retire` 必须同时传原 `--run-id "$paseo_run_id"` 和 `--state-file "$paseo_preflight_state"`。它读取现有请求快照，不 fetch、不移动或 push main；tracking refs 可以继续前进，只要冻结 main 仍是其祖先。冲突或 ready state 写入失败后的 `continue` 都不重复传 run ID，也不隐式 fetch；operation request 已冻结 run/control/main/base/source 坐标。成功 ready state 保留请求身份与计时，直接进入产物链，不再额外 prepare。父 lifecycle 调用的 rw-main operation 会保留到 state 写入成功并由父流程内部确认；不要人工调用 `--confirm-operation`。只有脱离打包请求的 standalone lifecycle 才保持“先同步最新 main”的旧语义。
- promote/maintain 前，在源 worktree 对本次合入区间改动的非测试文件跑直接回归（`打包流程.md` 第 1.3 节）；lifecycle 候选测试只覆盖冲突和依赖区间，不会替功能本身兜底。
- 退出码 `5` 表示生命周期操作保留了冲突 worktree。保存输出的 `PASEO_RW_BASE_OPERATION`；解决并 `git add`，完成 `conflict-review.tsv` 的双父和 upstream 必填证据后用 `continue --operation`，或用 `abort --operation` 放弃。sync、feature、replay 均检查各自冻结源输入尚未包含的 main 历史。不得手工移动 `rw-base`/`rw-main`。

## 正式产物链与端选择

ready 后先确定一个本轮不会复用的 attempt 目录，再把同一个 state 文件交给版本化脚本；必须显式传入 `--run-dir`，这样 heartbeat 唤醒后的恢复 agent 可以直接使用该绝对路径调用低输出 wait helper。Codex 没有 Claude 风格的后台完成通知，因此启动 agent 先通过 Paseo MCP 创建约每 5 分钟一次、3 小时过期的 heartbeat，再把返回的 opaque ID 通过 `--heartbeat-id "$paseo_heartbeat_id"` 传给脚本。脚本只持久化该 ID 和状态，不通过 shell CLI 创建或删除 heartbeat，并写入 PID、`exit-status`、`result.env` 和阶段日志。需要等待时使用低输出 wait helper（每 15–30 秒检查，仅在阶段变化、终态或长静默时输出），不要让模型持续 `write_stdin` 轮询：

先调用 agent-scoped MCP `create_heartbeat`（`cron="*/5 * * * *"`、`expiresIn="3h"`），把返回对象中的 `id` 保存为 `paseo_heartbeat_id`。prompt 必须包含绝对 run 目录、请求/attempt、说明 PID 会写入 `pid.env` 并按该文件恢复，以及“不要重启构建”的指令；创建 heartbeat 时尚不知道后台编排 PID。脚本结束后，读取 `heartbeat.env` 和终态文件；由同一 agent 通过 MCP `delete_heartbeat({ id: paseo_heartbeat_id })` 删除，再执行状态 helper 标记清理完成：

```text
create_heartbeat({ cron: "*/5 * * * *", expiresIn: "3h", name: "paseo-build-<run-id>", prompt: "...absolute run-dir... request/attempt... PID will be written to pid.env for recovery... do not restart..." })
delete_heartbeat({ id: paseo_heartbeat_id })
PASEO_ARTIFACT_HEARTBEAT_DELETE_CONFIRMED=1 paseo_cleanup_artifact_heartbeat "$paseo_artifact_run_dir"
```

```bash
paseo_artifact_run_dir=/home/yangfei/Projects/paseo/.dev/build-paseo-runs/$paseo_run_id/artifact-attempt-1
source "$paseo_chore_root/dwyanewang/build-paseo-state.sh"
paseo_prepare_artifact_run_dir "$paseo_artifact_run_dir" 60
setsid bash "$paseo_chore_root/dwyanewang/build-paseo-artifacts.sh" \
  --build-root /home/yangfei/Projects/paseo \
  --preflight-state "$paseo_preflight_state" \
  --run-dir "$paseo_artifact_run_dir" \
  --heartbeat-id "$paseo_heartbeat_id" \
  >"$paseo_artifact_run_dir/launcher.log" 2>&1 < /dev/null &
paseo_artifact_launcher_pid=$!
printf '%s\n' "$paseo_artifact_launcher_pid" >"$paseo_artifact_run_dir/launcher.pid"
printf 'artifact launcher pid=%s run-dir=%s\n' "$paseo_artifact_launcher_pid" "$paseo_artifact_run_dir"
paseo_wait_for_artifact_run "$paseo_artifact_run_dir" 20 60
```

`setsid` 和 `< /dev/null` 让构建脱离当前终端；`launcher.pid` 只用于诊断，脚本启动后写入的 `pid.env`（含启动时间和命令）才是恢复判断的权威 PID。成功必须同时满足同一目录的 `exit-status=0`、`result.env` 为 `ready` 且 run-dir 精确匹配；不要用 `$!` 或 `write_stdin` 判断成功。`paseo_prepare_artifact_run_dir` 写入的 `starting` 标记给后台启动留下窗口，helper 会在窗口内等待目录和 PID 出现，超时后明确报告 `abandoned`。

按用户要求追加可重复的 `--target server|android|windows`；`desktop` 是 `windows` 别名。未传 `--target` 时保持三端默认。只选 Windows 时仍构建其内嵌 daemon 所需的 server/CLI 依赖，但只交付 Windows zip；只选 Android 时构建 app 依赖，不构建 Windows；只选 server 时不生成移动/桌面产物且不启动下载服务。

用户明确要求不拉取/不同步且不叠加本地分支时，仍按同一后台启动顺序，仅将 `--preflight-state` 换成 `--skip-preflight`：先 `paseo_prepare_artifact_run_dir`，再 `setsid ... &`，保存 `$!` 到 `launcher.pid`，最后立即调用 `paseo_wait_for_artifact_run`。这条规则同样适用于后面的本地分支 Windows 示例。

不拉取并临时测试一个 Windows 分支的标准命令：

```bash
paseo_artifact_run_dir=/home/yangfei/Projects/paseo/.dev/build-paseo-runs/local-windows-attempt-1
source "$paseo_chore_root/dwyanewang/build-paseo-state.sh"
paseo_prepare_artifact_run_dir "$paseo_artifact_run_dir" 60
setsid bash "$paseo_chore_root/dwyanewang/build-paseo-artifacts.sh" \
  --build-root /home/yangfei/Projects/paseo \
  --skip-preflight \
  --local-branch fix/example \
  --target windows \
  --run-dir "$paseo_artifact_run_dir" \
  --heartbeat-id "$paseo_heartbeat_id" \
  >"$paseo_artifact_run_dir/launcher.log" 2>&1 < /dev/null &
paseo_artifact_launcher_pid=$!
printf '%s\n' "$paseo_artifact_launcher_pid" >"$paseo_artifact_run_dir/launcher.pid"
paseo_wait_for_artifact_run "$paseo_artifact_run_dir" 20 60
```

heartbeat prompt 必须包含绝对 run 目录、请求/attempt、说明后台 PID 会写入 `pid.env` 并按该文件恢复、终态判据，并明确禁止重新启动构建；heartbeat 创建时不宣称已有真实 PID。heartbeat ID 会持久化在该目录的 `heartbeat.env`，状态为 `created`；异常退出或终态后，拥有同一 agent 身份的 agent 先通过 MCP 删除该 heartbeat，再执行 `PASEO_ARTIFACT_HEARTBEAT_DELETE_CONFIRMED=1 paseo_cleanup_artifact_heartbeat "$paseo_artifact_run_dir"` 将状态记为 `cleaned`。脚本和状态 helper 不调用 heartbeat create/delete CLI，也不会把 daemon 密码写入环境、日志或文件。没有 ID 时状态为 `unavailable`。终态只能由同一 run 目录同时满足 `exit-status=0`、`result.env` 的 `paseo_artifact_build_status=ready` 和 `paseo_artifact_build_run_dir` 精确匹配来确认；缺失 `exit-status` 时结合 PID 文件的启动时间与命令判断 `running`，编排进程已死则报告 `abandoned`，不能无限报告运行中。`terminal-state` 只表示脚本已完成终态收尾，不是代理已汇报标记。取消只走 SIGTERM。成功后按幂等顺序删除 heartbeat，消费方确认后自行记录用户汇报并只发送一次最终结果。

脚本统一负责整轮独占锁、mise、临时分支清理、所选旧产物标记、terminal-webview 清理、依赖构建、Android/Windows 画像、三端同时选择时的 Android bundle gate 与 16 GiB 并发判定、产物校验、Windows 历史 zip 轮转和按目标下载服务。Windows 成功构建后只保留当前包与最近两个历史 `Paseo-Setup-*-x64.zip`；不要让多个 subagent 各自启动平台构建，也不要在代理侧重复这些实现细节。

## 失败与交付

- 修改任意 `dwyanewang/*.sh` 或对应测试后，提交前运行 `bash "$paseo_chore_root/dwyanewang/check-build-paseo.sh"`；它只做 Shell 语法和定向构建控制测试，不代替真实产物打包。
- 上游 `lefthook.yml` 的 pre-commit typecheck 没有路径过滤，仓库规则也要求每次修改后 typecheck/lint。控制面即将提交时不要先手工跑一遍全仓 typecheck 再让 hook 重复执行：提交前做定向测试、`npm run format` 和一次 lint，由 pre-commit 承担该轮唯一一次全仓 typecheck；若不提交或 hook 未执行，再显式运行 typecheck。
- 非零按阶段处理并保留真实退出码：`3/4/5/6` 走审查、提交或冲突续跑；其他失败按日志症状查询 `踩坑记录.md`。网络/SSH/远端查询失败不等于代码验证失败，修复环境后按原 prepare 或父 lifecycle operation 续跑，不能仅凭退出码要求回源或 abort。已进入发布阶段必须恢复完成。确需产品代码适配时，临时层回源分支，长期功能经 `maintain`，不能直接修改验证候选、`rw-base` 或 `rw-main`。
- 回源修复（临时 overlay 或长期功能）新建 worktree 并要在其中提交时，先一次跑完 `npm install --ignore-scripts && npm run postinstall && npm run build:server` 再改代码；不要软链产品目录的 `node_modules` 来提交（`打包流程.md` 第 1.2 节）。
- app Playwright 是可选的源分支验证：一次只能运行一个 invocation，不得与 prepare/lifecycle/readiness、`build:server` 或 pre-commit hook 重叠。Metro warmup 超时先保存具体 phase、URL、elapsed、进程状态和近期输出；只有明确改变一个条件才允许最多一次重试，仍失败就保留证据并继续必需 gate，禁止无诊断连续重启。
- 证据优先读取 `.dev/build-paseo-runs/<轮次>/result.env`、`stages.log`、已选择端的分支日志、`build.log` 和资源 summary。核对 `paseo_artifact_targets`、`paseo_artifact_preflight_mode` 与临时分支 SHA；Windows 目标还要核对 retention limit、保留数和清理数。
- 只汇报所选端的产物路径/体积/mtime和资源数据；Windows 目标同时汇报历史 zip 保留/清理数量，同时选择 Android 与 Windows 时再汇报并发/回退模式。还要汇报本轮 main 快照 SHA/同步时间、临时分支及冻结 SHA、下载地址，以及从用户消息到下载服务就绪的真实总墙钟。ready-state 产物结果中的 `paseo_build_request_total_seconds` 包含前置与重试（起点取 `--requested-at`）；`paseo_artifact_total_seconds` 仅作产物链分段数据。
