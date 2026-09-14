# dsh-amp 设计审查

## 1. 摘要（最关键 3 条）

1. **A1 不能按现文直接实现。** `ctx.jobs` 是正确完成通知机制，但 Jobs 的 `readOutput` 明定为“每个 job 一个消费游标”（`packages/jobs/jobs/src/types.ts:85-90`），当前 live 又只有 `session.offset`（`lib/live.js:195-203,423-451`）。`job_output` 与 `amp_send_message` 共用 `absorb` 会互相偷输出。契约必须改成两个独立游标：协议折叠游标 `protocolOffset` 只由后台观察器推进，模型读取游标 `deliveryOffset` 只由 `job_output` 推进；`amp_send_message` 不再消费输出，改成返回有界快照/摘要和 job id。
2. **A2 应从 P0 删除，至少降为“远端 Orb thread 的受限实验能力”。** 新实测推翻 PLAN 的无条件结论：thread 属于账号；换账号不能续跑；本地 `threads continue` 在非 TTY 下不可用。唯一 CLI 线索 `--orb-execute` 只承诺把消息送到 thread 自己的远端 executor，不能支撑通用 `amp_run({thread})`。可靠替代是先做 A5：持续写原始流与阶段 checkpoint，任何失败返回 artifact 路径、thread/account、已完成轮数和最后摘要；重试只能新 thread，并要求先读 checkpoint，不能宣称“续跑”。
3. **状态与额度模型都需要从“六个展示词”升级为正交事实。** 当前状态表没有表达回收后不可达、kill 与 graceful finish 竞态、进程退出与 result 同时成立、额度拒绝（零工作）与中途额度死亡（已有工作）的区别。账号的 `$1` 只能排序，不能成为统一闸门；但选号必须接收 `mode + 任务预算/预期花费`。`numTurns=0` 或没有 assistant 输出都不是安全重试证明，只有明确的启动前 credits/rate-limit/auth 拒绝、且无 thread/无工具副作用/无产出时才可有限改派。

**总判断：** A1 的机制方向正确但合同有硬冲突；A2 的既定承诺不可行；A5 是防止本次“27 轮后一个字未落盘”重演的最高优先级。当前设计不能原样进入 A1/A2/A5 实现。

## 2. 逐条回答 9 个问题

### 2.1 平面与可达性

- 平面划分正确：Host 行 `dsh-amp` 注册进进程级 `subagents`；agent 行 `dsh-amp/live` 只给 amp preset 注册工具。preset 本身说明 host registry 与 agent tool 的边界（`.dsh/.agent-presets/amp/agent.cordis.yml:160-168,222-268`），插件入口也保持了该边界（`lib/live-plugin.js:1-15`）。
- `ctx.get('jobs')` **可以解析**：`jobs-local` 是一份进程级 service，controller/listener 再按 owner scope 分层；全局层或 owner scope chain 上有 controller 即可服务（`packages/jobs/jobs-local/src/index.ts:105-116,297-319`）。当前 amp preset 同 scope 装有 `tool-jobs`（`.dsh/.agent-presets/amp/agent.cordis.yml:65-75`），它会 `attachController`（`packages/jobs/tool-jobs/src/index.ts:258-260`）。
- `jobs` **不必加入 live 行的静态 `inject`**。源码已有两条权威先例：`tool-bash` 的静态 inject 不含 jobs，却在后台分支 `ctx.get('jobs')`（`packages/shell/tool-bash/src/index.ts:348-365`）；`tool-subagent` 同样在运行分支可选解析（`packages/subagent/tool-subagent/src/index.ts:525-545`）。这是可选能力发现，不是加载前硬依赖。反而应在 `amp_run` 启用 A1 时若 `ctx.get('jobs')` 缺失就 fail loud，且必须在 spawn 前调用 `jobs.start()`，让 controller/并发准入先完成。

### 2.2 完成通知与多 run 并发

- `jobs.start()` 先检查 owner 是否有 controller及每 owner 活跃上限，再调用同步 `run()`，因此把 spawn 放进 `run()` 可保证“准入失败不产生进程”（`packages/jobs/jobs-local/src/index.ts:131-150`）。默认上限是每个**确切 owner** 10 个 `running + stopping`（同文件 `:27-36,321-327`），不是整个进程 10 个。
- job 的 `done` 必须在 **Amp 进程退出、stdout/stderr 最后字节吸收、artifact flush/rename、句柄资源释放之后** resolve。契约明确说不是“工作看起来完成”就 resolve，而是资源已释放；必须最终 settle，且正常不 reject（`packages/jobs/jobs/src/types.ts:71-84`）。若 `done` 永不 resolve，job 永久占 `running/stopping` 名额，owner dispose 也会永久等它（`packages/jobs/jobs-local/src/index.ts:466-470,503-505`）。
- 完成提交后 `onJobDone` 最后触发；busy owner → `owner.inject`，idle owner 且 wake 预算未耗尽 → `owner.followup`。默认 `completionDelivery=wakeup`、`maxConsecutiveWakes=3`；用户输入才重置预算（`packages/jobs/tool-jobs/src/index.ts:204-229,268-299`）。多 run 同时完成时 busy lane 可在下一 step 合并消费；idle lane 可能连续额外买最多 3 个模型 turn，之后只注入、可能要等未来 turn 才被看见。
- `reported` 会在 terminal read、terminal kill、成功等到 terminal 的 wait、owner/service teardown 时为 true；有 pending waiter 的 settlement 也先标 true，再通知 listener（`packages/jobs/jobs-local/src/index.ts:205-227,230-278,416-439,507-520`）。因此主动 `job_output(wait:true)`、`job_kill` 或 teardown 都会抑制重复完成通知；live timeout 的 wait 不会抑制。

### 2.3 A1 生命周期冲突与正确 teardown

- Jobs 的 first-wins terminal record 与 live 的 `settlePromise` 幂等方向一致，但不能把 `done` 直接写成“某次调用时才创建的 `settlePromise`”：job 一注册就必须持有一个最终会 settle 的 promise。当前 `handle.done` 观察器会调用 `finish(false)`（`lib/live.js:465-480`），可作为自然退出路径；job cancel 必须同步、幂等地触发 `finish(true)`，再由 job-owned `done` 等同一个 settlement。
- `amp_stop` 当前在 finish 后立刻 `sessions.delete`（`lib/live.js:636-675`）；接 Jobs 后这会让 job 仍可见、但专有 run 已不可达，形成两套不一致 owner。应明确唯一终结 owner：`job_kill`/`amp_stop` 都只请求同一个 `finish`；job `done` 完成 artifact 后终结；session map 至少保留到 job terminal，随后 tombstone/按 TTL 回收。重复 stop 返回同一 terminal snapshot/artifact，不应变 `unknown run`。
- idle sweeper 只能请求 `finish(false)`，不能先删；它与 stop/kill 并发由 first-wins settle 合并。若 graceful finish 已开始，后来 kill 必须升级 terminate（当前 `finish` 已支持，`lib/live.js:311-320`），但 terminal 原因要记录“谁赢、是否升级”，不能仅由最后一个 API 参数推断。
- agent dispose 的顺序应为：Jobs owner cleanup 标 `reported` → 调同步 `cancel`（触发 terminate/finish）→ await job `done`（等待 quiescence、吸收、artifact 原子落盘、资源释放）→ Jobs 删除 record（`packages/jobs/jobs-local/src/index.ts:459-475,507-529`）。`dsh-amp/live` 自己的 `teardownAll` 当前只 terminate 然后立即 clear（`lib/live.js:165-175`），接 A1 后会抢先丢状态，必须改为不拥有 job-backed run 的异步 teardown，或统一委托 Jobs；否则 artifact 和 done 可能永不完成。

### 2.4 双游标的可执行契约

建议字段与序列：

1. `protocolOffset`：后台 parser 唯一推进；负责 `threadId/result/turnEnded/lastText/numTurns/failure` 和 artifact append。`handle.done`、定时观察、send 后等待都调用 `observeProtocol()`。
2. `deliveryOffset`：仅 Jobs `readOutput()` 推进，直接对原始 stdout reader `readFrom(deliveryOffset)`，格式化为有界 delta；**不得调用 `absorb/observeProtocol`**。
3. `stderrProtocolOffset` 与 `stderrDeliveryOffset` 同理，或明确 stderr 只入 artifact/terminal diagnostic、不作为流输出。
4. `amp_run` 返回 `{run, jobId, mode, account, cwd, artifact, status}`；`amp_send_message` 只写消息并返回 `{delivered, appliedAs, status snapshot, threadId, jobId}`，不再承诺“自上次读取以来的一切”；读输出唯一入口是 `job_output(jobId)`。
5. 完成通知只用 `JobSnapshot` 的 label/status/detail + `artifact` 路径，不读取 stdout，所以不会推进任何游标。`job_output` 才消费 `deliveryOffset`。完整 artifact 是 append-only 原始事实，不受两游标消费影响。

若坚持保留 `amp_send_message.newMessages`，则必须再设第三个 `messageDeliveryOffset`；这会制造两个模型可见消费入口，极易误用，不推荐。Jobs 已明确“每个 job 一个消费 cursor”（`packages/jobs/jobs/src/types.ts:85-90`），最好让 `job_output` 成为唯一输出入口。

### 2.5 状态模型

§1 六行不是穷尽且并不互斥：`finished` 与 `exited` 可同时为真（当前 result 把 `finished=true`，随后 `handle.done` 又把 `exited=true`，`lib/live.js:228-231,470-479`）；`settling` 期间也可能已经 `exited`；`failed` 是结果类别，不是与 running/finished 同层的生命周期。

真实可达但表中缺失的组合：

- sweeper 发起 graceful finish 的同一 tick，用户 `amp_stop(kill:true)` 升级 terminate；
- session TTL 回收后，job/card 或迟到的 `amp_stop` 再访问：应是 `released` tombstone，而不是假装 run 从未存在；
- 子进程先写 error/success result，随后非零/零退出；协议结果与进程结果要同时保留，冲突时失败优先；
- `job_kill` 标 `stopping` 后自然 result 到达，或 graceful finish 后 kill 交错：需要 `stopRequested`, `killRequested`, `terminalCause`, `quiescence` 正交事实；
- 启动前 quota/rate-limit/auth 拒绝（无工作）与运行 N 轮后额度掐断（partial work）都叫 failed，但重试策略完全不同；
- stdout lossy/spill、artifact 写失败、quiescence unproven 可与任一 terminal cause 并存。

建议内部状态拆为 `phase = starting|active|settling|terminal|released`，另设 `turn = busy|idle|unknown`、`process = alive|exited|unknown`、`outcome = completed|failed|killed|refused|unknown`、`delivery/artifact/quiescence` 事实；展示状态由纯函数派生。

### 2.6 账号池与失败改派

- “排序而非 `$1` 硬闸门”正确：实测同一 `$0.90` 账号 medium 被拒、low 可启动，现注释也只把 `$1` 当 preference（`lib/ledger.js:27-37`），`choose()` 会在没有更好账号时派 below-floor（`lib/accounts.js:184-193,254-272`）。
- 但 F26（一次 medium 评审消耗约 `$4.1` 后第 27 轮被掐）证明选号必须评估本次预算。接口至少要变成 `choose({mode, expectedCost?, taskClass?})`：余额排序先满足模式启动底线，再优先满足预期总花费 + reserve。无法可靠估算时，长任务默认选择最大余额账号，并在 prompt 中强制早落盘/阶段 checkpoint；不能因估算不准硬拒绝所有工作。
- `numTurns=0`、无 assistant 输出、甚至无 final result 都不能单独证明“没干活”：可能工具已写文件、输出解析失败、thread 建立后崩溃，当前 provider 也明确把 clean exit/no result 判失败而非成功（`lib/index.js:350-362`）。安全自动改派应是合取条件：分类为明确启动前 `credits|rate-limit|auth`；没有 thread id；没有 assistant/tool event；没有 workspace mutation 证据；没有 artifact payload。否则停止自动改派，返回 partial artifact。
- 分类器“启动前拒绝可有限改派”合理，且 rate limit 要按窗口记忆、credits/auth 要刷新账号事实（`lib/accounts.js:314-342`; `lib/outcome.js:28-46`）。但目前分类器没有被 `lib/index.js`/`lib/live.js` 调用，属于**未接完**，不是额外缺陷计数。
- 中途死亡：先 flush artifact/checkpoint，标 `partial=true`、记录 `account/thread/numTurns/lastCompletedPhase/failureKind`；不跨账号续同 thread（账号级作用域）；新账号只能新 thread，prompt 必须先读 artifact 并从 checkpoint 继续，有限一次，禁止重做已完成阶段。

### 2.7 用户侧运行卡片

- 真实机制是 Client 插件向 keyed session slot `tool.call.toolview` 分别注册 key `amp_run`、`amp_send_message`、`amp_stop`；Host `presentCall/presentResult` 不进入 Web Client（`packages/client/ui-tool/README.md:30-46`；`.agents/notes/implemented/architecture/2026-08-23-client-derived-tool-presentation.md:27-35`）。props 是 `callId/toolName/frozen block/cwd/home/openFile/inspect`，renderer 从原始 args、result content、error、durable meta 派生（`packages/client/ui-tool/src/client/contract/slots.ts:54-84`）。
- 卡片应读：调用 args 中的 `prompt/mode/run/steer/kill`；结果中稳定结构化的 `run/jobId/threadId/mode/account/status/startedAt|elapsedMs/finishedAt/outcome/failureKind/artifact`。失败全文入口应是 artifact/file path + `openFile`，不要把全文塞卡片。当前 `amp_run` 有 mode/account/cwd/status 但没有 jobId、artifact、thread（thread 尚未 init）；send 有 status/thread/elapsed/exit 等但没有 mode/account/artifact；stop 有 output/diagnostic 但没有 thread/mode/account/timestamps/artifact（`lib/live.js:491-504,579-608,636-674`）。需要先稳定 output schema；现在所有三个输出还是 JSON 字符串，Client 只能脆弱 parse 文本。
- `web.js` 的 loopback + custom header + Host/Origin 限制**不会挡普通 toolview**，因为 toolview 从 Session raw events 渲染，不需要该 route。该 route 是账号设置页专用（`lib/web.js:42-88`）。如果未来卡片通过 HTTP 拉 artifact，这个限制会挡非本机/portal 浏览器，且 `fetch` 自定义 header 可能触发不同 transport 问题；正确路径应复用 session-authorized file/openFile 或现有 Remote，不应扩展账号 route。

### 2.8 缺口、优先级与模型误用

§5 把 A2 放 P0 不合理；A5 放 P1 也过晚。遗漏的关键项：双游标；job/session 单一 owner 与 tombstone；结构化结果 schema；artifact 写失败语义；启动前拒绝与中途失败分层；账户绑定 thread；预计花费；完成通知 retirement-window 漏洞（Jobs 自己承认 busy→idle 窗口可能搁置通知，`packages/jobs/tool-jobs/README.md:166-176`）；live dispose 与 Jobs dispose 顺序。

最容易误用：

1. 模型同时轮询 `amp_send_message` 和 `job_output`，导致消费竞态——删掉前者的读取能力；
2. 把 `amp_stop` 当暂停后可续——工具描述直接写“终止，后续是读取 artifact 后新 run”，删除不可实现的 thread 参数；
3. 同一个 run 同时 `job_kill` 与 `amp_stop`——返回同一 terminal handle，专有 stop 可降为 `amp_finish`（graceful）并以 jobId 为唯一身份；
4. 收到 completion notice 后再启动重复工作——notice 固定包含 `artifact` 与“先 job_output/读 checkpoint”；
5. 低余额长任务不落盘——long/medium 类 prompt 自动加入 checkpoint contract，A5 在 spawn 前创建 artifact。

### 2.9 A1/A2/A5 正确顺序与验收

1. **P0 A5 最小耐久层**：spawn 前创建 `state/dsh-amp/runs/<run>/`；持续 append `events.jsonl`，每阶段原子更新 `checkpoint.md`，终结原子写 `result.json`。验收：模拟第 27 轮 SIGKILL/credits error/Host dispose/磁盘写失败；进程死后仍能从路径读到此前全部完整行、最后 checkpoint 与明确 incomplete 状态。
2. **P0 A1 Jobs 接入**：先落实双游标和单一 lifecycle owner，再 `jobs.start`。验收：同一 run 交错 `amp_send_message`、两次 `job_output`、自然退出、stop、kill、sweeper、owner dispose；每段输出恰好一次、artifact 全量、通知至多一次、done 最终 settle、无永久名额。真机验收 `job_list` 可见，busy/idle 各测完成通知，第 11 个 run 在 spawn 前拒绝。
3. **P2/研究项 A2**：从通用合同删除。只为“同账号 + 明确 remote executor + `--orb-execute`”建隔离 spike；验收必须是非 TTY 真机、thread 不变、账号不变、消息真实执行且可收结果。未通过前产品承诺只有“artifact/checkpoint 驱动的新 thread 恢复”，其验收是换账号后新 run 读取 checkpoint、不重复已完成阶段。

## 3. 必须修改的设计点

以下按“不改就会坏”的顺序排列；“未接完”只描述当前工作树进度，不重复计作设计缺陷。

### 3.1 机制上不可行

1. **删除 A1 的“`readOutput` 复用 `absorb`”。** 两个消费入口共享一个 offset 必然丢可见增量。改成 §2.4 的 protocol/delivery 双游标，并以 `job_output` 为唯一模型可见读入口。
2. **删除通用 A2 承诺。** `amp_run({thread})` 在本地非 TTY 无可用 CLI 路径，且 thread 绑定账号；“账号池任意改派 + 同 thread 续跑”组合本身矛盾。只保留 future remote-orb spike，产品合同改成 artifact/checkpoint 恢复。
3. **不能把当前 `settlePromise` 直接当 job `done`。** 它在 `finish()` 首次调用才存在；job hooks 在 start 时必须立即返回稳定 done，且 done 要覆盖资源释放与落盘。需创建 job-owned completion deferred，所有 terminal path 汇入一个 settlement transaction。
4. **不能让 live `teardownAll` 与 Jobs owner cleanup 双重拥有释放。** 当前前者 terminate+clear、后者 cancel+await；并行会丢 session 状态或卡住 done。指定 Jobs 为 job-backed run 的 teardown owner，live disposer 只触发/等待同一 transaction。
5. **运行卡片不能靠 Host `presentCall/presentResult`。** Web 不运输这些值；必须提供 `/client` keyed toolview，并从 raw block 派生。

### 3.2 设计文本问题

1. **把 A5 提到首个 P0，并定义“持续”而非“结束时”落盘。** 仅终结时写 `runs/<run>.md` 仍会在额度中断/Host 崩溃时一个字没有。定义 spawn 前 manifest、append-only events、原子 checkpoint、terminal result 四个耐久点及写失败行为。
2. **重写 §1 为正交事实模型。** 生命周期、进程、turn、outcome、artifact、quiescence 分开；`failed` 不再与 `running` 同层；加入 `released/refused/partial`。
3. **定义一个身份和一个结束事务。** `jobId` 应成为平台控制身份；`run` 若保留只是 alias。`amp_stop`、`job_kill`、sweeper、handle.done、dispose 都汇入同一 first-wins transaction，并规定 late kill 的升级语义、terminal tombstone 与 TTL。
4. **给 Jobs outcome 明确映射。** completed → `completed`；显式 kill/owner teardown → `killed`；credits/rate/auth 启动前拒绝与中途失败 → `failed`，detail 再区分 `refused|partial`。不能用调用 `amp_stop` 时的参数反推真实结局。
5. **改账号接口与重试门槛。** 选号接收 mode/预计花费或任务类；自动改派只允许被证明的启动前无工作拒绝，设置明确最大尝试数与已尝试账号集合。`numTurns=0`/无 assistant 不能成为判据。
6. **将 thread 与 account 绑定写入 run manifest。** 任何 future continue 必须验证同 account；池切号时强制新 thread。
7. **把三工具输出改为结构化 schema。** 卡片与模型共享稳定字段，不再解析 JSON 字符串；失败全文只给 artifact 入口与有界摘要。
8. **修正 A1 通知预期。** 文本要承认 wake 最多 3 次、之后注入可能等待未来 turn，以及 driver retirement window 仍可能搁置一次通知；“完成必须主动到达”不能写成无条件实时保证。
9. **明确 A1 接线尚未完成。** 当前 `lib/live.js` 没有 jobs 接线；`lib/outcome.js` 与 `accounts.noteRefusal` 也未被 provider/live 调用。设计计划应标“已实现机制”与“待接线”，不要把已有 classifier 文件等同于端到端有限改派。

## 4. DSH 机制依据表

DSH 源码根均为 `$HOME/work/repos/deepseek-harness/`；插件路径均相对 `$DSH_HOME/plugins/dsh-amp/`。

| 设计点 | 支持它的机制（路径:行） | 与它冲突/限制它的机制（路径:行） |
|---|---|---|
| live 行可选接 Jobs | `packages/shell/tool-bash/src/index.ts:348-365`、`packages/subagent/tool-subagent/src/index.ts:525-545` 都用未静态 inject 的 `ctx.get('jobs')` | `jobs.start` 要求 owner scope 有 controller：`packages/jobs/jobs-local/src/index.ts:131-147,315-319`；当前由 preset `tool-jobs` 提供：`.dsh/.agent-presets/amp/agent.cordis.yml:65-75` |
| 每 owner 并发准入 | `packages/jobs/jobs-local/src/index.ts:27-36,143-150,321-327`：默认 10，spawn 可放在 preflight 后的 `run()` | `stopping` 也占名额；done 不 settle 会永久耗尽槽位：同文件 `:321-327,503-505` |
| 完成主动通知 | `packages/jobs/tool-jobs/src/index.ts:268-299`：busy inject、idle followup；`packages/jobs/jobs-local/src/index.ts:416-439`：提交后最后通知 | 默认仅连续 wake 3 次：`packages/jobs/tool-jobs/src/index.ts:36-51,207-229`；retirement-window 可能搁置：`packages/jobs/tool-jobs/README.md:166-176` |
| 通知去重 | terminal read/wait/kill 标 reported：`packages/jobs/jobs-local/src/index.ts:205-227,230-278`；teardown 同样：`:507-520` | pending waiter 在 listener 前标 reported，主动等待将抑制通知：同文件 `:416-423` |
| job done 的边界 | `packages/jobs/jobs/src/types.ts:71-84`：资源释放后 resolve、cancel 必须最终 settle | 当前 live `settlePromise` 懒创建：`lib/live.js:311-354`；teardown 只 terminate+clear：`lib/live.js:165-175` |
| 双游标/唯一消费入口 | Jobs 明确一个 consuming cursor：`packages/jobs/jobs/src/types.ts:85-90`；`job_output` 实际调用 `jobs.read`：`packages/jobs/tool-jobs/src/index.ts:329-336` | live 所有协议观察共用 `session.offset`：`lib/live.js:195-203,236-259,423-451`；DESIGN A1 要“复用 absorb”会与 job_output 互偷 |
| 状态正交化 | Jobs 自己将 lifecycle 限定为 running/stopping/terminal，producer detail 另放：`packages/jobs/jobs/src/types.ts:13-17,97-127` | live 的 result 与 process exit 分别写 `finished/exited`，二者可同时真：`lib/live.js:228-231,465-479`；DESIGN §1 把 failed 混入 lifecycle |
| stop/kill first-wins | live 二次 finish 共享同一 promise，late kill 可升级 terminate：`lib/live.js:304-354`；Jobs settle first-wins：`packages/jobs/jobs-local/src/index.ts:408-439` | `amp_stop` 完成即删 session：`lib/live.js:636-675`，会让 job 与专有 run 可达性分裂 |
| owner dispose | Jobs owner effect 会 cancel、await settled、再删除：`packages/jobs/jobs-local/src/index.ts:442-475` | producer cancel 返回但 done 不 settle仍会卡住；源码明确承认：同文件 `:503-505` |
| `$1` 只排序 | 插件证据与实现：`lib/ledger.js:27-37`、`lib/accounts.js:184-193,254-272` | 当前 `choose()` 不接 mode/预计花费；一次 medium 消耗约 `$4.1` 后中断证明余额仅够启动并不够完成（本轮用户提供的新实测） |
| 自动改派只限无工作拒绝 | classifier 将 credits/rate/auth 定义为可恢复：`lib/outcome.js:28-46`；拒绝记忆：`lib/accounts.js:314-342` | 分类只靠 prose 且目前未接 provider/live；无 result 也可能已做副作用：`lib/index.js:350-362,404-430` |
| thread 恢复 | Amp CLI `--orb-execute` help 是唯一可疑入口（本轮用户提供的新实测） | thread 账号级、跨账号报不存在；本地 continue 非 TTY exit 1（本轮用户提供的新实测）。故不支持通用 A2 |
| Web 运行卡片 | 唯一扩展点是 `tool.call.toolview`：`packages/client/ui-tool/README.md:30-46`；raw block owner props：`packages/client/ui-tool/src/client/contract/slots.ts:54-84` | Session Remote 不运行/运输 Host presenters：`.agents/notes/implemented/architecture/2026-08-23-client-derived-tool-presentation.md:27-35` |
| 账号 route 与卡片分离 | `lib/web.js:42-88` 只提供 loopback 账号 JSON；toolview 从 Session events 派生，不需 HTTP | 若卡片复用该 route 拉 artifact，loopback/header/Host-Origin 会挡 remote/portal：`lib/web.js:18-35` |
| 配置 reload ≠ 模块 HMR | `.agents/notes/implemented/architecture/2026-08-22-single-dsh-application-launcher.md:25-35,75-77`：`patchReload: live` 是 config watcher；模块 HMR 需显式启用 | 当前 profile 虽启用单独 hmr row，但 node_modules 插件仍需重启的本机事实写在 `.dsh/profiles/web/cordis.patch.yml:5-13`；不能以 patch reload 证明新 `lib/*.js` 已加载 |

## 5. 未验证与不确定

1. **未重跑 Amp CLI。** 按任务铁律没有发起 agent，也没有重试 `threads continue`。A2 判断直接采用本轮给出的三条真机事实：跨账号 thread 不存在；本地非 TTY continue exit 1；help 仅对 `--orb-execute` 描述 remote executor。remote-orb 同账号路径仍是未知，故只允许 spike，不构成产品承诺。
2. **没有证明 Amp 的额度拒绝一定发生在任何副作用之前。** `outcome.js` 注释把 credits/rate 两类都写成“did no work”（`lib/outcome.js:4-11`），但本轮中途 27 轮死亡已经反证“同类额度文本必然无工作”的泛化。必须用事件顺序/thread/tool-write 证据区分 `refused` 与 `partial`。
3. **预计花费目前没有可靠 estimator。** 建议的 `expectedCost/taskClass` 是选号输入合同，不代表现有 DSH/Amp 能精确估价。首版可由调用者显式传预算，缺省按 mode + 长任务标签排序，同时依赖 checkpoint 降低估错损失。
4. **Jobs retirement-window 是上游已知限制。** 本插件能诚实披露并通过 artifact/job_list 兜底，但无法在 dsh-amp 内彻底保证每次 completion 都立即唤醒；根治属于 agent-loop（`packages/jobs/tool-jobs/README.md:166-176`）。
5. **artifact 读取通道尚未选定。** 本报告确定不能复用账号 loopback route，但还需在实现前从现有 session file/resource Remote 中选一个已授权入口；如果只要求模型/本机用户通过路径读取，首版可不新增 Web fetch API。
6. **工作树中的 classifier 接线状态按静态搜索判断。** `lib/outcome.js`、`accounts.noteRefusal` 已存在，但 `lib/index.js`/`lib/live.js` 没有调用；这按任务要求记作“未接完”。本轮只写本报告，未修改或验证这些进行中的文件。
