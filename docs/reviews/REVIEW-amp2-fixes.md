# REVIEW-amp2-fixes：host 平面与外围修复验证
> 评审员：AMP medium 子代理（fixverify，第 8 轮）；对象 revision：`index fc0ba7f93be8`、`accounts 286be3a61d07`、`client 7916d9bd7ece`、`web a17cb77b554b`、`live ebea32961479`；dsh 源码 revision `c291e79`
> 方法：逐行对照第 7 轮三份报告、`CHANGELOG.md` 第 13 批、插件源码与 DSH `subagent`/`subprocess`/`jobs` 真源；原树完整测试 151/151 通过；在 `/tmp/fixverify/` 做 6 组变异及 1 个结算异常反例。

## 1. 结论

第 7 轮不是 16 条全部闭环：**#52 被 live 结算异常反例推翻，#59 只修了 rejection 传播而没有给“仍未退出”加 deadline，#65 所称判别测试经原样变异仍全绿**。结论为 **0 P0 / 2 P1 / 5 P2**。

host one-shot 的常规 claim/listener 路径已闭合，settings 注册失败四条路径也确实联动；但 `limit:0` 在 tool、web、client 三层分别被规范化成“默认 12”。第 7 轮新增测试中，抽查的 5 条 provider/web/client 测试均能杀死对应变异；`AMP-R10` 是已实证的空壳测试。

## 2. 逐条验证第 7 轮修复

| 条目 | 是否真的修好 | 反例或证据 | 判决 |
|---|---|---|---|
| #51 终态不由 result 冒充 | 是 | `foldMessages` 只置 `resultReceived`，`finished` 仅在 `finish()` finally 写；`AMP-R1` 覆盖 result 先到、exit 后到并使 job 结算（`lib/live.js:727-733`、测试 989-1011）。 | ✅ 兑现 |
| #52 claim 全路径回收 | **否** | one-shot 的校验前移、发布前 catch、`attempt` finally 均正确；但 live `finish()` 先 `absorb()`，到 `lib/live.js:693` 才 release。reader/artifact 异常会跳过 release。隔离反例得到 `job=failed, released=[]`。 | ❌ 被 F1 推翻 |
| #53 jobs 执行资源移入 `run()` | 是 | jobs 存在性在选号前检查；spawn/session/artifact 在 `jobs.start().run` 内；preflight 拒绝时 `spawns=[]`，且 run 内异常 terminate 已建 handle（`lib/live.js:796-810,857-877,1097-1108`）。 | ✅ 兑现 |
| #54 usage probe 真实 deadline | 是（目标运行时） | `AbortSignal.timeout(20s)` 同时传入 resolve/spawn，`graceMs=5s`，finally terminate；真实 20s 回归通过且结果为 unreadable（`lib/accounts.js:156-205`）。当前 Node 24 具备 `AbortSignal.timeout`。 | ✅ 兑现 |
| #55 live 折叠 system 错误 | 是 | classifier 输入为 `result.error ?? systemError ?? exitError`，`AMP-R3` 端到端得到 `failure=rate-limit`（`lib/live.js:657-669`）。 | ✅ 兑现 |
| #56 通知镜像宿主预算 | 是 | per-Agent `WeakMap`、真人消息补回、超额 inject；回归覆盖同 agent 三次 wake 后降级，不丢通知。 | ✅ 兑现 |
| #57 settlement 重入记录后到 kill | 是 | 已有 settlePromise 时若未退出，先置 `killedByCancel` 再 terminate；`AMP-R1b` 覆盖 mid-settle kill（`lib/live.js:585-600`）。 | ✅ 兑现 |
| #58 settings 注册失败 fail-loud | 是（注册失败范围） | `settingsState.error` 拒绝 provider；`pool.settingsError` 同时供 live/web；client 以该字段转只读。删除 web 字段的变异使 `AMP-C1` 失败。完全没有 settings 服务是有意的 composition-only 模式，不设置 error；其 UI 文案仍有 F5。 | ✅ 主声明兑现 |
| #59 dispose 不吞停稳失败 | **不完整** | `await handle.waitForExit()` 的 rejection 会传播；但未传 signal，managed range 一直非空时 promise 永不 settle，不会像声明所说“未证明即 reject”。见 F2。 | ❌ 声明强于实现 |
| #60 派发读取权威 settings | 是 | `currentResolved` 指向每次 `scope.get()` 的 `authoritative`；变异回 watcher mirror 后 `AMP-C4` 失败（`lib/index.js:626-657`）。 | ✅ 兑现 |
| #61 UUID run id | 是 | one-shot id 保留 mode 前缀并用 `randomUUID()`；固定 id 变异使跨 remount 测试失败。全树搜索未发现依赖可预测 one-shot id 的 ledger/artifact/工具。 | ✅ 兑现 |
| #62 client 解析 nested Remote | 是 | `ctx.get('remote.settings')` 后才构造 write，缺失时只读；改回直接访问变异使 `AMP-C7` 失败（`lib/client.js:390-403`）。 | ✅ 兑现 |
| #63 artifact key 与 epoch 排序 | 是 | key 为 `runId-epoch-pid-uuid`；排序用独立 13 位 epoch 正则，不再读取末段；`AMP-R4` 通过（`lib/live.js:942-946,1500-1519`）。 | ✅ 兑现 |
| #64 waiting 重试判据加固 | 是（防御性） | 分支使用 `isNoWorkFailure()`，且 CHANGELOG 已诚实注明当前不可达、无行为修复、无判别测试。 | ✅ 声明与实现一致 |
| #65 disposer join 判别测试 | **否** | 将 `lib/live.js:232` 的 `await Promise.allSettled(settling)` 原样改成 `void Promise.allSettled(settling)` 后，完整套件仍 **151/151 通过**。测试只要求 1s 内最终 joined，未断言 disposer 在 settlement 之前不得 resolve。 | ❌ 空壳测试，见 F4 |
| #66 AMP-LIMITS 文档降级 | 是 | #11 明示单样本、不能证明所有版本无 inference、不能证明零费用，并说明新 preflight 不 spawn（`docs/AMP-LIMITS.md:18`）。 | ✅ 兑现 |

## 3. 新发现

### F1 [P1][动态反例] live 结算异常仍泄漏 claim 30 分钟

- **路径**：`finish()` 的 `absorb(session)` / `flushPending` / artifact finalize 均可抛；release 位于同一个 try 的后半段（`lib/live.js:650-718`），catch 直接进入终态 finally（`:719-733`）。这与 one-shot `attempt()` 的真正 finally（`lib/index.js:508-513`）语义不一致。
- **复现**：在 `/tmp/fixverify/base` 把 live handle 的 `collected.stdout.readFrom` 改为 throw；job 正常结算为 failed，但 `released=[]`。输出：`/tmp/fixverify/live-release-repro.out`。
- **影响**：号仍 claimed 到 30 分钟 TTL；结算恰好出错时再次出现 #52 要消除的避号/池退化。`noteRefusal`/`noteSuccess` 的间接 release 也在该 throw 之后，不能兜底。
- **最小修法**：把幂等 `pool.release(session.accountRef)` 放进 `finish()` 最外层 finally，并在 `markSettled()` 前执行；新增上述 throwing-reader 回归。

### F2 [P1][源码 + 可构造] one-shot dispose 可永久挂住

- `teardown` terminate 后调用无 signal 的 `await handle.waitForExit()`（`lib/index.js:536-550`）。DSH 合约明确 `waitForExit(signal?)` 只有带 signal 才会在 managed range 未空时返回 `false`；不带时会一直等待（`subprocess/src/types.ts:185-191`、local `spawn.ts:617-620`）。
- **传播结论**：observer rejection 本身不会成为未处理拒绝。foreground `settleForegroundRun()` 用 `Promise.allSettled` 收集并抛给 tool；background `settleRun()` 转成 failed JobOutcome；直接 caller 收到 `dispose()` rejection。问题是“永不 resolve”时这些调用方也永远等不到 rejection。
- **最小修法**：给 `waitForExit` 传由配置界定的 AbortSignal；返回 `false` 时显式 throw “quiescence unproven”。deadline 至少覆盖 terminate 的 SIGTERM→SIGKILL grace。

### F3 [P2][源码机制] `limit:0 = all` 在 tool、web、client 三层都反转成默认 12

- pool 本身是正确的：显式 `{limit:0}` 在 `lib/accounts.js:241-245` 变成 unlimited。
- tool 却只在 `limit>0` 时传字段（`lib/live.js:1421-1428`）；web 把 0 规范化成 undefined 后省略（`lib/web.js:89-99`）；client “显示全部”又调用 `load(undefined,false)`，连 `limit=0` query 都不发（`lib/client.js:281-290`）。三条路径最终均触发 pool 默认 12。
- 同类检查：`amp_runs` 用 `limit===0 ? ordered : slice`，正确；负数/NaN 回默认值，没有发现另一处把它们反成 all。
- **严重级**：P2。只读列表/刷新不完整，不破坏数据，但工具文档和按钮明确承诺 all。
- **最小修法**：tool 始终传 `{limit}`；web 保留显式 0、仅非法/负数回 12，并始终传字段；client 按钮调用 `load(0,false)`。三层各加 13+ refs 的边界测试。

### F4 [P2][变异] `AMP-R10` 不是判别测试

完整套件在 R10 目标实现改回 `void` 后仍 151/151 绿，与 CHANGELOG 的“会红”相反。当前断言只验证所有 disposer 最终在 1s 内结束，以及 child 最终 terminated；它没有构造一个可控 settlement gate，也没有比较 disposer resolve 与 gate release 的先后。

**最小修法**：让 `waitForExit` 等待一个手动 promise；先启动唯一目标 disposer，短暂 race 必须仍 pending；再 release gate，disposer 才应 resolve。不要把所有无关 effect disposer 一起 `Promise.all`。

### F5 [P2][边界] 空 prompt 会启动无意义的远端 run

`SubagentStartRequest.prompt` 的类型允许空数组；tool schema 的 string 也无 `minLength`。provider 对 `[]`、`[{type:'text',text:''}]` 或可迭代异常形状得到空字符串，却没有在选号前拒绝，随后 claim、spawn、`noteDispatch`，等 Amp 返回 “No valid messages” 才释放。非 iterable 的 null/undefined 会在 `for...of` 处于选号前抛出，不泄漏。

**最小修法**：`blocksToText` 后在选号前拒绝 `prompt.trim()===''`（如需保留纯空白语义则只拒绝 `prompt.length===0`），并测试 claim/spawn/noteDispatch 均为零。

### F6 [P2][诚实性] 完全缺失 settings 服务时 client 的恢复建议不成立

该 composition 本身运行正确：inject callback 不执行，provider/pool 使用 composition config，web 不伪造 `settingsError`，nested Remote 缺失使 client 只读。但 client 显示“重启 harness 后可用”；若 host 根本未挂 settings，重启不会改变事实。

**最小修法**：缺少 `remote.settings` 时只写“当前宿主未提供 settings 服务，因此只读”；只有已知 transient/remount 状态才建议重启。

### F7 [P2][测试缺口] 第 7 轮没有覆盖本轮三个可绕过边界

新增回归没有覆盖 live 结算步骤 throw 后 release、`limit:0` 的 13+ rows、空 prompt 无资源；因此完整 151/151 绿不能证明这些声明。应以 F1/F3/F5 的反例分别补回归。

## 4. 已确认无误清单

### one-shot `start()` 的 claim / listener / dispatch 枚举

| 路径 | claim | provider abort listener | `noteDispatch` |
|---|---|---|---|
| settings error、非文本 block、超字节、cwd 失败 | 尚未取得 | 尚未注册 | 不记，正确 |
| `request.prompt` 为 null/undefined/非 iterable | `for...of` 在选号前抛 | 未注册 | 不记；属越过 typed contract 的异常调用 |
| 空数组、空 text、string 等可迭代异常形状 | 会取得，并实际 spawn | result finally 摘除 | 会记；这是 F5，不是泄漏 |
| signal 已 abort | resolveExecutable 的 `throwIfAborted()` 抛 | outer catch 摘除 | 不记；claim 释放 |
| `resolveExecutable` 抛 | outer catch 释放 | outer catch 摘除 | 不记，正确；变异测试有效 |
| `spawn` 同步抛 | `attempt` finally 释放 | `settleRunResult` finally 摘除 | 不记，正确；返回已发布 handle，其 result 为 error，而非 reject start |
| `handle.done` / parse / collect 抛 | `attempt` finally 释放 | result finally 摘除 | spawn 已返回，故已记，正确 |
| `subprocessRunHandle` 构造抛 | outer catch 释放并摘 listener | 同左 | spawn 若已存在会缺 terminate；但当前 DSH helper 仅构造普通对象，除 OOM 外无可达 throw，未列缺陷 |

`noteDispatch` 自身异常被 best-effort catch，不改变 run；没有误记到 spawn 之前。常规成功时 `attempt` finally 只在 `handle.done` 和结果折叠后执行，不会在 Amp 命令仍跑时把账号交给下一次选择；随后 dispose 只负责 managed-range quiescence。live 的 `noteSuccess`/`noteRefusal` 与显式 release 可能双重 delete，但 pool release 幂等，无双重释放副作用。

### settings、run id、外围

- 注册失败时四路同时生效：provider 读 `settingsState.error`，live 读 `pool.settingsError`，web 下发该字段，client 禁止 write；`currentResolved` 的权威读取独立有效。
- 完全没有 settings 服务不会伪称“注册失败”，仍以 composition config 派发；只有 F6 的恢复文案误导。
- one-shot UUID 只作为 seam/lifecycle id 和工具结果；ledger 的 account dispatch、live artifact 的独立 run id/key 均不依赖其可读或可预测性。mode 前缀保留，现有测试仅断言前缀与唯一性，未被破坏。
- `cordis.patch.yml` 仅插入 host row/modes，agent tool 仍由 preset 负责，未发现 plane 重复注册；`package.json` 的 exports/client inject 与实际入口一致。

### 变异测试

隔离副本分别破坏：(1) one-shot 发布前 release、(2) `currentResolved` 改回 mirror、(3) UUID 固定、(4) web 删除 `settingsError`、(5) client 改回直接 nested Remote。每组相关套件均只有目标测试变红：provider 14 条中 13 pass/1 fail，web 11 条中 10 pass/1 fail。输出在 `/tmp/fixverify/{release,current,runid,web,client}.out`；这五条不是空壳。

第六组把 disposer join 改回 `void`，完整 **151/151 仍绿**（`/tmp/fixverify/r10.out`），确认 #65 的空壳。

## 5. 未能验证 / 需要下一轮（含验伪方法）

- 未以真实 OS 制造不可杀 managed range；F2 已由 DSH `waitForExit` 实现和永不 resolve handle 可构造证明。若要系统级验伪，可用 fake handle 的 `waitForExit=never` 断言 dispose 必须在配置 deadline 后 reject。
- 未启动真实 browser 做 F6 文案 UI 截图；这是静态可达分支。挂一个没有 `remote.settings` 的 client composition，打开账号页即可验伪“重启后可用”。
- 未实时调用付费 Amp 上游；所有结论均不依赖余额/远端响应。原树未改、未 deploy、未重启。
