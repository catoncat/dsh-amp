# dsh-amp 整体代码审查

## 1. 结论（3 句）

1. **能不能信**：架构能信——provider/agent 分层、job producer 边界和 settings/web 扩展面都接对了（§4），但报告层不能盲信：job 与 `amp_stop` 的 `completed` 各有一套判据，结算异常、非零 exit、artifact 部分写失败都可能仍报成功（§3 高危 1、2），这是“最坏时撒谎”级别的缺陷。
2. **能不能日常用**：能在 Web profile 下单 writer、串行地日常用（整天 dogfood 佐证），但并发选号无 reservation、大输出 spill 断链、artifact 无限期占盘这三类场景会失真或失控（§3 中危、§5 P1/P0-2），日常前至少要明确部署边界（§5-7）。
3. **只修一件**：把 `finish()`（`lib/live.js:410-530`）改为在捕获全部 process/artifact/spill/quiescence/settle 事实后一次生成唯一 terminal outcome，job（`:738-782`）与 `amp_stop`（`:990-1027`）只做投影——这一处同时消掉两条高危缺陷的根源，是其余一切可信度的前提。

## 2. 该删/该合并的（偶发复杂）

这里的结论不是“文件多就是坏”。当前复杂度里有一半是在为真实事故付账，另一半才是开发过程遗留。

### 直接删除或归档

1. **【已执行】删除 `describeDrift()` 及其旧测试。** 已核实：`lib/source.js` 现仅导出 `describeSource()` 与 `describePackageDrift()`（`lib/source.js:22,60`），单文件三态 API 已不存在；`test/source.test.mjs` 只剩 4 条整包比较测试（in-sync / 无源码树回答 unknown / 非入口文件 STALE / sibling 字节差 STALE）。无残留引用（`grep -r describeDrift` 对 lib/test 零命中）。结果与原判断一致：不损失任何当前产品能力，消除了会漏报 sibling 漂移的误用入口。
2. **删除 `PLAN.md`，或移到明确的历史归档，不再作为当前文档。** 它仍称 UX 未开始（`PLAN.md:5-10`）、把 `end_turn` 写成结算点（`:84-90`）、列出不存在的 `amp_interrupt`（`:111-117`），而当前实现已有设置页、jobs、artifact、idle settlement。损失：早期实验过程和阶段叙事；**不损失运行能力，也不损失当前契约**（后者应由 `DESIGN.md`、`USAGE-FINDINGS.md` 和测试承担）。
3. **【已执行】最终报告验收后归档/删除七份 `REVIEW-*.md`。** 已核实：7 份 `REVIEW-*.md` 连同 `PLAN.md` 共 8 个文件均已移入 `docs/reviews/`，原目录已无并列副本（`ls docs/reviews/` 确认 8 个文件名与原清单一致）。**残留引用需注意**：本报告其余章节仍以旧根路径引用这些文件——`REVIEW-a1.md:7-16`（§2）、`REVIEW-pool.md:32-62`、`REVIEW-a5.md:10-16`、`REVIEW-ux.md:77-83`（§2、§3 高危 2）。这些行号指向的文件本体仍在（内容未变），仅位置变到 `docs/reviews/`，后续如需回查按归档路径找；§6「与既有 7 份评审的对照」所需的对照对象同样以归档件为准。

### 合并，而不是再加状态

4. **把终态合成一个值，删除两套成功判据。** job 在 `lib/live.js:738-782` 自己推导 `completed|failed|killed`，`amp_stop` 又在 `lib/live.js:980-1029` 仅凭 `result.is_error` 推导 `stopReason`。应在 `finish()`（`lib/live.js:410-530`）末尾、所有错误都已折叠后一次生成 terminal outcome；job 与 stop 只做投影。损失：没有产品能力；会删除重复分支和一组互相矛盾的状态组合。
5. **让 `job_output` 成为唯一的模型可见读取入口。** 目前 `amp_send_message` 同时承担写入、等待、轮询和结构化增量读取（`lib/live.js:854-957`），jobs 又提供独立消费游标（`:783-807`）；这正是 F21 在结算边界吞掉 `newMessages` 的来源（`USAGE-FINDINGS.md:28`）。保留 `amp_send_message` 的“发送 + 状态快照”，删除可省略 message 的纯轮询、`wait_ms` 与 `newMessages`；输出统一由 `job_output` 读取。损失：send 后同一次调用立即得到结构化 digest 的便利，以及旧调用兼容；不会损失 steer、完成通知或原始输出读取。
6. **合并 host/live 两份配置快照。** host 已用 watcher 维护动态 holder（`lib/index.js:498-545`），live 却只在 mount 时读取一次 settings 并传入闭包（`lib/live-plugin.js:17-29`、`lib/live.js:191-240`）。让共享的 `ampAccounts`/config 服务暴露当前 resolved config，或让 live 正式 watch 同一 namespace；随后删除 live 的第二套 merge/snapshot。损失：若删除 fallback，会失去“只挂 live 行、不挂 host 行”这种未在 bundle 中使用的降级组合；标准部署能力不损失。

### 不应删除：这些是必要复杂度

- **跨 chunk framing buffer**（`lib/live.js:160-170,289-344`）对应已实测 F1（`USAGE-FINDINGS.md:8`），不是假想。
- **真实进程 outcome、两级有界 stop 与 quiescence 事实**（`lib/live.js:399-469,696-711`）分别对应假 alive 的真机复现（`USAGE-FINDINGS.md:60-64`）和可由 seam 合同复现、但当天未真机踩中的无界 stop（`USAGE-FINDINGS.md:21-22`）。前者已发生，后者是代码可复现的低频高危失败。
- **settlement deferred + `finally` 解锁**（`lib/live.js:410-530,649-655`）对应“结算抛错会让 job/owner dispose 永久等待”的代码可复现失败；旧实现已修，当前不应为了变短退回去（`REVIEW-a1.md:7-16`）。
- **双 cursor**（`lib/live.js:613-616,730-797`）是 DSH jobs 单消费 cursor 与后台协议观察并存的必要成本；DSH 合同明确每个 stream job 一个 consuming cursor（`$HOME/work/repos/deepseek-harness/packages/jobs/jobs/src/types.ts:85-90`）。但 cursor 必要不等于两个模型读取工具必要，后者应按上一条合并。
- **账号冷却/退避、未知余额候选分层和陈旧重验**（`lib/accounts.js:110-134,198-358,391-425`）对应当天真实的 credits/rate-limit 与“不可解析首号垄断”复现（`REVIEW-pool.md:32-62`、`REVIEW-a5.md:10-16`），不是假想。
- **持续 artifact、checkpoint、唯一 key 和 `amp_runs`**（`lib/artifact.js:44-242`、`lib/live.js:668-687,1096-1176`）对应一次 27 轮后零产物和一次重启后 run 不可达的真机事故（`REVIEW-ux.md:77-83`、`USAGE-FINDINGS.md:75-80`），不是“为了完整而完整”。
- **整包 build drift 与逐字节 deploy 校验**（`lib/source.js:75-124`、`deploy.sh:68-122`）对应三次重启仍加载旧副本的真机事故（`USAGE-FINDINGS.md:27,31-40`），应保留；该机制复杂的是事实本身，不是抽象失控。

## 3. 真缺陷（按严重度）

本节只列当前工作树仍存在的缺陷；F1/F4/F5/F6/F13/F14/F15/F19、A1 永久 pending、SIGKILL 误报、不可解析账号垄断等已修项不重复上报。这里“已确认”表示控制流或可构造 fake 已足以复现，不等于今天真机一定踩过；“疑似”明确表示还缺真实触发证据。

### 高

1. **[已确认]【核查 2026-09-13：仍存在，行号已复核】终态有两个真源，能对同一 run 给出相反结论。** 结算主体异常时，`finally` 先 resolve `session.settled`（`lib/live.js:515-523`，`markSettled` 在 `:522`），外层 catch 后才写 `settleError`（`:524-529`，实际赋值在 `:528`）；job reaction 因而可先按不含 `settleError`/`artifactError`/`quiescenceUnproven` 的白名单生成 completed（`lib/live.js:738-782`，白名单在 `:746`，代码注释自己承认“settlement that threw is recorded AFTER this snapshot is built”）。与此同时，`amp_stop` 的 `failed` 只检查 `result.is_error`（`:990`），再按**本次调用参数**生成 stopReason（实际在 `:1027`）：非零/未知 exit、无 result、分类 failure、settlement/artifact 错误、无法证明 quiescence 都可能仍报 completed；自然完成后迟到的 `kill:true` 又会报 aborted。触发条件：final absorb/finalize 抛错，或 clean result 与非零/未知 exit 并存，或 terminal 后调用 `amp_stop({kill:true})`。DSH 要求 producer 的 `done` 在资源释放后给出唯一 terminal outcome（`$HOME/work/repos/deepseek-harness/packages/jobs/jobs/src/types.ts:71-90`），所以这不是展示瑕疵。**只修一件就修它：`finish()` 捕获完所有事实后一次生成 terminal outcome，再最后 resolve；job/stop 共用。**
2. **[已确认，触发尚未真机发生]【核查 2026-09-13：仍存在，行号已复核】durable artifact 可部分写失败后仍最终报成功。** `append()` 明确返回 `{ok:false,bytes}`（`lib/artifact.js:132-153`，失败返回在 `:151`），`checkpoint()` 也返回失败值（`:156-195`）；调用方却丢弃初始 prompt、stdout/stderr 和 checkpoint 的结果（`lib/live.js:298,305,372,686` 四处均为裸调用不接返回值），后续 `finalize()` 只能反映当次 fsync/checkpoint/close（`lib/artifact.js:214-241`），`lib/live.js:504-510` 也只在 finalize 成功/失败间二选一。因此一次中途 ENOSPC/短写后若磁盘恢复，最终仍可返回 `artifactPath`，而文件已有洞且没有 `artifactError`。这直接破坏“27 轮工作必须可恢复”的核心目标；已有事故证明目标必要（`REVIEW-ux.md:77-83`，原件在 `docs/reviews/`），但本次写失败触发来自静态可复现，未声称今天发生。

### 中

3. **[已确认] one-shot prompt 静默截断，且“bytes”实现为 UTF-16 code units。** 上限名与合同是 bytes（`lib/index.js:79-83`），实际写入 `prompt.slice(0, STDIN_MAX_BYTES)`（`:345-354`），没有拒绝或截断标记。超过阈值时插件会成功执行一份不完整任务；中文/emoji 的 UTF-8 字节数又与 slice 口径不同。触发条件：拼装后 prompt 超过 1,048,576 code units（或产品真正想限制的 1 MiB bytes）。应按 `Buffer.byteLength` 在 spawn 前 fail loud，不能静默改任务。
4. **[已确认] `amp_runs` 的失败降级本身会失败或撒谎。** store list 失败返回对象（`lib/artifact.js:73-84`），调用方直接 spread（`lib/live.js:1120-1129`）会抛次生 TypeError；checkpoint 损坏/无权限时返回 `{ok:false,error}`（`lib/artifact.js:87-96`），映射却把任何非 undefined 值标成 `checkpoint:'ok'`，并可误判 interrupted（`lib/live.js:1138-1169`）。触发条件：runs root 不可读，或 checkpoint JSON 损坏/不可读。恢复工具必须返回原始 store error 和 unknown 状态。
5. **[已确认] 设置页标注的“下一个使用”不是 pool 真正会选的账号。** 页面只找首个 `exhausted !== true`（`lib/client.js:323-340`）；真实 `choose()` 还会跳过空 credential、cooling、probe-budget，并按可测余额、mode floor、unknown/unreadable 分层（`lib/accounts.js:209-358`）。触发条件：首行处于冷却、无 token、余额低于后续健康账号，或当前 mode 的 floor 不同。页面会给用户一个确定但错误的答案；应由 pool 产出同一 selection preview，UI 不复制规则。
6. **[已确认] 并发选号没有 reservation。** `choose()` 在 token/probe 的多个 await 之间扫描并直接返回（`lib/accounts.js:209-342`）；`noteDispatch()` 只加 ledger 计数（`:360-363`，`lib/ledger.js:146-156`），既不参与排序也不表示 in-flight。两个同时开始的 one-shot/live run 可拿到同一“最好”账号。触发条件：同一 host 并发两个 run，首个账号当时可用。今天没有构造出真机并发，故结论是“代码可复现”，不是“已发生”。
7. **[已确认] live 成功后不确认余额，F7 只修了一半。** live 已补 dispatch（`lib/live.js:689-695`），但成功只调用 `noteSuccess()` 清冷却（`:490-500`；`lib/accounts.js:427-431`），没有像 one-shot 那样 fire-and-forget `pool.refresh()`（`lib/index.js:389-397`）。触发条件：一次 live run 显著消耗余额，十分钟 stale 窗口内又发起 run；下一次仍按旧余额选同号。`USAGE-FINDINGS.md:14` 的“runs 不计数”已过时，“post-run refresh 缺失”仍成立。
8. **[已确认] live 设置不是 live；账号列表恰好被共享 pool 遮住了问题。** host 的 scope watcher 会更新 holder（`lib/index.js:526-545`），live 行只在 apply 时读一次 namespace并传入固定 resolved（`lib/live-plugin.js:17-29`）。所以账号选择通过共享 pool 得到新 refs，但 `ampBin`、visibility、keepThreads、grace、idle settle/timeout 与 tool mode schema 一直使用旧值（`lib/live.js:191-240,538-600,1178-1225`）。触发条件：设置页修改这些字段而不 remount live 行。DSH settings 明确提供提交后 watcher（`$HOME/work/repos/deepseek-harness/packages/settings/settings/src/index.ts:419-458`；`packages/settings/settings/README.zh.md:60-68`），这里未使用。
9. **[已确认机制缺口；大输出触发未发生] spill 已配置但恢复链未接通，诊断还声称可恢复。** one-shot 配 spill 后只解析内存 tail（`lib/index.js:159-165,345-367`），lossy 时称“complete stream in spill file”却不返回路径（`:417-425`）；live 只记录 spillPath（`lib/live.js:243-251,352-368,592-599`），artifact 仍只 append 已观察到的 tail，`amp_stop` 同样只给宣称不带路径（`:989-1013`），`amp_runs` 也不投影 checkpoint 中的 spillPath（`:1151-1169`）。触发条件：one-shot stdout 超过 4 MiB，或 live 两次 protocol sweep 间新增超过 8 MiB；当前没有真机证据。DSH reader 明确规定 lossy gap 只能从 spill 恢复（`$HOME/work/repos/deepseek-harness/packages/subprocess/subprocess/src/types.ts:121-145`）。要么接通恢复，要么删除“完整流可取”的文案与无消费者的 spill 配置。

### 低

10. **[已确认；仅多 host] ledger 原子替换不防多进程 clobber。** 每进程启动时只读一次全量 state（`lib/ledger.js:79-89`），每次更新整文件 temp+rename（`:91-102,125-156`）。两个 DSH host 共用同一 `DSH_HOME` 时是 last-writer-wins，原子性只防半文件。单 host 日常使用影响低；若明确只支持单 writer，应把该前提写进合同，否则需要 lock/CAS 或独立 per-account 文件。
11. **[疑似，取决于信任模型] `amp_runs` 是跨 session 的全局任务摘要目录。** 工具 execute 不读取 caller，checkpoint 也不持久化 owner（`lib/live.js:1119-1171`、`:352-368`），任何挂了 live tools 的 agent 可列出其他 session 的 account ref、thread id、lastText 与本机路径；而在线 steer/stop 明确按 owner fail closed（`:375-390`）。若所有本机 agent 被视为同一信任域，这是有意的 rescue 面，不是 bug；若 session 隔离也是读取要求，则这是元数据泄漏，需持久化 owner 并提供显式管理员视图。

## 4. 契约正确性

### 机制上可行且接对了的 seam

- **Host provider / agent tool 分层正确。** host 行注册进程级 `subagents` provider 与账号服务（`lib/index.js:498-556`），live 工具从 agent preset 单独挂载（`lib/live-plugin.js:1-29`；`$DSH_HOME/.agent-presets/amp/agent.cordis.yml:241-268`），没有把模型工具泄漏给所有 preset。DSH 自己把“provider 注册到 `ctx.subagents`”与“能力注册到 agent 的 `ctx.tools`”列为两个扩展点（`$HOME/work/repos/deepseek-harness/docs/architecture.zh.md:141-162`）。
- **one-shot 走 `SubagentProvider` 合法。** Amp 被如实声明为 fresh、无 start-time capabilities 的 out-of-process provider（`lib/index.js:253-270`），返回的 run 复用 DSH 官方 `settleRunResult`/`subprocessRunHandle`，dispose 会 terminate 并 await managed range（`:459-493`）。这符合远程 run `localAgent:undefined`、单次 result、dispose 达到 quiescence 的契约（`$HOME/work/repos/deepseek-harness/docs/subsystems/subagent.zh.md:350-393,397-439`）。
- **live 作为 Job producer 而不是伪装 continuable subagent 是正确边界。** `ctx.get('jobs')` 是 first-party bash/pwsh 自己使用的 optional seam（`$HOME/work/repos/deepseek-harness/packages/shell/tool-pwsh/src/index.ts:364-393`）；插件传真实 owner、同步 cancel、non-rejecting done 和独立消费 cursor（`lib/live.js:730-807`），因此平台拥有 admission、session fence、完成通知与 job tools。协议 cursor 和 job delivery cursor 分离也正是 `readFrom` 非消费、每个 job 仅一个消费 cursor的合同（`$HOME/work/repos/deepseek-harness/packages/subprocess/subprocess/src/types.ts:121-148`；`packages/jobs/jobs/src/types.ts:71-90`）。
- **`done` 与 `waitForExit` 分开处理是必要而非重复。** 前者是 spawned command 的 exit facts，后者证明整个 provider-managed range 已空（`$HOME/work/repos/deepseek-harness/docs/subsystems/subprocess.zh.md:133-170`）；`finish()` 先等 done、再分级 wait/terminate（`lib/live.js:399-491`）是正确方向。第 3 节的问题是这些事实最后没有折叠为同一个 outcome，不是“不该有这些状态”。
- **settings 与 Web host 用的是公开扩展面。** namespace 注册、watcher 和 effect-scoped route 分别位于 `lib/index.js:526-545`、`lib/web.js:42-103`，对应 DSH 的 `settings.register/watch`（`$HOME/work/repos/deepseek-harness/packages/settings/settings/src/index.ts:408-458`）与 `webServer.register`（`docs/subsystems/web-server.zh.md:49-76`）。feature 自建具名 JSON route 在该 Web 载体分层中是允许的（`docs/subsystems/web-server.zh.md:5-27`）。

### 已偏离平台合同

- **job admission 发生在 spawn 之后。** child 在 `lib/live.js:565-602` 已选账号、解析 executable 并 spawn，直到 `:798-807` 才 `jobs.start()`；而 JobStart 明定 preflight 先完成、再调用同步 `run()`，run 抛错则不得留下注册项（`$HOME/work/repos/deepseek-harness/packages/jobs/jobs/src/types.ts:42-68`）。当前 admission 拒绝虽 terminate 并清 artifact（`lib/live.js:808-829`），但没有 await `waitForExit`，存在短暂孤儿窗口，也绕过了“拒绝前无执行资源”的平台保证。应把同步 artifact open/spawn/session 初始化放入 `run()`，其前只做异步准备。
- **live 行 disposer 只请求停止，没有达到停稳。** teardown 对每个 handle 只 `terminate()`，随即清 map 并同步返回（`lib/live.js:212-222`）；DSH 的明确规则是 async disposer 必须 terminate 后 await done/quiescence，否则会留 orphan（`$HOME/work/repos/deepseek-harness/docs/defensive-patterns.zh.md:19-23`），且 Cordis 原生接受 async disposer（`docs/cordis-api/fiber.zh.md:10-27,278-295`）。subprocess service 最终也会兜底（`packages/subprocess/subprocess/src/index.ts:102-108`），但 live fiber 单独热卸载时不应把自己的生命周期责任推给更长寿的 provider。
- **输出 cap 的单位不合约。** JobStart 的 `outputLimitBytes` 明确是完整通知/读取的 UTF-8 bytes（`$HOME/work/repos/deepseek-harness/packages/jobs/jobs/src/types.ts:51-55`），插件传入名为 `DELIVERY_MAX_CHARS` 的字符数并用 JS `slice` 裁剪（`lib/live.js:791-804`）。非 ASCII 输出可超过平台承诺的 byte cap；与第 3 节 prompt 的 bytes/code-units 错误是同一类边界问题。
- **live settings 没有消费 watcher。** DSH 的 `watch` 明确保证按提交顺序投递已提交快照（`$HOME/work/repos/deepseek-harness/packages/settings/settings/README.zh.md:60-68`），host 行用了它（`lib/index.js:526-545`），agent 行却只 mount-time `get`（`lib/live-plugin.js:17-29`）。这不会因“API 可行性”自动修复，已作为第 3 节真缺陷列出。

### 平台升级时最可能坏的点

DSH 当前仍是 developer preview，官方明确承诺未来有 breaking changes（`$HOME/work/repos/deepseek-harness/README.zh.md:11-15`），仓库规则也说 public APIs pre-stable（`AGENTS.md:5-9`）。本插件没有 import DSH 私有包，主要风险不是“偷调内部函数”，而是这些结构面一起漂移：`SubagentProvider`/run helpers（`lib/index.js:253-270,459-493`）、`JobHooks`/`readOutput`（`lib/live.js:730-807`）、`SubprocessHandle.readFrom/spillPath/waitForExit`（`:243-251,399-491`）、settings register/watch（`lib/index.js:526-545`）和 Web route shape（`lib/web.js:42-103`）。应把对应 DSH 版本当部署兼容边界，并保留一次升级后的真实 smoke，而不是再加 adapter 层。

浏览器面最脆弱：手写 bundle 直接调用 `window.__ModuleLoader__.load`、`ctx.remote.settings.update` 与 `settings.section` slot（`lib/client.js:21-23,376-380`）。它们目前都有 DSH 权威合同——ModuleLoader C6（`$HOME/work/repos/deepseek-harness/packages/extensions/cordis-client-runner/src/client/runtime.ts:98-102,368-378`）、settings Remote（`docs/subsystems/settings.zh.md:281-292`）、slot catalog（`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:1914-1963`）——所以不是私用 API；但纯 JS 没有编译期类型保护，升级只会在浏览器运行时暴露。`package.json:25-32` 还显式标为 `platform:"web"`，而 DSH 桌面端不使用 webServer（`$HOME/work/repos/deepseek-harness/docs/architecture.zh.md:49-53`）；因此当前设置页应被视为 **Web profile only**，不能默认为 Desktop 可用。

## 5. 可生产性缺口

以下是“长期日常使用会造成错误、丢工作或失控增长”的缺口，不把卡片美化、措辞统一或更多配置项算生产门槛。

1. **P0：先建立唯一 terminal outcome，并让 durable I/O failure 进入它。** 目前 job/stop 分叉（`lib/live.js:738-782,980-1029`）和 append/checkpoint 失败值丢失（`lib/live.js:289-305,370-373,682-687`）意味着最坏时不是“失败得难看”，而是**丢了部分恢复事实却宣告完成**。修复后，terminal outcome 至少应同时持有 process、cancel、failure classifier、artifact、spill 与 quiescence 的正交事实，再只投影一次 completed/failed/killed；这是上线可信度的第一道门。
2. **P0：给 artifact 明确磁盘预算、保留期与删除策略。** store 把每个 run 永久落到固定 root（`lib/artifact.js:21-24,99-118`），`list()` 每次扫描全目录（`:73-84`），没有 TTL、总 bytes/条数上限或 prune API；`amp_runs` 还先读取/排序全量再 limit（`lib/live.js:1120-1171`）。连续日常使用必然无限占盘并使恢复列表越来越慢。最小生产策略是“保留最近 N 天且至少最近 N 个失败 run，受总字节上限约束；删前不碰 active key”，并把清理失败作为可观测运维告警。
3. **P0：修正 job admission 与 live fiber teardown 的资源所有权。** spawn-before-start（`lib/live.js:565-602,798-829`）绕过 jobs preflight；同步 teardown（`:212-222`）不 await 完全停稳。生产形态应只有一条 teardown transaction：Jobs owner/service 或 live fiber 任一请求 cancel，都汇入同一个 `finish()`，等待 process range、最后读取与 artifact finalize 后才释放 session；DSH 的 disposer 合同要求如此（`$HOME/work/repos/deepseek-harness/docs/defensive-patterns.zh.md:19-23`）。
4. **P1：账号池需要 in-flight reservation 和 run 后余额确认。** 并发 `choose()` 可挑同号（`lib/accounts.js:209-363`），live 成功不 refresh（`lib/live.js:490-500`），会让“健康排序”在并发与连续长任务时失真。reservation 必须在选择和 spawn/拒绝之间可靠 release；余额确认可异步，但下一次选择要能看到 reservation/新读数。否则账号池只对串行、低频使用成立。
5. **P1：大输出必须选一个诚实策略。** 当前有 spill 付盘成本，却既不解析也不返回其路径（`lib/index.js:345-367,417-425`；`lib/live.js:243-251,989-1013,1151-1169`）。生产前二选一：从 spill 补齐 protocol/artifact（并处理超过 spill cap），或超内存窗即明确 terminal partial/error 并给可读 path；不能继续声称 complete。
6. **P1：增加不启动额度工作的 composition smoke，并保留一条受控真实 CLI smoke。** 现有 runner 把 lib 复制进临时目录并链接已安装 DSH modules（`test/run.sh:3-10,44-53`）；live/provider/accounts 测试明确使用 fake ctx/fake subprocess（`test/live.test.mjs:5-6,141-148`、`test/provider.test.mjs:4,50-53`、`test/accounts.test.mjs:10-11,29-58`）。这很好地锁住业务控制流，却发现不了 profile mount、client ModuleLoader、Remote/slot shape 和真实 Amp stream 行为的组合漂移。至少自动执行“加载 profile、列 provider/tool/schema、访问本地 route、零 agent run”；额度型真实 smoke 在版本升级/发布候选时受控执行一次，不必每次测试花钱。今天整天 dogfood 是强证据，但不是可重复的发布门。
7. **部署边界必须写清，而不是默认全场景支持。** package 只声明 Web client（`package.json:21-32`），ledger 只安全支持单 writer（`lib/ledger.js:79-102,125-156`），`amp_runs` 是否跨 session 可见尚未定义（`lib/live.js:1119-1171`）。日常投入前应明确三条支持声明：Web-only 还是也支持 Desktop；一个 `DSH_HOME` 是否只允许一个 host；artifact 索引是 host 级 rescue 面还是 owner-scoped 数据。若选择当前限制，只需文档与 fail-loud guard；若承诺更多，才需要对应实现，不能先堆抽象。

## 6. 与既有 7 份评审的对照

待补。
