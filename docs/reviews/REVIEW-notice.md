# dsh-amp 通知与账户探测改动审查

## 结论摘要

1. 轮末 `followup` 绕过 3 次预算，可无限自激（`live.js:367-395`；`index.ts:204-229`）。
2. terminal 仍建议 steer；C 把成功/killed 也标 resumable，会重复工作（`live.js:778-815,923-930`）。
3. B 修对饥饿，但 assumed 抢过后续 confirmed，live 成功不 refresh（`accounts.js:252-270`；`live.js:520-529`）。

**这两处改动还不能算接对了：B 主干正确；A/C 须合并唤醒预算、拆清状态并收窄恢复判决。**

## 1. 重复/矛盾通知

### 已确认

- **中危：两条通知代表两个不同状态，本身不重复，但“下一步”互相矛盾。** `end_turn` 的通知明确写“finished its turn and is waiting”，并且在 `finished/settling` 时不发（`lib/live.js:367-382`）；job 通知只在 `session.settled` 后生成 terminal snapshot（`lib/live.js:770-820`），平台再对未 reported 的终态投递（`$HOME/work/repos/deepseek-harness/packages/jobs/tool-jobs/src/index.ts:278-299`）。因此前者是“run 仍开着等你”，后者是“run 已结束”，需要同时存在。问题在于 terminal detail 仍固定建议 `steer: amp_send_message`（`lib/live.js:807-815`），而 terminal run 的 `amp_send_message` 明确拒绝（`lib/live.js:923-930`）；轮末通知又把“start a new amp_run”与 steer/stop 并列（`lib/live.js:375-382`），会诱发尚未结束时另开重复 run。
- **中危：同一 run 确实可能留下两条模型可见消息。** 若先吸收到 `end_turn`，轮末通知立即入 inbox；稍后 child 自行退出、agent 调 `amp_stop`，或 20 分钟回收触发 settlement，job completion 还会再投递（`lib/live.js:308-316,728-743,1216-1247`）。若 `end_turn` 与 terminal `result` 在同一次 `absorb()` 中出现，`notifyTurnEnd()` 会因 `session.finished` 而抑制前一条，只剩 completion（`lib/live.js:267-270,308-312,367-371`），这一支不会重复。

### 最小修法

- 轮末通知只写：`state=waiting; next=amp_send_message|amp_stop`，删除 `start a new amp_run`；terminal detail 只写：`state=terminal; next=job_output/read artifact|new amp_run`，删除 `steer`（`lib/live.js:375-382,790-815`）。两条都保留 `run=`，并给 terminal 明示 `terminal=true`；不要靠合并/去重丢掉真正的状态迁移。

## 2. 唤醒预算

### 已确认

- **高危：轮末通知可无限主动开 parent turn。** 平台只在 `tool-jobs` 的 completion listener 内维护按精确 `Agent` 计数的 `WeakMap`，默认最多连续 wake 3 次，并且只有真正进入 step 的 user-source 消息重置（`$HOME/work/repos/deepseek-harness/packages/jobs/tool-jobs/src/index.ts:204-229,292-299`）。`notifyTurnEnd()` 直接 `agent.followup()`，既不读 `completionDelivery='quiet'`，也不花/检查这份预算（`lib/live.js:367-395`）。因此 `轮末通知 → parent 发 amp_send_message → child end_turn → 再通知` 可无限自激；不是 Amp 自动多轮，而是委派 agent 每次响应后续写造成的无上限链。
- **中危：一次 terminal 通常不会同步买两轮，但会叠两条上下文。** idle 时轮末 `followup()` 会同步把 agent 置为 running（`$HOME/work/repos/deepseek-harness/packages/core/agent/src/runtime-types.ts:204-222,269-277`）；此时紧随其后的 job completion 走 `inject()` 而不是第二个 `followup()`（`$HOME/work/repos/deepseek-harness/packages/jobs/tool-jobs/src/index.ts:268-299`）。但若 completion 到达 parent 已重新 idle 之后，它仍可再开一轮并另花平台预算；两套预算互不知情。
- **中危：busy lane 也不是“总能及时看到”。** `inject()` 不唤醒，只在以后最近的 pre-step 被 claim；若落在 driver 最后一次 inbox 检查与 idle commit 之间，消息会搁置到别的输入唤醒，这是平台已文档化的 retirement window（`$HOME/work/repos/deepseek-harness/packages/core/agent/src/runtime-types.ts:233-241`；`$HOME/work/repos/deepseek-harness/packages/jobs/tool-jobs/README.md:166-175`）。轮末通知复用了同一原语，也继承同一限制。

### 建议

- **正确边界**：让平台提供“非 terminal job notice/progress notice”投递 API，轮末与 completion 共用 `completionDelivery` 和同一个 `spentWakes`；dsh-amp 不应复制平台私有策略（`packages/jobs/tool-jobs/src/index.ts:204-229,268-299`）。
- **可立即做的最小止血**：dsh-amp 先按精确 `Agent` 建 `WeakMap`，同样只由 `agent/inbox/claimed` 的 `source.kind==='user'` 重置；最多 3 次 `followup`，之后降级 `inject`（`packages/jobs/tool-jobs/src/index.ts:210-229,292-299`）。这只能把 dsh-amp 自身变有界，仍未与平台合并总预算，应标成过渡方案。

## 3. `exec.agent` 的持有

### 已确认

- **持有精确对象是正确方向，但必须受该 Agent 生命周期约束。** 平台 completion 也故意保存精确 `Agent`，而不是以后按可复用 id 查 replacement（`$HOME/work/repos/deepseek-harness/packages/jobs/tool-jobs/src/index.ts:210-213,268-279`）；Jobs 注册还会验证 `agents.get(owner.id) === owner`（`$HOME/work/repos/deepseek-harness/packages/jobs/jobs-local/src/index.ts:442-455`）。所以“几十秒后调用同一个 live Agent”合法，也不会误投给同 id 的新会话。
- **中危：dsh-amp 没有 disposal fence。** Agent disposal 会先从 registry 移除精确实例，再发 `agent/disposed`（`$HOME/work/repos/deepseek-harness/packages/core/agent/src/index.ts:495-523`）；但 `ReactLoopAgent.followup/inject` 本身没有 disposed 检查，只是继续改该旧对象的 inbox/driver（`$HOME/work/repos/deepseek-harness/packages/core/agent-loop/src/agent.ts:128-147`）。`session.agent` 又被 sessions map 强引用到 stop/回收（`lib/live.js:633-680,1216-1245`）。标准 Jobs owner cleanup 通常会 cancel/settle run，缩小窗口；没有 jobs service、卸载时序异常或直接 dispose 的组合下，迟到通知仍可能写入已脱离 registry 的旧 Agent。
- **状态只有两个值**：`agent.status` 是 `'idle' | 'running'`；disposal 不是第三种 status（`$HOME/work/repos/deepseek-harness/packages/core/agent/src/runtime-types.ts:102-109,163-174`）。因此当前 `idle → followup，其他 → inject` 的值域判断没有漏掉 `disposing`，但也无法靠 status 判断对象是否仍注册。
- **`running` 时 `inject` 合法，但不是“必达当前请求”。** 合同只保证放到最近的后续 pre-step；若该 step 已 claim batch，它会错过本次 request，cancel/dispose 还可丢弃（`$HOME/work/repos/deepseek-harness/packages/core/agent/src/runtime-types.ts:233-241`）。它不会破坏 child run，且当前 catch 会吞掉投递异常（`lib/live.js:392-397`），安全性是“best effort”，不是可靠交付。

### 最小修法

- 在通知前验证 `ctx.get('agents')?.get(agent.id) === agent`；并监听 `agent/disposed`，对匹配 session 清掉 `session.agent`（最好同时让既有 Jobs owner cleanup 负责结束 run）。这既防 stale-agent 复活，也保持“绝不按 id 投给 replacement”的隔离原则（`packages/jobs/jobs-local/src/index.ts:442-455`；`packages/core/agent/src/index.ts:495-523`）。

## 4. `lastTurn` 语义

### 已确认

- **中危：当前 `lastTurn` 实际是“整个 run 最近一条带 text 的 assistant message”，不是“刚结束这一轮”。** `foldMessages()` 每遇到带 text 的 assistant message就覆盖全局 `session.lastText`，遇到 `end_turn` 只置布尔值（`lib/live.js:248-266`）；发送下一轮时只清 `turnEnded/turnEndedAt`，不清 `lastText`（`lib/live.js:923-943`）。所以第二轮若只产生 tool block、空 text 或异常结束，通知会把第一轮旧摘要再标成第二轮 `lastTurn`（`lib/live.js:367-382`）。terminal detail 也复用同一个旧值（`lib/live.js:788-809`）。
- **哪一轮该摘要**：轮末通知应摘要“触发这次 `end_turn` 的刚完成轮”；terminal 通知应摘要“最后一个已完成轮”，若 terminal 发生在未完成轮中则另标 `partialTurn`，不能拿更早轮冒充最后轮（`lib/live.js:265-270,367-382,788-809`）。

### 可执行改进

- 增加 `activeTurnText`、`lastCompletedTurnText`、`turnSeq`：新 run 初始化空值；只有“此前已 `turnEnded`，现在发送 normal next-turn message”时清 `activeTurnText` 并递增轮号，busy steer 不清；每个 assistant text 追加/有界更新 `activeTurnText`；观察到 `end_turn` 时原子复制到 `lastCompletedTurnText`，通知输出 `turn=<n> lastTurn=...`。terminal 在 `turnEnded=true` 时用 `lastCompletedTurnText`，否则把 `activeTurnText` 标成 `partialTurn`（`lib/live.js:248-266,633-679,923-943`）。

## 5. 改动 B 的风险与闭环

### 已确认

- **方向正确但会白付一次真实请求。** 池的明文规则确实把“本 ledger 从未见过”当标准 $5 新号（`lib/accounts.js:1-15`；`lib/ledger.js:1-13,24-25`），改动修掉了前三次 confirm 用尽后永远跳过后排 untouched 账号的饥饿（`lib/accounts.js:252-273`；`test/accounts.test.mjs:389-406`）。但“本机从未观测”不证明账号在 Amp 侧从未消费；若配置加入的是旧号/外部已用号，或远端授信规则改变，首次 run 会落到实际空号并支付一次拒绝。
- **中危：现在是遇到第一个 assumed 就立即 return，可能抢在后面的已确认健康号之前。** budget 用尽分支直接返回（`lib/accounts.js:256-270`），没有继续扫描后续无需 probe 的 fresh/ledger candidates；这把“防饥饿”扩大成“assumed 优先于后续 confirmed”。最小修法是记第一个 `assumed` candidate 后继续扫描，若后面有 confirmed funded 就选 confirmed，遍历结束才回 assumed（`lib/accounts.js:241-342`）。
- **credits 拒绝的纠偏闭环成立。** live settlement 会 classify 后调用 `noteRefusal`（`lib/live.js:500-519`），one-shot 也接了同一路径（`lib/index.js:374-390`）；`noteRefusal('credits')` 在任何 await 前先写 cooldown，再只重读该账号并 `ledger.observe`，所以下一次选号不会立刻重撞，且成功读取会把猜测换成余额事实（`lib/accounts.js:406-427,150-166`）。即使 refresh 失败，cooldown 仍成立；但 ledger 仍未知，窗口后还可能再试。
- **成功路径闭环不完全一致。** one-shot 非 refusal 会后台 `refresh(account.ref)`（`lib/index.js:383-390`）；live 成功只 `noteSuccess` 清 refusal/cooling，不 refresh 余额（`lib/live.js:520-529`；`lib/accounts.js:442-446`）。`noteDispatch` 会把 assumed 号变成“有记录但无 checkedAt/remaining”，下次 choose 才花一次 probe（`lib/ledger.js:146-155`；`lib/accounts.js:252-280`）。这不会永久撒谎，但违背文件头“run 后确认该号”的策略说明（`lib/accounts.js:10-15,380-392`）。

### 提示与修法

- 不必把余额风险升级成要求 delegating agent 手工选号；但 `amp_run` 应结构化返回 `balanceState:'assumed'`，而不是只把 `assumed 5` 埋在 `balance` prose（`lib/accounts.js:262-270`；`lib/live.js:870-881`）。同时让 live clean settlement 也触发一次后台 `refresh(ref)`；这样成功、credits 拒绝两边都能尽快把 assumption 改成事实。

## 6. 删除 `liveIdleSettleMs` 的后果

### 已确认

- **标准组合下不会因删除 2 分钟 settle 而永远无通知。** sweeper 每 30 秒主动 `absorb()`，所以即使无人 poll，`end_turn` 也会触发轮末通知，同时 run 保持可追问（`lib/live.js:41-43,275-317,1216-1233`）。这正符合“通知在轮末、结算是另一事件”的新目标。
- **20 分钟是泄漏回收，不是轮末通知保障。** 无 stdout/stderr 活动满 `liveIdleTimeoutMs` 后 sweeper 才 `finish(false)`，默认 20 分钟；随后 job completion 才是 terminal 通知（`lib/index.js:69-76,207-212`；`lib/live.js:1216-1247`）。它覆盖的是“owner 收到轮末通知却不再 steer/stop”以及轮末通知投递失败后的第二次机会，代价是 run/job 最长多占约 20 分钟，不能当作及时回执。
- **高危条件缺口：没有 timer 时可永远收不到任何通知。** `timer` 是可选 `ctx.get('timer')`，不存在就完全不注册 observer/sweeper（`lib/live.js:194-208,1216-1250`）。若 child 在 `end_turn` 后保持 stdin 开着、无人调用 `amp_send_message/amp_stop`，协议永不被 absorb、process 也不退出，于是轮末通知和 terminal job 通知都永远不发生；20 分钟回收同样不存在。最小修法是把 timer 变成 live 行的硬依赖并 fail loud，或提供不依赖 timer plugin 的宿主 interval。
- **低危：工具描述已经与实现相反。** `amp_run` 仍承诺“turn ended 后几分钟自动关闭并送 completion”（`lib/live.js:568-575`），实际现在先通知且保持 open，默认遗忘回收是 20 分钟。应改成“轮末会通知且保持可追问；遗忘 run 最迟按 liveIdleTimeoutMs 回收”。

### 疑似

- `notifyTurnEnd()` 对 message 构造/投递失败全部静默且不记 pending/retry（`lib/live.js:383-397`）。有 timer+jobs 时通常会在 20 分钟 settlement 再获 job completion；若 jobs 缺失或 owner 已 dispose，则没有可靠补偿。这是 best-effort 设计边界，尚未用真实 disposal/投递异常构造验证。

## 7. 改动 C：`resumable` 判决

### 已确认

- **高危：实现比描述更宽——成功和主动 killed 也会标 `resumable=true`。** 条件只有 `assistantMessages > 0 && artifactPath !== undefined`，不检查 job status、`failure`、exit 或 cancel（`lib/live.js:778-809`）。所以正常完成的 run 会被建议“start a new run ... continues”，直接诱发重复工作；主动取消也会被默认建议继续。现有两条测试只覆盖 compaction 与 credits 两种 failed，不会抓到这个过宽分支（`test/live.test.mjs:523-557`）。
- **“有 artifact”不等于“可原位续跑”。** terminal 后当前 run 已不可 steer（`lib/live.js:923-930`）；`amp_run` 参数只有 `prompt/mode`，没有 thread/account（`lib/live.js:568-583`）。因此 thread 已知也只能作为归因/人工救援线索，插件当前没有“同号同 thread 追问”能力。thread unknown 时仍可让新 run 读取 artifact 接手，但应称“artifact recovery/new run”，不能称 resume 原会话。
- **“work is on disk”仍说得过满。** `artifactPath` 只证明 finalize 成功；protocol reader 已明确承认 lossy 时 artifact 只含 observed bytes（`lib/live.js:229-237,830-834`），而 append 的失败返回值仍未进入 terminal 判决（`lib/live.js:275-285,531-544`）。C 把所有失败都套上确定语气，会掩盖 partial/lossy 情况。

### 最小修法

- 只在 `status==='failed' && assistantMessages>0 && artifactPath` 时输出 `recoverablePartial=true`；completed 不输出，killed 只写 `artifactAvailable=true`，除非取消方明确要求继续。文案固定为“read artifact, then start a new run from the recorded checkpoint”；另列 `thread=<id|unknown>`，但不要声称同 thread 可续。若 `lossy/artifactError`，降为 `recoveryEvidence=partial`（`lib/live.js:788-815`）。

## 8. 最小补测清单

当前 `bash test/run.sh` 为 **81/81 通过**；但现有轮末通知测试把 `followup/inject` 都实现成同一个 `push`，只证明“收到一条”，没有锚定投递分支、预算、多轮或 terminal 组合（`test/live.test.mjs:492-509`）。最小新增：

1. `notice: idle owner uses followup, running owner uses inject`——分别断言方法与 wake 行为（`lib/live.js:367-395`；`runtime-types.ts:217-241`）。
2. `notice: turn-end wakes share one budget with terminal completion and user input resets it`——至少先固定过渡实现的“3 次后 inject + user claim 重置”；最终应在 tool-jobs 集成测试固定共享预算/quiet delivery（`packages/jobs/tool-jobs/src/index.ts:204-229,278-299`）。
3. `notice: end_turn then terminal emits waiting then terminal with disjoint next actions`——断言前者可 send/stop、后者不可 steer；同一批 `end_turn+result` 只出 terminal（`lib/live.js:267-270,308-312,367-382,790-815`）。
4. `notice: disposed or replaced owner is never woken`——registry exact-object 校验失败时不调用旧/新 Agent（`packages/core/agent/src/index.ts:495-523`；`lib/live.js:633-680`）。
5. `notice: each multi-turn end summarizes only that completed turn`——第二轮 tool-only/空 text 不得重放第一轮 `lastTurn`，busy steer 不错误开新 turn sequence（`lib/live.js:248-266,923-943`）。
6. `live: missing timer fails loud instead of leaving an unobservable open run`；另保留 `live: forgotten waiting run settles at liveIdleTimeoutMs` 锚定 20 分钟只是回收（`lib/live.js:194-208,1216-1250`）。
7. `accounts: assumed candidate does not outrank a later confirmed funded account`；并补 `live: successful assumed dispatch refreshes its ledger fact`（`lib/accounts.js:252-270,322-342`；`lib/live.js:520-529`）。
8. `recovery verdict: failed partial is recoverable; completed and killed are not resumable`——覆盖 thread known/unknown、lossy 文案，防止只测两个 failed 正例（`lib/live.js:778-815`；`test/live.test.mjs:523-557`）。
