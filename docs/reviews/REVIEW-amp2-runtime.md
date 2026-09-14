# REVIEW-amp2-runtime：live 大重构对抗性复核
> 评审员：独立评审员 runtime2（第 8 轮）；对象 revision：`live.js ebea32961479`、`artifact.js 8f3ec02d7d15`、`outcome.js 82bbd05cc37c`；dsh 源码 revision `c291e79`
> 方法：逐行对照插件源码、测试、DSH `jobs-local`/`tool-jobs`/agent-loop 真源与已安装编译产物；对抗实验和变异均在 `/tmp/runtime2/` 副本执行。

## 1. 结论

第 7 轮 live 重构尚未闭环：最终判决为 **0 P0 / 3 P1 / 3 P2**。
三个 P1 分别是 ref 级 claim 无法表达并发 run 所有权、未证明 quiescence 却报告 `alive:false`，以及结算早期异常绕过 claim/artifact 清理。
与 fixverify 报告重叠的是其 F1（结算异常泄漏 claim）和 F4（`AMP-R10` 空壳测试）；fixverify 认为 #53 的主声明已兑现，本报告则保留其 spawn 后异常清理不完整这一更窄的 P2 残余。fixverify 的 F2（one-shot `dispose()` 无 signal 可永久挂住）是独立 P1，本报告不重复计数。

## 2. 逐条验证第 7 轮修复

| 条目 | 是否真的修好 | 反例或证据 | 判决 |
|---|---|---|---|
| 执行资源移入 `jobs.start({run})` | 部分 | preflight 前确实无执行资源；但 `run()` 在 spawn 后抛错时只发 `terminate()`，不等停稳，并可能遗留已打开 artifact | P2 |
| 显式 `release()` | 否 | claim 只有账号 ref，没有 run/token 所有权；同账号 fail-open 并发时任一 run 的 `noteSuccess`/`noteRefusal`/`refresh`/`finish` 都会删除共享 ref 的当前 claim | P1 |
| `resultReceived` / `finished` 分离 | 部分 | result-before-exit 已修；但 sweeper 结算且 quiescence 未证明后，`status=finished, alive=false` 仍把未知进程状态说成已死 | P1 |
| `finish()` 全路径释放/finalize | 否 | `absorb()` 等在 release/finalize 前抛错会直接进入 catch，finally 只标 finished/markSettled，claim 与 artifact 都漏清理 | P1 |
| `AMP-R1` / `R1b` / `R3` / `C2` / 通知预算回归 | 是（所做变异范围） | 五条定向变异均使对应测试变红 | 通过 |
| `AMP-R10` disposer join 回归 | 否（测试） | 把 `await Promise.allSettled(settling)` 再次改成 `void`，`AMP-R10` 仍然通过 | P2 |
| artifact key / `epochOf` / `limit:1` | 部分 | 旧、新 key 的纪元均能解析；不同纪元正确。但同毫秒混合 key 只按字典序打破平局，可把更旧记录当 newest | P2 |

## 3. 新发现

### [P2][变异实证] `AMP-R10` 仍不能判别 disposer 是否 join settlement

- 插件侧：`lib/live.js:219-234`；测试侧：`test/live.test.mjs:1066-1082`。
- DSH 侧依据：`packages/jobs/jobs-local/src/index.ts:459-470,481-499` 的 owner/service teardown 都 await producer settlement；`JobHooks.done` 在 `packages/jobs/jobs/src/types.ts:79-84` 定义为资源释放后的完成。
- 为什么错：测试把所有 disposer 的返回包装进 `Promise.all(...).then('joined')`，但只断言它在 1s 前 resolve；错误实现立即 resolve 同样满足。随后检查 `terminated`（在 `finish()` 首个 await 前已同步置 true），再单独 await `jobs.hooks.done`，也无法证明 disposer 自己等待了它。
- 变异：`/tmp/runtime2/m-r10/lib/live.js` 将 `await Promise.allSettled(settling)` 改回 `void Promise.allSettled(settling)`；定向执行 `node --test --test-name-pattern='AMP-R10:' test/live.test.mjs` 仍 **1/1 pass**（约 1.07s），见 `/tmp/runtime2/m-r10/result.log`。因此 `CHANGELOG.md:27,31` 的“改成 void 会红 / 新测试不是空壳”和 `REVIEW-LOG.md:80` 的“已修测试”均强于事实。
- 最小修法：让 `waitBehavior` 暴露手动 resolver；调用 disposer 后先竞速一个短 microtask/10ms，断言 disposer **仍 pending**，再 resolve wait，最后断言 disposer 与 `jobs.hooks.done` 都完成。不要用宽达 1s 的“能完成”断言替代“不会提前完成”。

### 变异测试汇总

| 测试 | 变异 | 结果 | 判别性 |
|---|---|---|---|
| `AMP-R1` | `resultReceived` 状态重新显示 `finished` | 红：期望 `result received`，实际 `finished` | 有效（读面不撒谎这一半） |
| `AMP-R1b` | 删除重入分支的 `killedByCancel=true` | 红：`error !== aborted` | 有效 |
| `AMP-R3` | 分类输入移除 `systemError` | 红：诊断缺 `failure=rate-limit` | 有效 |
| `AMP-C2` | 删除 unpublished `finally releaseClaim()` | 红：期望 `['A']`，实际 `[]` | 有效 |
| 通知预算 | 超预算分支丢弃而非 `inject` | 红：期望 2 次 inject，实际 0 | 有效 |
| `AMP-R10` | `await Promise.allSettled` → `void` | **绿：1/1 pass** | **无效** |

以上均在 `/tmp/runtime2/m-*` 独立副本定向运行；没有把模块加载失败或超时算作“红”。

### [P2][对抗实证] `run()` spawn 后抛错只请求终止，既不证明停稳也不关闭已打开 artifact

- 插件侧：`lib/live.js:857-864,867-878,931-964,977-1000,1097-1108,1112-1124,1164-1170`；`lib/artifact.js:190-225,294-336`。
- DSH 侧依据：`packages/jobs/jobs/src/types.ts:42-68` 原文要求 starter 抛错时“producer must clean up any partially started resources”；`packages/jobs/jobs-local/src/index.ts:150-189` 直接调用 `spec.run()`，只有它返回 hooks 后才建 id/store/`hooks.done` 观察者。`run()` 抛错时不会注册 job，也不会替 producer cancel/await/close。
- 为什么错：spawn 后的 catch 只调 `handle.terminate()` 与 `sessions.delete(runId)`，没有 `waitForExit()`，也没有 `artifacts.close/finalize()`。外层因 `runInvoked=true` 原样重抛，`finally` 只释放 claim。故调用者收到拒绝时进程可能仍活着，却已无 job、无 session、无后续停稳者；若 `artifacts.open()` 已成功而后续 append/checkpoint/接线抛错，fd 与未完成目录也遗留，`markSettled` 永远不会调用（但 jobs 从未接到该 promise，job 注册状态是“根本不存在”，不是 running）。
- 复现：在 `/tmp/runtime2/lib/artifact.js` 仅对首次 prompt append 注入同步 throw（发生在 spawn、`sessions.set`、settled promise、artifact open 之后），`/tmp/runtime2/test/live.test.mjs` 对抗用例通过并观测：`spawns=1`、`terminated=true`、`waitCalls=0`、`jobs.hooks===undefined`、claim 已 release、`amp_runs` 新增一条 `checkpoint=missing/interrupted=true` 的遗留目录。该文件 **52/52 pass**，日志 `/tmp/runtime2/run-throw.log`。
- 分级清算：`JobStart.run()` 的原文明确要求 producer 自行清理部分启动资源，所以 artifact fd/目录无人收尾是已证实的契约违反；但 subprocess 契约把 `terminate()` 定义为启动受管范围终止流程，`waitForExit(signal?)` 只是另一个可选有界等待接口，并未要求 `run()` 抛错前同步证明 quiescence。该路径还只在 spawn 后的初始化异常触发，故最终降为 **P2**，不按 P1 计数。
- 最小修法：在 outer async `execute` 的 `runInvoked` error 分支对已建 session 走一个“不依赖 job 的失败结算/关闭”并 await 停稳；或把所有可能 throw 的 artifact 初始化放在 spawn 前、让 spawn 后路径只做不可抛赋值，并在 spawn throw 时关闭预建 artifact。仅 `terminate()` 不满足 cleanup 契约。

### [P1][对抗实证] sweeper 未证明 quiescence 后仍报告 `alive:false`

- 插件侧：`lib/live.js:563-571,613-649,723-733,1256-1282,1581-1613`。
- DSH 侧依据：`packages/subprocess/subprocess/src/types.ts:185-191`（上一轮已引用）规定 `waitForExit()` 只有证明受管范围为空才返回 true；失败/false 意味着不能断言已停稳。插件自己的 terminal notice 也在 `lib/live.js:1059,1073-1075` 明说 orphan “may still be alive”。
- 为什么错：`alive` 被定义为 `finished !== true && exited !== true`。sweeper 调 `finish(false)`，两次 `waitForExit()` 都 false 时正确置 `quiescenceUnproven=true`，但 finally 又置 `finished=true`；session 会保留一个 idle window，因此 `amp_send_message` 可读到 `status='finished', alive=false`。这里 `finished` 只证明插件结算完成，不证明进程死亡，故把二者再次混用。
- 复现：`/tmp/runtime2/test/live.test.mjs` 将 idle timeout 设 1ms、`waitForExit()` 恒 false，手动触发 sweep；job detail 正确含 `quiescence=unproven`，随后 `amp_send_message(wait_ms:0)` 却返回 `alive:false`，对抗断言失败。日志 `/tmp/runtime2/adversarial-live.log`。
- 最小修法：`alive` 改成三态（`true | false | null/unknown`）：只有 `session.exited===true` 或 `waitForExit===true` 时 false；`quiescenceUnproven` 时 unknown，并在同一响应带明确 hint。不要从 settlement 的 `finished` 推导进程 liveness。

### [P1][对抗实证] `finish()` 的显式 release/finalize 不在 finally，早期结算错误会同时泄漏 claim 与 artifact fd

- 插件侧：`lib/live.js:613-649,650-697,698-718,719-734`；`lib/artifact.js:294-336`。
- DSH 侧依据：`packages/jobs/jobs/src/types.ts:79-84` 要求 `done` 在 producer 释放资源后才 resolve。当前 `markSettled()` 虽在 finally，但 producer 的 claim 与 artifact handle 可能尚未释放。
- 为什么错：`absorb()`/`flushPending()`/分类之前都可能抛；release 在 `try` 的后半段，artifact finalize 更晚。任一早期错误直接跳到 catch，再执行 finally 的 `finished=true`、outcome、`markSettled()`。于是 jobs 得到 terminal `failed`，却把仍持有 claim 和打开 fd 的 producer 当成已经释放。
- 复现：`/tmp/runtime2/test/live.test.mjs` 在已发布 run 的 stdout reader 注入 throw 后调用 `amp_stop`。job/stop 均正常返回 failed/error，但 pool 的 release 调用数组仍为 `[]`；磁盘 checkpoint 仍是起始态（`status:null`、无 `finished`），见 `/tmp/runtime2/home/state/dsh-amp/runs/.../checkpoint.json`。定向日志 `/tmp/runtime2/settlement-failure.log`。
- 最小修法：将 claim release 与 artifact finalize/close 放入独立、各自 contained 的 finally 清理段；即使 final absorb 失败也必须尝试 finalize（checkpoint 应含 `settleError`/`finished:true`），最后才 `markSettled()`。若 finalize 也失败，至少显式 `close()` fd 并把两种错误都保留。

### [P1][源码确认] ref 级 `release()` 会释放另一个仍在运行的 run 的 claim

- 插件侧：`lib/accounts.js:208-226,294-318,551-555,562-563,585-586,625-626`；`lib/live.js:665-695`。
- DSH 侧依据：`packages/jobs/jobs-local/src/index.ts:321-327` 按 exact owner 统计并发 job，允许同 owner 多个 job；`packages/jobs/jobs/src/types.ts:42-68` 规定每次 `run()` 各自拥有执行资源。DSH 不会把同账号的多个 producer 合并成一个生命周期。
- 为什么错：`inflight` 是 `Map<ref, expiry>`，第二个 run 在“全部账号均已 claim”的 fail-open 路径仍会选同一 ref，并覆盖该 ref 的 expiry。随后第一个 run 的 `noteSuccess`、`noteRefusal`、`refresh` 或 `finish()` 任一路径调用 `release(ref)`，都会删除第二个仍在跑的 run 的占用。第三个派发因此把该账号视为未占用，可能继续撞上来；第 7 轮新增的 `finish()` 显式释放扩大了触发面。
- 复现：`/tmp/runtime2/test/accounts.test.mjs` 新增真实 pool 对抗测试：仅一个可用 ref，前两次 `choose()` 的第二次正确带 `already-claimed`；模拟 run A 结束调用 `release('A')` 后，第三次实际返回 `state='ledger'`，没有 `already-claimed`，尽管 run B 仍活动。`bash test/run.sh` 得 **152 tests / 151 pass / 1 fail**，失败正是该断言；日志：`/tmp/runtime2/baseline-with-adversarial.log`。
- 最小修法：让 `choose()` 返回不可伪造的 claim token（或 run-scoped lease id），`release(ref, token)` 只删除仍由该 token 持有的 lease；若要支持同 ref 多个并发 run，则按 ref 维护 token 集合/计数，而不是单个 expiry。`noteSuccess`、`noteRefusal`、`refresh` 不应顺手释放不属于自己的 lease。

### [P2][对抗实证] `epochOf` 修了后缀解析，但同毫秒混合目录的 `limit:1` 仍不保证 newest

- 插件侧：`lib/live.js:946-953,1498-1519,1529-1573`；`lib/artifact.js:163-175`。
- DSH 侧依据：无额外宿主契约；这是插件 `amp_runs` 自己在 `lib/live.js:1484-1490` 声明的“newest first”接口。
- 为什么错：正则 `/(?:^|-)(\d{13})(?:-|$)/` 对历史 `dsh-amp-run-N-<epoch>` 与新 `...-<epoch>-<pid>-<uuid>` 都会取到 epoch，且真实磁盘旧目录均符合 13 位形状；不同 epoch 排序正确。但两个 host 可在同一毫秒开 run，比较器返回 0，稳定 sort 继承 `artifacts.list()` 的字典序，最终 `slice(-1)` 选字典序最大者，而不是实际较晚创建者。pid/uuid 保证唯一，不提供时间平局顺序。
- 复现：`/tmp/runtime2/test/live.test.mjs` 先创建 legacy `dsh-amp-run-9-1700000000000`，5ms 后创建新 key `dsh-amp-run-1-1700000000000-222-aaaaaaaa`；`amp_runs(limit:1)` 实际返回较旧 legacy key。定向测试 0/1，日志 `/tmp/runtime2/artifact-order.log`。
- `runId` 自洽性：checkpoint 内 `runId=session.id`（可用于 `amp_stop` 的短 handle），目录名/`amp_runs.runs[].runId` 却是 artifact key（长 key）。二者当前有意不同但同名字段易误解；A5 只锁 checkpoint 的短 id。建议 `amp_runs` 返回 `artifactKey:id`，并把 `runId` 取自 checkpoint（缺失时再 fallback），避免新 key 形状扩大歧义。
- 最小修法：排序键用 checkpoint `startedAt`，平局再用目录 `mtimeMs`（store list 可返回 stat）与 key 作最后确定性 tie-break；或者 key 加每进程单调序号且跨 host 仍以 mtime/checkpoint 排同毫秒。文档将 `<runId-epoch>` 更新为真实 `<runId-epoch-pid-uuid>`。

## 4. 已确认无误清单

- `AMP-R1` 有判别力：把 `resultReceived` 再次冒充 `finished` 会使 result-before-exit 回归变红。
- `AMP-R1b` 有判别力：删除结算重入时的 `killedByCancel=true` 会使后到 kill 的终态断言变红。
- `AMP-R3` 有判别力：从 live 分类输入移除 `systemError` 会丢失 `failure=rate-limit` 并使测试变红。
- `AMP-C2` 有判别力：删除未发布路径的 `finally releaseClaim()` 会使 claim 回收断言变红。
- 通知预算回归有判别力：把超预算通知从 `inject` 改为丢弃会使“不丢通知”断言变红。
- 宿主 `agent/inbox/claimed` 的 `payload.agent` 与 `exec.agent` 是同一对象：`ReactLoopAgent` 以 `this` 构造 `agentEvents(loopCtx, this)`，同一 dispatcher 交给 inbox；dispatcher 再把该闭包中的原对象注入 claimed payload，因此 `spentWakes` 的 `WeakMap` key 能正确命中。

## 5. 未能验证 / 需要下一轮

- 尚未动态穷举 **idle sweeper 的 `finish(false)`、live 宿主 disposer 的 `finish(true)`、jobs owner/service teardown 的 `cancel()` → `finish(true)`** 三者交错。源码上 `settlePromise` 应让后两者 join 同一结算，`session.settling` 应阻止后续 sweep；但 Cordis effect 销毁顺序、同 tick 竞争，以及 `terminate()` 同步回调造成的重入窗口没有在真实宿主 teardown 中验过。
- 下一轮验伪应给 fake handle 加手动 `waitForExit` barrier，分别构造 sweeper-first、live-disposer-first、jobs-cancel-first，并在 barrier 未释放时断言两个 teardown 都仍 pending；释放后断言只发生一次 finalize、一次 claim release、一次 `markSettled`，所有 disposer/job await 都结束，且后到 kill 会把结果定为 killed。再让 `terminate()` 同步触发一次 cancel，专门攻击 `settlePromise` 赋值前的重入窗口；出现双结算、双 close、提前 resolve 或永久 pending 任一项即证伪。
- 未用真实 OS managed range 和完整 Cordis 宿主关闭流程复现上述时序，也未实时调用付费 Amp 上游；现有结论来自源码契约、fake-handle 对抗实验及隔离变异。
