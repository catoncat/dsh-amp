# REVIEW-amp-summary：AMP 子代理评审（第 7 轮）汇总与终审

> 方法：2 个 AMP（medium）子代理并行评审 + Lead 独立复核。
> 对象 revision：`lib/index.js 2a98f74f7a90`、`live.js da693738896f`、`accounts.js 691b017f2cbf`、`artifact.js 8f3ec02d7d15`、
> `ledger.js 209c5fc3ebea`、`outcome.js 82bbd05cc37c`、`source.js 152d5ec53d5d`、`web.js 5561f4befb7f`、`client.js bc9dc21e75d7`、`live-plugin.js 4cbeffeb3216`
> 参考真源：**DSH 上游源码**（`https://github.com/deepseek-ai/deepseek-harness/tree/master`，master `c291e796`，本地 clone `/tmp/dsh-harness-ref`）
> \+ 宿主真正加载的编译产物 `$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/`。
> 二者同为 `0.1.5-rc.2`，属同一代契约（已核 5 个包的 version）。
> 测量：`bash verify.sh` → 135/135 通过、`deploy --check` in-sync、运行时 `amp_accounts.source.modules` 与磁盘逐文件一致（**评审源码 = 评审在跑的构建**）。

## 1. 判决

**0 个 P0；6 个 P1、9 个 P2。** 本轮是前 6 轮之后第一次**系统比对 DSH 宿主源码**，
因此最有价值的三类结论都是前 6 轮没覆盖的角度：

1. **宿主契约违反**（不是内部逻辑自洽问题）：`amp usage` 探针把 `graceMs` 当执行超时（可无限阻塞派发）、
   `dispose()` 吞掉停稳证明、`jobs.start` 的 "无 execution resource" 契约仍被绕过。
2. **推翻 3 条既有"已修"依据**：轮末通知"对齐平台唤醒预算"、"jobs 拒绝已降级为符合契约"、
   `AMP-LIMITS #11` 的"不做模型工作/零代价"措辞强于证据。另有 1 条测试空壳（disposer join）。
3. **一个会挂住宿主的真实缺陷**：stream-json 的 `result` 抢先把 session 标成 finished，可让 DSH job
   **永久不结算**——Lead 已亲自复现（见 §3 R1）。

同时，本轮评审自身就是一次真实 dogfood：宿主按文档行为把两个 medium run 派到 `$5.00` / `$4.83` 两个号；
runtime run 被上游 credits 掐死时，**成果完整落盘**、`resumable=true` 指向 artifact、终态通知照常送达；
contract run 的**回合结束通知**（`state=waiting`）也在会话中实测到达。这几条能力**经实测成立**。

## 2. 两份子报告

| 报告 | 评审员 | 内容 |
|---|---|---|
| `docs/reviews/REVIEW-amp-contract.md` | AMP medium（account `AMP_API_KEY_8`） | host 平面 × DSH 契约：provider/subprocess/settings/credentials/bundle/web/client。5 P1 + 2 P2 |
| `docs/reviews/REVIEW-amp-runtime.md` | AMP medium（account `AMP_API_KEY_11`） | agent 平面运行时语义 + 对抗性复核（9 组变异测试）。6 P1 + 2 P2 |

runtime 子代理在**完成报告主体后被上游 credits 掐断**（`failure=credits`）——这本身是插件文档行为的实测：
artifact 完整、`resumable=true`、终态通知携带 artifact 路径。报告已无占位文本，无需续跑。

## 3. 终审清单（Lead 已逐条复核证据）

严重级为 **Lead 校准值**（子代理倾向高估）。"Lead 复核"= 我亲自读源码/跑实验得到的结论。

| # | 级别 | 发现 | 子代理判定 | Lead 复核 |
|---|---|---|---|---|
| R1 | **P1** | `result` 一旦被吸收即置 `session.finished=true`（`live.js:299-303`），进程随后退出时 exit watcher（`:875`）因 `finished` 已真而**不调用 `finish()`**，`markSettled` 永不执行 → **DSH job 永久 running**、终结通知永不到达、owner teardown 可能挂住 | P1 | **实证复现**：用 `test/` 的 fake harness 跑对抗测试，`jobs.hooks.done` 30ms 内 timeout（`/tmp/lead-verify-result-race`） |
| R2 | **P1** | 轮末通知自建 per-run 3 次预算（`live.js:394-442`），与宿主 per-Agent `WeakMap` + 真人输入重置 + **超额降级为 `inject`**（`jobs/tool-jobs/src/index.ts:207-229,268-299`）语义不同：多 run 可绕过防自激上限，且第 4 条被**直接丢弃**而非降级 | P1 | **源码对照确认**；`docs/REVIEW-LOG.md`"对齐平台唤醒预算"措辞不成立（`REVIEW-final.md` 只承认"按 session 计数"的残余，漏了丢弃 vs 降级与 user-input 重置） |
| R3 | **P1** | live 路径不折叠 `system` 非 init 错误（`live.js:273-305,607-612`），one-shot 路径折叠且送入同一 classifier（`index.js:375-396`）→ 同一上游错误两条路径 kind 不同，live 侧 `failure=null`、不 `noteRefusal`，下次可能重挑被限流的号 | P1 | **源码对照确认**（grep 全文件无 `systemError` 分类输入） |
| C2+R5 | **P1** | `start()` 在 **claim 之后**仍有多处可抛错（非 text block `index.js:288-295`、prompt 超限 `:345`、`resolveExecutable` `:320`），且 `jobs.start` 拒绝路径（`live.js:993-1023`）同样只 `finish` 不释放 —— 账号被错误 claim **30 分钟**（`accounts.js:175-177`），ledger `runs` 已 +1，`request.signal` 上的 abort listener 也残留；pool **没有公开 release API** | 两位评审从各自文件**独立命中同一根因** | **源码对照确认**（`accounts.js` 只导出 choose/select/preview/noteRefusal/noteSuccess…，无 release） |
| C5 | **P1** | `readOne()` 把 `USAGE_TIMEOUT_MS=20s` 传给 `graceMs`，**无 `signal`、无 timer**（`accounts.js:141-166`）→ DNS/代理/上游挂起时 `handle.done` 永不 settle，`pool.choose()` 与设置页 refresh worker 一起无限阻塞 | P1 | **实证/源码对照**：DSH `subprocess/src/types.ts:83-96` 原文 "The caller owns deadlines"，`graceMs` 只用于**终止流程与退出后 drain**；`signal` 才是取消入口 |
| R8 | **P1** | `AMP-LIMITS.md:19` 与 `USABLE.md` 用绝对措辞（"不做模型工作/代价不是推理"）支撑自 `num_turns:0` **单样本**；DSH jobs 合同只保证 preflight **前**无 execution resource，对该 Amp thread 的计费不作任何保证 | P1 | **源码对照确认**（jobs `src/index.ts:73-82` 原文 "Any preflight rejection leaves no job id or execution resource"），文档措辞需降级 |
| C1 | P2 | `settings.register()` 失败（重复 namespace / 存量分节非法）只 warn 后 `return`（`index.js:540-548`），provider 继续用 composition `holder.value`，而 client 页面仍向同一 namespace 写入（`client.js:387`）→ **页面保存成功、派发用另一套值** | P1 | 源码对照确认机制（`settings/src/index.ts:409-426` 明定 duplicate 失败即抛）；但触发条件非日常 → 降 P2，修法：fail loud |
| C3 | P2 | `dispose()` 的 teardown 吞掉 `waitForExit()` rejection（`index.js:493-505`）→ `dispose()` 在**未证明停稳**时 resolve；契约要求 "awaits the backend's teardown to actual exit"（`out-of-process.ts:237-256`） | P1 | 源码对照确认；影响限于信号丢失（live 路径本身已用 `quiescenceUnproven` 诚实上报）→ P2 |
| C4 | P2 | settings commit 先换 `registration.resolved` 再排 watcher microtask（`settings/src/index.ts:787-807`），插件却以异步 watcher 维护的 `holder.value` 为派发真源（`index.js:270,548-567`）→ 同一提交窗口内的派发可能读旧值 | P1 | 源码对照确认时序；可达窗口窄（需同步触发派发）→ P2 |
| R4 | P2 | artifact key 仅 `${runId}-${Date.now()}`（`live.js:738`；`runId` 是**每进程计数器**，跨 host 必然同名）→ 两个 host 同毫秒启动即同目录；A finalize 后 prune 会**删除仍在线**的 B 的记录 | P1 | **实证复现**（`/tmp/runtime/artifact-collision.mjs`）：`sameDir:true`、`removed:[...]`、B 的 append "成功" 写入已 unlink inode、下一次 checkpoint ENOENT。需多 host 同 `DSH_HOME` + 同毫秒 → 降 P2，修法 `pid/uuid` |
| R1b | P2 | settlement 重入时后到的 `kill` 只 terminate 不置 `killedByCancel`（`live.js:540-559`）→ 被用户 kill 的 run 可能报 `failed`（甚至 `completed`）而非 `killed` | P1 | 源码对照确认；与 `finish()` 注释 "a kill arriving mid-settle is still honoured" 不符 → P2 |
| C6 | P2 | run id 来自 per-mount 计数器（`index.js:572-581`），remount 后从 1 重来，而 DSH 要求 remote provider 的 id 在**父命名空间唯一**（`subagent/src/types.ts:308-314`） | P2 | 源码对照确认 |
| C7 | P2 | client 只 inject `remote` 却无条件调用 `ctx.remote.settings.update`（`client.js:381-387`）→ 缺服务时 `write()` **同步抛错**，`.catch` 接不住、页面 busy 卡死；官方 `ui-settings` 声明了 `inject=['remote','remote.settings']` | P2 | 源码对照确认代码事实；**生产组合可达性未证**（子代理已诚实标 SUSPECTED） |
| R7 | P2 | waiting 通知的 `noWork` 只查 `failure!==undefined && assistantMessages===0`（`live.js:412-414`），未用 `isNoWorkFailure`（`outcome.js:44-47`）→ `other` 失败也被标 `retryable=true`，与 `describeFailure('other')`="not safe to retry blind" 冲突 | P2 | 源码对照确认 |
| R10 | P2 | `docs/REVIEW-LOG.md` 记 "disposer 不 join 结算已修"，但 `test/` 的 fake `ctx.effect` **从不 await disposer**（`test/live.test.mjs:108-111`）→ 把 `await Promise.allSettled` 改成 `void` 仍 **135/135 全绿** | P2 | 实证：变异全绿 → 该行为**回归无保护**（代码本身正确） |

## 4. 对抗性复核：既有"已修"判决表（runtime 子代理 + Lead 抽验）

| 台账条目 | 变异后 | 判决 |
|---|---|---|
| 终态双真源已修 | 红 | **依据不实（覆盖不全）**：只锁普通投影，未覆盖 `finish(false)→finish(true)`（见 R1b） |
| artifact 部分写已修 | 红 | 测试有效 |
| retention 不删未完成救援 run | 红 | 测试有效（**单 host/唯一 key 范围**；跨 host 见 R4） |
| 轮末通知"对齐平台预算" | 红 | **依据不实**：只断言单 run 第 4 条被丢，未断言 per-Agent/重置/降级 inject（见 R2） |
| admission 在 prompt 前 | 红 | 有效但**窄**：只证明 prompt 未投递，不证明 preflight 前无进程/thread/claim |
| 准入已实测降级为"无推理 thread" | 不适用 | **依据不实**（见 R8） |
| quiescence 未证实不给 retryable/resumable | 红 | 测试有效（terminal notice 范围） |
| 未分类失败 status 写 checkpoint | 红 | 测试有效 |
| 无 timer 时 fail loud | 红 | 测试有效 |
| disposer join settlement | **绿** | **测试空壳**（见 R10） |

变异方法：`/tmp/runtime/mutate.mjs`，每组在独立副本 `/tmp/runtime/m-*` 上跑 `test/run.sh`；其中 1 组
（admission-before-delivery）因模式未匹配标 `MUTATION_NOT_APPLIED`，已改用独立形状实验补证。

## 5. 已确认无误（本轮专门查过、无问题）

- provider 注册：`name/capabilities/inheritsParentContext:false/start` 字段齐全且语义用对；重名会抛错回滚。
- `settleRunResult` / `subprocessRunHandle` 的字段与时序理解正确（除 C3 的吞错）；abort listener 由 helper 移除。
- `collected.stdout.readFrom(0)` 的 `lossy/spillPath` 语义解读正确（不把 retained tail 当全流）。
- 显式 `env` 在 ambient scrub 后合并：**实测** 两个 sibling 进程各 93 个环境键、`AMP_*` 仅有 `AMP_API_KEY` 且恰好一次。
- `cordis.patch.yml` / `dsh.bundle.patch` / `dsh.client.inject` / `exports` 装配正确；三个注入包真实存在；host 平面不设 `isolate` 正确。
- `amp_runs` 的 checkpoint 三态（ok/unreadable/UNKNOWN）、`interrupted` 不猜、保留策略只删 `finished===true`：一致。
- 无 timer 时的降级是**响亮**的（mount warn + tool 描述 warning + 每次 `amp_run` 返回 warning），变异测试可判。
- 账号选择串行化 + 30 分钟 fail-open claim（P1 只针对**未发布 run 时不回滚**这一点）。

## 6. 建议修复顺序

1. **R1**（job 永不结算）：把"看到 result"与"已 settlement"分开——fold 只置 `resultReceived`，`finished` 只在
   `finish()` 的 finally 置真；exit watcher 仅以 `settlePromise/settling` 去重。
2. **C2+R5**（claim 泄漏）：给 pool 一个公开 `release()`，把纯校验与 `resolveExecutable` 移到选号前，
   `noteDispatch` 移到 spawn 成功之后；`jobs.start` 拒绝分支显式 release。
3. **C5**（探针超时）：每次 usage probe 用 `AbortSignal.timeout(USAGE_TIMEOUT_MS)` 并传 `signal`，
   `finally` 里有界 `terminate()`+`waitForExit()`；超时按 unreadable 而非余额为零处理。
4. **R3**（system 错误）：live session 增加 `systemError`，分类输入统一为 `result.error ?? systemError ?? exitError`。
5. **R2**（唤醒预算）：改用宿主 owner-scoped reporter（复用 per-Agent 预算）；本地实现至少 `WeakMap<Agent>` +
   `agent/inbox/claimed` 重置 + 超额 `inject`。同步修正 `USABLE.md`/`REVIEW-LOG` 的措辞。
6. **C3 / C1 / R1b / C4 / C6 / R7 / C7 / R4**：低成本一起收（显式重抛停稳失败、settings 注册 fail loud、
   重入分支先置 `killedByCancel`、按 `scope.get()` 取权威值、id 加 `randomUUID()`、`noWork` 复用 `isNoWorkFailure`、
   `inject` 加 `remote.settings`、artifact key 加 `pid/uuid`）。
7. **文档**：R8（`AMP-LIMITS #11` 措辞降到证据强度）；R10（补一个会 await disposer 的 effect harness 测试）。

## 7. 未验证 / 下一轮（诚实清单）

- **C7 的生产可达性未证**：需在真实 web 组合里延迟/破坏 `remote.settings` contribution，观察页面 fiber 是否仍激活。
- **R1 的真实触发概率未测**：机制已实证，但真实链路中 `result` 字节与进程退出之间的窗口未在真机测量；建议修完补一条"无 `amp_stop` 也能结算"的集成测试。
- **C4 的同步调用窗口未实测**：需挂一个同步 `settings/updated` listener 再立刻派发。
- **R8 的计费未验证**：要证明"零费用"需在隔离账号记录拒绝前后余额/账单，并覆盖三类 `start` rejection。
- **stale Agent 通知（SUSPECTED P2）**：`notifyTurnEnd` 持有 exact Agent 强引用且不查 registry 验活；
  需在 owner dispose 与 live-row disposer 交错窗口用真实 scope 测试判定。
- 本轮**未改动 `lib/`、`test/`、`docs/REVIEW-LOG.md`**；两份子报告与新文件是本轮全部产出。
