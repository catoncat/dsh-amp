# REVIEW-amp-runtime：agent 平面运行时语义与对抗性复核
> 评审员：AMP runtime 子代理；对象 revision：`live.js da693738896f`、`artifact.js 8f3ec02d7d15`、`outcome.js 82bbd05cc37c`、`live-plugin.js 4cbeffeb3216`；DSH 源码 revision `c291e79`
> 方法：对照插件源码、DSH TypeScript 真源及已安装编译产物；运行完整测试、变异测试与 brief §6 免费运行态观察。

## 1. 结论
**不接受“agent 平面已闭环”的既有结论。** 发现 0 个 P0、6 个 P1、2 个 P2；其中 result-before-exit 可让 DSH job 永久不结算，jobs preflight 仍在 spawn 后且额外泄漏 30 分钟账号 claim。

job 与 `amp_stop` 在正常 settlement 后确实投影同一 `session.outcome`，但 `terminalOutcome()` 实际会计算多次，且取消重入会把错误事实固化成共同结论。轮末通知也没有使用 DSH reporter 的 per-Agent 预算，而是 per-run 自建预算。

135 条基线全绿；9 组有效变异中 8 组变红、1 组（去掉 teardown await）仍全绿。既有“已修”判决中，终态唯一、通知预算、jobs 降级三项被对抗证据推翻；其余所测窄行为成立。

## 2. 发现（按 P0→nit）

### [P1][已确认] settlement 重入时，后到的取消未进入终态事实
- 插件侧：`lib/live.js:540-550,551-559,910-915,1203-1206,1495-1498`
- DSH 依据：`packages/jobs/jobs/src/types.ts:71-84` 要求 `cancel()` 同步、幂等并最终让 `done` 以真实 terminal outcome 结算；`packages/jobs/jobs-local/src/index.ts:215-227` 先调用 producer cancel，再把 registry 状态置为 stopping。插件自身 `finish()` 注释也承诺“a kill arriving mid-settle is still honoured”。
- 为什么错 / 影响：第一次 `finish(session, false)` 已创建 `settlePromise` 后，第二次 `finish(session, true)` 仅 `terminate()` 并返回旧 promise，不设置 `killedByCancel`。故 sweeper/自然退出/用户 graceful stop 正在收尾时，jobs cancel 或 `amp_stop(kill:true)` 实际杀进程，却可能报告 `failed`；若退出码和 result 恰好已呈成功，还可能报告 `completed`。job 与 `amp_stop` 的确投影同一 `session.outcome`，但共同投影了错误事实。
- 复现或验证方式：构造 `waitForExit()` 未决的 session，先调用 `finish(false)`，再触发 job `cancel()`；令 terminate 后 `done` 返回 exitCode 0 且流中有成功 result。断言当前 job status/stopReason 为 completed 而非 killed/aborted。现有重入测试需检查是否覆盖“false→true”方向。
- 建议最小修法：在 `settlePromise` 已存在且 `kill===true` 的分支中，若尚未确认 `session.exited`，先设置 `session.killedByCancel=true` 再 terminate；增加 sweeper/graceful settlement 与 cancel 交错测试。

### [P1][已确认] 轮末通知绕过宿主唤醒预算；“每 run 3 次”等同平台预算的处置不成立
- 插件侧：`lib/live.js:394-442`（直接 `agent.followup/inject`；`session.turnNotices` per-run，超过 3 直接 return）。
- DSH 依据：`packages/jobs/tool-jobs/src/index.ts:207-229,268-299`：宿主用 `WeakMap<Agent, number>` 按 exact Agent 计数，用户消息被 claim 时重置；预算耗尽时降级为 `owner.inject(message)`，不是丢弃。`packages/core/agent/src/runtime-types.ts:213-241` 定义 `followup` 为可唤醒投递、`inject` 为 next-step 注入。
- 为什么错 / 影响：插件每个 run 都有独立 3 次 `followup`，同一 Agent 顺序或并发启动多个 run 可开出远超 3 个自动 turn，完全绕过平台的跨 job/per-Agent 防自激预算；反方向上，单 run 收到真人输入后也不会补回预算，第 4 次以后连 `inject` 都没有，进度通知静默丢失。文档“每 run 最多 3 条，对齐平台唤醒预算”与真实契约不一致。
- 复现或验证方式：同一 fake Agent 启动 2 个 run，各产生 3 个 `end_turn`，当前收到 6 次 `followup`；或一个 run 产生 4 次，第 4 次 `inject` 计数仍为 0。对照 DSH `tool-jobs` 测试 `degrades to injection once the consecutive wake budget is spent`。
- 建议最小修法：不要在插件复制预算；把 turn-end 事件交给一个宿主级 owner-scoped reporter，复用 per-Agent 预算与 user-input reset。若必须本地实现，至少使用 `WeakMap<Agent,number>`、监听 `agent/inbox/claimed` 重置，并在预算耗尽时 `inject`。

### [P1][已确认] live 路径丢弃 `system` 错误，导致与 one-shot 的失败 kind 不一致
- 插件侧：`lib/live.js:273-305,607-612` 只保存 `result`，分类输入仅 `result.error` 或 `exitError`；对照 `lib/index.js:375-396` 明确保留 `folded.systemError` 并送入同一个 `classifyAmpError`。
- DSH 依据：`packages/subagent/subagent/src/out-of-process.ts` 的一次性 provider 结算合同由 `settleRunResult` 汇总 provider diagnostic；插件 one-shot 正确把 system-level error 作为失败事实，live 平面却未同口径折叠。两条路径最终都由 DSH job/subagent 面向同一 owner。
- 为什么错 / 影响：同一个上游错误若以 stream-json `system` 非 init 消息出现，one-shot 会得到 `credits/rate-limit/auth/other`，live 只得到“无 result/失败”且 `failure=null`，不会 `noteRefusal`，下一次可能继续挑同一被限流/失效账号，也不给正确 retry 判据。
- 复现或验证方式：向两条解析器输入 `{"type":"system","subtype":"error","error":"Rate limit exceeded. Please try again in 57 seconds."}` 并令进程退出；断言 one-shot diagnostic 含 `failure=rate-limit`，live job detail 不含。现有 live 测试只覆盖 `result.error`。
- 建议最小修法：live session 增加 `systemError`，在 `foldMessages` 折叠非 init system error；结算分类输入按 one-shot 的 `result.error ?? systemError ?? exitError`。

### [P1][已确认] 协议 `result` 抢先把 session 标 finished，可永久跳过真正 settlement
- 插件侧：`lib/live.js:299-303` 在解析 result 时设 `session.finished=true`；`874-887` 的 exit watcher 只有 `finished!==true && settling!==true` 才调用 `finish()`；`914-977` 的 job done 却等 `session.settled`，它只在 `finish():671` resolve。
- DSH 依据：`packages/jobs/jobs/src/types.ts:79-84`：`done` 必须在 producer 释放资源后 resolve 且不得 reject；`packages/jobs/jobs-local/src/index.ts:178-185` 只有 hooks.done settle 才提交 terminal job。
- 为什么错 / 影响：若 `amp_send_message` 或 sweeper 在 `handle.done` callback 前吸收到最终 result，session 先变 finished；随后进程退出，`onExit()` 因 finished 已真而不进 `finish`，`markSettled` 永远不执行。job 永久 running，owner teardown 等待 job.settled 可挂住；读面还会在尚未证明进程退出时返回 `status:'finished', alive:false`。
- 复现或验证方式：已在 `/tmp/runtime/m-result-race/` 增加对抗测试：先 push success result 并调用 `amp_send_message(wait_ms:0)`，实际返回 `status=finished, alive=false`；再 resolve handle.done、不调用 amp_stop，`jobs.hooks.done` 与 30ms timeout 竞速得到 `timeout`。现有测试都让 `amp_stop` 补调了 `finish()`，未覆盖该顺序。
- 建议最小修法：把“看见 result”与“已 settlement”分开；fold 只设 `resultReceived`/`result`，绝不设 `finished/closedAt`。`finished` 只在 `finish` finally 置真；exit watcher只以 `settlePromise/settling` 去重。

### [P1][已确认] jobs 拒绝后的“已降级”仍违反 `jobs.start` 硬契约，并泄漏账号 claim 30 分钟
- 插件侧：`lib/live.js:729-783` 先 `choose`/spawn，`867-870` noteDispatch，直到 `993-1023` 才 `jobs.start`；拒绝后 `finish(kill)` 不调用 pool 的 release API。`lib/accounts.js:169-182,242-260,488-560` 显示 claim 在 `choose()` 建立，只由 `refresh/noteRefusal/noteSuccess` 释放，TTL 30min。
- DSH 依据：`packages/jobs/jobs/src/index.ts:73-82` 原文：“Any preflight rejection leaves no job id or execution resource”；`packages/jobs/jobs-local/src/index.ts:131-150` 在 controller、参数、owner cleanup、并发上限全部通过后才调用 `spec.run()`。
- 为什么错 / 影响：插件把 execution resource（本地 Amp 进程、远端 thread/actor socket）建立在 `jobs.start` 之外，故 controller 缺失/slot 满/owner 已失效等 preflight 拒绝并非“无执行资源”。即使最终停稳，所选账号仍被错误标记 in-flight 30 分钟，后续选号偏离。若停稳未证实，还保留可能存活的无 job 进程。该项不能仅凭“没投 prompt”降级为符合 jobs 契约。
- 复现或验证方式：令真实形状的 `jobs.start` 抛 slot-limit；断言 spawn 已发生、`choose` 建立 claim；随后调用 pool.preview/choose，当前会避开该账号直至 TTL。现有 admission 测试只断言 prompt 未写和 handle.terminate，没断言 claim 释放，也主动接受了“先 spawn”。
- 建议最小修法：把 spawn/artifact/session 建立全部移入 `jobs.start({run(){...}})` 的同步 starter；若结构暂不能改，拒绝 catch 至少显式 `pool.release`（需正式 API），但这仍不满足“无 execution resource”。

### [P1][已确认] 多 host 同毫秒 artifact key 冲突，可把在线救援对象删掉
- 插件侧：`lib/live.js:738-739,843-848` key 仅 `${runId}-${Date.now()}`；`lib/artifact.js:190-214` 对既有目录用 append 打开；`56-109` 只按共享 checkpoint 的 `finished:true` 删除整个目录。
- DSH 依据：DSH jobs/agent 生命周期是 process-local（`packages/jobs/jobs-local/src/index.ts:1-8`）；不同 host 不共享 `seq` 或 session map，故插件必须自己提供跨进程唯一 artifact identity。现有 `docs/USABLE.md` 已承认多 host 可共享 `DSH_HOME`。
- 为什么错 / 影响：两个 host 同一毫秒启动各自 run-1 时会写同一目录/stream/checkpoint。A finalize 写 `finished:true` 后，任一 prune 可删除目录，尽管 B 仍在线；B 的已打开 fd 继续写到已 unlink inode，而下一 checkpoint 失败，救援记录消失。
- 复现或验证方式：已运行 `/tmp/runtime/artifact-collision.mjs`：两个 store 固定同一 now、同一 runId，`sameDir:true`；A finalize 后 `pruneRuns(keepDays:0,keepCount:0)` 删除目录；B append 仍报 ok，但 checkpoint 返回 ENOENT。
- 建议最小修法：artifact key 加 `process.pid` + `randomUUID()`（或 host instance UUID）；不要依赖毫秒时间作跨进程唯一键。

### [P2][已确认] waiting 通知把所有 failure kind 都写成 retryable，与分类器合同冲突
- 插件侧：`lib/live.js:412-426` 的 `noWork` 仅检查 `failure !== undefined && assistantMessages===0`；`lib/outcome.js:44-47` 明定只有 credits/rate-limit/auth 是 no-work，`other` 不可盲重试。
- DSH 依据：`packages/jobs/tool-jobs/src/index.ts:261-266` 要求不要复制正在运行的 job 工作；插件该通知仍写 `state=waiting`，但同时输出 `retryable=true(no work was performed)`。
- 为什么错 / 影响：`other`（如 compaction/未知错误）在未见 assistant 消息时也被 waiting 通知称为可重试，违背 `isNoWorkFailure`；且 session 尚未 terminal，措辞可诱导另开 run。
- 复现或验证方式：注入 `result.error="Compaction failed"`、无 assistant 消息但带 `end_turn` transition，检查 direct notice 当前含 `retryable=true`；终态 job detail则不会，形成同一 run 两阶段判据冲突。
- 建议最小修法：复用终态谓词：`isNoWorkFailure(failure.kind) && assistantMessages===0 && !quiescenceUnproven`；waiting 状态最好不用 `retryable`，只说明 failure 并让 owner stop/collect。

### [P2][已确认] `AMP-LIMITS` #11 只证明一个样本 `num_turns:0`，不足以写“never inference/代价不是推理”
- 插件侧：`lib/live.js:761-765` 注释写“never inference”；`docs/AMP-LIMITS.md:19` 与 `docs/USABLE.md` 边界写“不是付费推理/不做任何模型工作”。
- DSH 依据：jobs 合同只保证 preflight 前无 execution resource（`packages/jobs/jobs/src/index.ts:73-82`），不对 Amp 外部计费作任何保证；插件绕开 starter 后，DSH 无法提供该保证。
- 为什么错 / 影响：一次 netcap 观察到 thread 创建、WebSocket、loadPlugins/loadSkills 与最终 `num_turns:0`，可以支撑“该样本未观察到模型 turn”；不能证明所有版本/错误时序都不调用 inference，更不能证明账单为 0（材料没有前后余额或计费事件）。当前绝对措辞强于证据。
- 复现或验证方式：保留当前证据可复核为“一个无 prompt 样本”；要证明费用需在隔离账号记录拒绝前后精确余额/账单，并覆盖 slot/controller/owner-cleanup 三类 start rejection。
- 建议最小修法：文档改为“已测一个样本 `num_turns:0`，未观察到模型 turn；计费未验证”；根治仍是让 spawn 位于 `spec.run()` 内。

## 3. 复核一致的既有处置

- `noteArtifactWrite` 覆盖 prompt、stdout、stderr、checkpoint 四类增量写；open/finalize 失败分别进入 `artifactError`，终态会重算为 `durability=partial`。
- `durability=partial` 或 `quiescenceUnproven` 会把本来 completed 的 process 投影为 jobs `failed`，`amp_stop` 对应 `stopReason:error`；变异测试有效。
- 单 host、无 key 冲突时，checkpoint 缺失/损坏、`finished` 缺字段、false 或任意非布尔 true 都不会进入 prune candidate；mtime 异常不会越过 `finished===true` 门槛。
- `resumable/retryable` 的 terminal notice 均受 quiescence 门槛约束，现有测试对去门槛变异会红；但 waiting notice 仍有 §2 的独立问题。
- jobs 服务完全缺失时在 spawn 前 fail closed；`jobs.start` 正常返回后，当前 LocalJobRegistry 不会在 `start()` 内重入 cancel，prompt 会在 `amp_run` 返回前同步 write；外部立刻 cancel 会走共享 settlement。
- 无 timer 降级已做到 mount warn、tool description warning、每次 `amp_run` response warning；变异测试有效。
- `live-plugin.js:14-30` 在 agent 平面挂载，tools 不从 host row 全局泄漏；`subprocess/credentials` 为硬依赖，jobs/timer 在调用点显式降级。

### 既有“已修”判决表

> 变异均在 `/tmp/runtime/m-*` 独立副本运行各自的 `bash test/run.sh`；“红”指至少一个相关断言失败，不把模块解析失败计作结果。

| 台账条目 | 引用测试 | 变异后是否变红 | 判决 |
|---|---|---:|---|
| 终态双真源已修 | `both surfaces project ONE outcome…`、`a kill through the job…` | 是（破坏 stop 投影） | **依据不实（覆盖不全）**：锁住普通投影，但未覆盖 `finish(false)→finish(true)`，本轮已推翻完整结论 |
| artifact 部分写已修 | `a partial durable record cannot be reported as clean success`、`silently failing artifact write…` | 是（忽略 write error） | **测试有效** |
| retention 不删未完成救援 run | `retention: a run that never finished is NEVER…` | 是（把全部 run 纳入 deletable） | **测试有效**（单 host/唯一 key 范围）；跨 host key 冲突另见 P1 |
| 轮末通知最多 3 次、对齐平台预算 | `the turn-end notice is capped like the platform budgets wakes` | 是（3→999） | **依据不实**：只断言单 run 第 4 次被丢弃，未断言 per-Agent、真人输入 reset、超额降级 inject；本轮推翻“对齐” |
| admission 在 prompt 前 | `admission is decided BEFORE the prompt is delivered…` | 是（在 start 前写 prompt） | **测试有效（窄结论）**：只证明 prompt 未投递，不证明 preflight 前无进程/thread/claim |
| 准入已实测降级为“无推理 thread” | 同上 + `AMP-LIMITS #11` | 不适用（外部单样本） | **依据不实**：`num_turns:0` 仅支持该样本未见 model turn，不支持 never/零费用；DSH execution-resource 合同仍违反 |
| quiescence 未证实时不给 retryable/resumable | 两条 `…withheld while quiescence is unproven` | 是（删除门槛） | **测试有效**（terminal job notice） |
| 未分类失败 status 写 checkpoint | `the checkpoint carries the projected status…` | 是（移除 status 字段） | **测试有效** |
| 无 timer 时 fail loud | `a host with no timer service is LOUD…` | 是（移除 warn/description） | **测试有效** |
| disposer join settlement | 台账仅引 `lib/live.js`，无测试名 | **否**（移除 await 后仍 135/135） | **测试空壳/缺失**：源码静态上正确，但 fake disposer 丢弃返回 Promise，回归不受保护 |

## 4. 已确认无误清单

### 4.1 终态构造与路径枚举

- `terminalOutcome` 只有一个**函数定义**（`lib/live.js:450`），但不是“只构造一次”：正常 finish 在 finalize 前 `:644` 与 finally `:670` 各算一次，job/stop 还保留 fallback 调用 `:915,1252-1254`。finalize 后的 `session.outcome` 才是两表面稳定真源。
- 自然退出：`handle.done → onExit → finish(false)`；用户 stop：`finish(kill flag)`；jobs kill：`cancel → finish(true)`；idle sweeper：`finish(false)`；host teardown：join `finish(true)`；jobs start 抛错与首 prompt write 抛错：删除 map 后 await `finish(true)`。普通路径均汇合到 finish。
- 等待异常/超时会置 `quiescenceUnproven`；absorb/finalize 异常进入 `settleError/artifactError` 并在 finally 重算。普通 settlement 后 job status 与 stopReason 不会互相反向；已确认的反例是“共同错误结论”与 result 抢先阻断 settlement，而非两个消费者自行重算。
- checkpoint 是第三个持久表面：finalize 前写 preliminary status，若 finalize/close 失败，磁盘无法回写 runtime 的 degraded status；代码注释已诚实说明，不能把磁盘 checkpoint 当最终 runtime outcome。

### 4.2 jobs 契约与三类边界

- DSH `start()` 的真实顺序是 controller/参数/owner cleanup/owner 并发上限 preflight → `spec.run()` → 原子注册；preflight 拒绝必须没有 job id 或 execution resource（`jobs/src/index.ts:73-82`、`jobs-local/src/index.ts:131-189`）。
- jobs 服务缺失：插件在 spawn 前拒绝，正确。`start` 抛错：插件会 stop/finalize 并按 quiescence 诚实报错，但已产生 process/thread，且 claim 未释放，不符合契约。返回后立刻 cancel：prompt 已在 execute 返回前写入；cancel 同步、幂等入口成立，但受“后到 kill 未记事实”竞态影响。
- 残余精确定义：短时本地 Amp 子进程；已观察到远端 thread、actor WebSocket 与插件/skill 加载；一个样本 `num_turns:0`。是否产生任何账单/未来版本是否始终无 inference：**未证实**。

### 4.3 通知、artifact、分类

- 回合结束通知直接用 `Agent.followup`（idle，开新 turn）或 `Agent.inject`（running，不唤醒）；DSH 定义见 `runtime-types.ts:204-241`。terminal job 通知则由 `tool-jobs` 的 `onJobDone` reporter 发送，两者是不同机制与不同预算。
- `session.turnNotices` 是 **per-run**，不是 per-session/per-Agent；永不因真人输入重置。第 4 次被丢弃。被通知 agent 在 start 时必存在；若正在 running/被中断则 inject 可能在 cancellation/disposal 时丢弃，这是 DSH 明示的 best-effort 语义。插件 teardown 已设 settling 后会抑制新 turn notice。
- agent 已被替换/销毁但插件 disposer 尚未接管的极窄竞态：插件保留旧 Agent 对象且不查 registry，sync throw 会被吞；是否可能向 stale inbox 成功 splice 见 §5 SUSPECTED。
- artifact 可读但字段缺失、`finished` 非布尔 true、checkpoint 损坏/缺失全部受保护；future mtime 只会多保留，非 rescue 的 finished record 才受 age/count。唯一已证实救援删除反例是跨 host key collision。
- observed Amp errors 下，`outcome.js` 对 credits/rate-limit/auth/other 的 terminal retry 门槛为 kind + `assistantMessages===0` + quiescence proven；已见字符串未发现反向分类。两条路径调用同一 classifier，但 live 遗漏 system 输入，故端到端 kind 不一致；waiting notice 另行绕过 classifier 的 no-work 判据。

### 4.4 实测与免费观察

- `bash test/run.sh`：**135 tests / 135 pass / 0 fail**，总时长约 6.39s。
- 当前真实 Amp argv 含 `--execute --stream-json --stream-json-input --mode medium --visibility private --no-color --no-ide --no-archive-after-execute`，与 live.js 构造一致；环境中的 credential-shaped 名称仅 `AMP_API_KEY`，互证 env 擦洗/单 token 注入。
- `$DSH_HOME/state/dsh-amp/runs/` 共观察到 22 个 checkpoint；当前两个活动记录都有 threadId、`finished/status` 尚未置值、`writes:1`，符合“活动记录先 checkpoint、终态 finalize 后才 finished”的设计意图。历史旧记录可见 `finished:true,status:null`，说明 retention 的 legacy fallback 确实仍会被用到。

## 5. 未能验证 / 需要下一轮

- **SUSPECTED（P2）stale Agent 通知**：`notifyTurnEnd` 持有 exact Agent 强引用且不向 agents registry 验活；DSH `Agent.send` 直接 splice inbox（`packages/core/agent-loop/src/agent.ts:128-146`）。验伪：用真实 scope 测试在 owner dispose 与 live-row disposer 交错窗口触发 sweep，断言不会向旧 inbox append/唤醒 replacement。
- **SUSPECTED（P2）分类器宽匹配**：`/rate ?limit/` 与 `not signed in` 没有错误来源约束，若 Amp 把任务内第三方错误放入 terminal `result.error`，可能错误冷却/轮换 Amp 账号。验伪：收集真实 stream-json schema样本，确认 `result.error` 是否只承载 Amp transport/account 错误；若混合，按 subtype/code 或来源分类。
- mtime 为 NaN/非有限值需要异常 filesystem/stat 注入才能稳定制造；当前代码不会因此删除 `finished!==true` 的救援对象。建议补 `Number.isFinite(mtimeMs)` 并把异常值按 protected 处理，作为防御性测试而非本轮 confirmed bug。
- disposer 的 async join 静态符合 DSH scope 合同，但插件测试 fake 没有 await disposer；应新增真实/忠实 effect harness 测试，而不是继续依赖源码目检。
