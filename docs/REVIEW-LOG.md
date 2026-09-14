# 评审处置台账（6 轮独立子代理评审）

每一行都是**可查证**的：发现的原文在对应 `REVIEW-*.md`，处置的依据是代码行或测试名。
"已降级"表示经实测/论证后判定为**有界且已写明**的残余，而不是沉默。

| 来源 | 发现 | 处置 | 依据 |
|---|---|---|---|
| `docs/reviews/REVIEW-full.md` | 终态有两个真源，可互相矛盾 | **已修**：`finish()` 末尾算一次 `terminalOutcome`，job 与 `amp_stop` 只投影 | `test/live.test.mjs` "both surfaces project ONE outcome…"、"a kill through the job…" |
| | artifact 部分写仍可报成功 | **已修**：`noteArtifactWrite` 折进 4 处写入点 → `durability` → 降级为 `failed` | "a partial durable record cannot be reported as clean success" |
| | artifact 无保留策略（无限占盘） | **已修**：`pruneRuns()` 安全优先 + 失败/成功各自名额 | 4 条 retention 测试 |
| | live 设置不热（改了静默无效） | **已修**：host 暴露 `ampSettings` 订阅，agent 行 `ctx.inject` 等待 + `current()` 对账 + 原地更新 | "the agent row follows a settings change…"、"a settings change between mount and subscribe is not lost" |
| | 并发选号无在途预留 | **已修**：占用（选择与占用原子化，30min TTL，fail-open 并标注） | "two concurrent dispatches never take the same account" 等 3 条 |
| | spill 已配置却称"完整流可取" | **已修**：有路径给路径，没有就明说早期字节不可恢复 | `lib/index.js` / `lib/live.js` 的诊断分支 |
| | `amp_runs` 是 host 级跨 session 视图 | **已降级**：写明为有意的救援面 | `docs/USABLE.md` §3 |
| | 多 host ledger 是 last-writer-wins | **已降级**：写明单 writer 前提 | `docs/USABLE.md` §3 |
| `docs/reviews/REVIEW-f26.md` | F26 退化：`$0.60` 压过 `$5` | **已修**：`headroom = max(mode bar, 起跑闸门)` | "the flagged regression: a $0.60 account must not outrank a later $5 one" |
| | 成功谓词只修一半（未含 durability/quiescence） | **已修**：封闭枚举下投影为 `failed` + `processStatus=completed` | "unproven quiescence cannot be a silent completed job" |
| `docs/reviews/REVIEW-f26b.md` | `amp_runs` 降级撒谎 / spread 失败对象引发次生错 | **已修**：`checkpoint:'unreadable'` + `checkpointError` + UNKNOWN；`list()` 失败抛 store 原因 | "a corrupt checkpoint is UNKNOWN…"、"an unlistable run root…" |
| | quiescence 未证实时仍给 `resumable` | **已修**：加门槛（`retryable` 同样加） | "resumable is withheld while quiescence is unproven"、"retryable is withheld…" |
| | 文档过度声明（多条） | **已修**：三份文档逐条降级到可复核 | `docs/AMP-LIMITS.md` 证据强度列、`docs/USABLE.md` §3 |
| `docs/reviews/REVIEW-notice.md` | 轮末 `followup` 绕过平台唤醒预算，可无限自激 | **第 7 轮推翻后重做**：当时的"每 run 最多 3 条"既不按 Agent 计数、又会丢弃超额通知，**不是**对齐平台预算（见文末第 7 轮）。现为 `WeakMap<Agent>` + 真人输入补回 + 超额降级 `inject` | "the turn-end notice mirrors the HOST wake budget…"（第 7 轮） |
| | 两条通知的"下一步"互相矛盾 | **已修**：`state=waiting` / `state=terminal` 分开措辞，终结通知不再建议 steer | "the terminal notice describes a terminal run…" |
| `docs/reviews/REVIEW-round7.md` | 保留策略会删**未完成**的救援 run | **已修**：只有 checkpoint 可读且 `finished:true` 才可删 | "a run that never finished is NEVER auto-deleted…" |
| | 空闲超时并非热更新（我的文档不实） | **已修**：sweep 每 tick 重读 | `lib/live.js` idle sweep |
| | 订阅在服务缺失时静默冻结 | **已修**：`ctx.inject` 等待 + 缺失告警 + 消竞态 | "a missing settings service is announced…" |
| `docs/reviews/REVIEW-round8.md` | **准入晚于 spawn**（它判为高危） | **部分 + 实测降级**：prompt 移到准入之后、无 jobs 直接拒绝、停稳后才报错；残余=被遗弃的服务端 thread，**实测不做模型工作** | "admission is decided BEFORE the prompt is delivered…" + `docs/AMP-LIMITS.md` #11（netcap 实测 `num_turns:0`） |
| | disposer 不 join 结算 | **已修**：`teardownAll` async + `await Promise.allSettled` | `lib/live.js` |
| | 未分类失败被当成功保留 | **已修**：终态 `status` 写进 checkpoint，保留策略优先读它 | "the checkpoint carries the projected status…" |
| | quiescence 未证实时仍建议"新开 run" | **已修** | 终态 notice 分支 |
| | `retryable` 未限 `failed` | **已修** | 同上 |
| | `DELIVERY_MAX_CHARS` 被当作字节上限 | **已修**：独立 `DELIVERY_MAX_BYTES=32KiB` | `lib/live.js` |
| **自查** | **设置页会占用账号**（我加在途预留时漏改 web 路由） | **已修**：改用 `pool.preview()`（只选择不占用） | "the settings page must PREVIEW the next account, never claim it" |
| **自查** | **模型面向说明承诺了已删除的行为**（自动关闭） | **已修** + 加**漂移守卫**测试 | "the model-facing descriptions describe the plugin that exists" |
| **自查** | live 路径缺字节守卫（与 one-shot 口径不一） | **已修**：`amp_run`/`amp_send_message` 同规则，且在选号之前 | "the live path refuses an oversized prompt before it claims an account" |

| `docs/reviews/REVIEW-final.md`（终审，只求判决） | 无 timer 时 observer/sweeper 静默跳过（轮末通知 + 20 分钟回收全失效） | **已修**：mount 告警 + 工具说明 `WARNING` + 每次派发返回带 `warning` | "a host with no timer service is LOUD about losing notices and the reaper" |
| | 轮末通知上限"无判别测试" | **误判已更正**：测试存在（`test/live.test.mjs:573` 断言 5 次轮末只收到 3 条）——评审 grep 的是字段名 `turnNotices`，测试断的是行为 | 同上 |
| | 其余 6 条高危 | **已修**（逐条见 `docs/reviews/REVIEW-final.md` 的表，本次复核与代码一致） | `docs/reviews/REVIEW-final.md:13-21` |

## 仍属已知边界（有意保留，均已写进 `docs/USABLE.md` §3）

1. 大输出的 spill gap **不回补**（诊断已诚实）。
2. 多 host 共用 `DSH_HOME`：ledger 单 writer；`amp_runs` 会把另一进程的 live run 也标 `interrupted`。
3. 模式列表在 mount 固定（工具 schema 的 enum）；其余设置字段都是热的。
4. ~~准入被拒时子进程已被 spawn~~ **第 7 轮已消除**：执行资源全部移进 `jobs.start` 的 `run()`，preflight 拒绝 ⇒ 无进程、无 thread、无占用。
5. 非交互 thread 续接不可用；`@ampcode/sdk` 的 `continue` 未验证。

## 未做但记录在案的实验（想要更高确定性时）

- 用 `@ampcode/sdk` 的 `execute({ continue })` 验证本地 thread 续接。
- 给 mitmproxy 加 `-s` 脚本 dump WebSocket 帧，直接读 `error_set` 全文。
- 长 idle 后单次请求，确认限流窗口的时间性质。

---

# 第 7 轮：AMP 子代理 × DSH 上游源码契约评审（2026-09-14）

> 方法：2 个 AMP（medium）子代理并行（host 契约 / agent 平面运行时），参考真源为 DSH 上游
> `master c291e796`（与已安装 `0.1.5-rc.2` 同代）+ 编译产物；Lead 逐条复核，其中 R1/R4 亲自复现、
> 7 条关键契约在源码中核实。产物：`docs/reviews/REVIEW-amp-contract.md`、`docs/reviews/REVIEW-amp-runtime.md`、
> `docs/reviews/REVIEW-amp-summary.md`。判决：**0 P0 / 6 P1 / 9 P2**，全部处置，回归测试 135 → 151。

| 来源 | 发现 | 处置 | 依据（测试 / 源码） |
|---|---|---|---|
| runtime R1（P1） | `result` 抢先置 `finished` → exit watcher 不再 `finish()` → **DSH job 永久 running** | **已修**：`resultReceived` 与 `finished` 分离；退出观察者以 `settlePromise` 去重 | `AMP-R1`；Lead 复现（`jobs.hooks.done` 超时） |
| runtime R5 + contract C2（P1） | `start()`/jobs 拒绝路径泄漏账号 claim 30 分钟、`noteDispatch` 早于 spawn、abort listener 残留 | **已修**：公开 `release()` + 校验前移 + spawn 后记账 + `finally` 回收 | `a rejected start() hands the account claim back`、`AMP-C2`、`prompt refused before selection` |
| runtime R5（P1） | jobs preflight 仍在 spawn 之后（"no execution resource" 契约不成立） | **已修**：执行资源移入 `run()` | `a refused job slot starts NOTHING…`、`admission … starts no process` |
| contract C5（P1） | `amp usage` 把 `graceMs` 当执行超时 → 可无限阻塞选号 | **已修**：`AbortSignal.timeout(20s)` + 5s 终止宽限 + unreadable 语义 | `AMP-C5` ×2；DSH `subprocess/src/types.ts:83-96` |
| runtime R3（P1） | live 路径丢弃 `system` 错误 → 两条路径 kind 不一致、不 `noteRefusal` | **已修**：折叠 `systemError` 进同一 classifier | `AMP-R3` |
| runtime R2（P1） | 轮末通知 per-run 预算绕过宿主 per-Agent 预算，且第 4 条被丢弃而非降级 | **已修**：`WeakMap<Agent>` + `agent/inbox/claimed` 补回 + 超预算 `inject` | `the turn-end notice mirrors the HOST wake budget…`；DSH `tool-jobs/src/index.ts:207-229,268-299` |
| runtime R8（P1→文档） | `AMP-LIMITS #11` 用单样本写"不做模型工作/零费用" | **已修**：措辞降到证据强度 + 写明现在根本不 spawn | `docs/AMP-LIMITS.md` #11 |
| contract C1（P2） | settings 注册失败被吞 → 页面写一套、派发用另一套 | **已修**：error 级日志 + `pool.settingsError` + 拒绝派发 + 页面只读并显示原因 | `AMP-C1`（provider）、`AMP-C1`（路由）、`AMP-C7` |
| contract C3（P2） | `dispose()` 吞 `waitForExit()` 失败 → 虚假宣告停稳 | **已修**：teardown 直接 await，未证明则 reject | `dispose() refuses to claim quiescence it could not prove` |
| contract C4（P2） | 派发读 watcher 维护的镜像 → commit 窗口内可读旧值 | **已修**：按 `scope.get()` 现取权威值 | `AMP-C4`；DSH `settings/src/index.ts:787-807` |
| contract C6（P2） | remount 重置 run id 计数 → 同父命名空间可重号 | **已修**：`randomUUID()` | `the run id is unique across mounts…` |
| contract C7（P2） | client 未解析 `remote.settings` 就调用 → 同步抛错、页面 busy 卡死 | **已修**：经 `ctx.get('remote.settings')` 解析，缺失即只读 | `AMP-C7`（静态契约锁） |
| runtime R4（P2） | 跨 host 同毫秒 artifact key 冲突 → prune 删掉在线救援记录 | **已修**：key 加 pid+uuid，并修 `epochOf`（正则解析） | `A5`、`AMP-R4`；Lead 复现碰撞 |
| runtime R1b（P2） | settlement 重入时后到的 kill 不进终态事实 | **已修**：重入分支先置 `killedByCancel` | `AMP-R1b` |
| runtime R7（P2） | waiting 通知把所有 failure 都叫 retryable | **加固**：改用 `isNoWorkFailure()`；**该分支当前不可达**（`failure` 只在 `finish()` 赋值，那时通知已被抑制），故无判别测试，如实记录 | 代码注释 + 本节 |
| runtime R10（P2） | "disposer join 结算"无判别测试（变异绿） | **已修测试**：harness 现在 await disposer 返回值 | `AMP-R10` |

## 第 7 轮的对抗性复核结论（推翻/修正既有处置的三条）

1. "轮末通知每 run 3 条 = 对齐平台唤醒预算" —— **不成立**（宿主按 exact Agent、真人输入补回、超额降级 `inject`）。
2. "准入被拒已降级为符合 jobs 契约" —— **不成立**（`run()` 之前的 spawn 就不是"no execution resource"）；本轮改为结构上合规。
3. "`AMP-LIMITS #11` 实测不做模型工作/零费用" —— **措辞强于证据**（单样本、无计费证据）；且该形状已被第 53 项消除。

另有两条**测试有效**的既有处置（artifact 部分写、retention 不删未完成）与四条**窄结论有效**（quiescence 门槛、checkpoint status、no-timer 响亮、terminal 通知措辞），保留。

---

# 第 8 轮：修复验证（AMP medium × 2，2026-09-14）

> 对象 = 第 7 轮修复后的构建（`index fc0ba7f93be8` / `live ebea32961479`，运行时=磁盘=安装副本已实测）。
> 产物：`docs/reviews/REVIEW-amp2-fixes.md`（0 P0/2 P1/5 P2）、`docs/reviews/REVIEW-amp2-runtime.md`（0 P0/3 P1/3 P2）。
> 判决：**第 7 轮的 16 条里有 3 条没有真正闭环**，另有 7 条新发现；全部已处置（`CHANGELOG.md` 第 14 批，测试 151 → 164）。

| 轮次 | 发现 | 处置 | 依据 |
|---|---|---|---|
| 8 | **#52 被推翻**：live `finish()` 的 release 写在 try 里，结算早期抛错就跳过 → 号被占 30 分钟、记录不 finalize | 已修：释放+finalize 进真 `finally` | #68；`AMP-G1` |
| 8 | **#59 不完整**：`dispose()` 传播了 rejection，但没给"仍未退出"设界 → 可永久挂住 | 已修：`waitForExit(signal)` + `false` 即抛 UNPROVEN | #69；`AMP-G2` |
| 8 | **#65 是空壳**：把 `await Promise.allSettled` 改回 `void` 仍全绿 | 已修测试：gate 断言 disposer 不得提前 resolve | #76；`AMP-R10`（变异变红） |
| 8 | claim 按 ref 而非按 run → 同账号并发时互相释放 | 已修：run-scoped 租约 token | #67；`AMP-G3*` |
| 8 | `alive:false` 与 `quiescenceUnproven` 自相矛盾 | 已修：`alive` 三态（`null` = 未知） | #70；`AMP-G6` |
| 8 | `limit:0` 在 tool/web/client 三层都反转成默认 12 | 已修：三层都传 0 | #71；`AMP-G4` |
| 8 | `amp_runs` 同毫秒按字典序取 newest | 已修：`(epoch, mtime, key)` | #72；`AMP-G7` |
| 8 | 空 prompt 会启动无意义 run | 已修：选号前拒绝 | #73；`AMP-G5` |
| 8 | `run()` 抛错只 terminate，不关 artifact | 已修：启动有界等待 + finalize | #74 |
| 8 | 无 settings 服务时 client 建议"重启" | 已修文案 | #75 |
