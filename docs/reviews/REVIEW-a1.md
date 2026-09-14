# A1 代码审查：live run 注册为 DSH 后台作业

审查对象：`lib/live.js`（A1 接入段）、`lib/artifact.js`、`lib/outcome.js`；对照契约 `dsh-jobs/lib/types/types.d.ts`、实现 `dsh-jobs-local/lib/index.js`、`dsh-tool-jobs/README.md`；既有评审 `REVIEW-design.md` §2.2/2.3/2.4。测试基线 `bash test/run.sh` 59 条全过（本次未重跑，见 §8 建议补的用例）。

---

## 1. `done` 是否可能永不 resolve？

**已确认——两个真实缺口：**

- **缺口 ①（结构性）：`markSettled()` 不在 `finally` 里**（`lib/live.js:435`，settlement body 从 `lib/live.js:358` 起整个是 `(async () => { … })()`）。`waitForExit` 有 `try/catch` 兜底（:387-404），但 catch 之后的 `absorb`（:406）、`flushPending`（:407）、`classifyAmpError`（:405-412 上方的 errorText 计算）、`artifacts.finalize`（:421-428）**没有 try 保护**。`absorb` 内部经 `readNew`→`reader.readFrom` 和 `foldMessages`，一旦抛出（spill 窗口边界、畸形 reader 状态），`settlePromise` 直接 reject：`markSettled` 不会执行 → `session.settled` 永不 resolve → `done`（:643）永不 settle → job 永久占 `running/stopping` 名额，且 `disposeOwned` 里 `await Promise.all(owned.map(j => j.settled))`（jobs-local `index.js:407-411`）**永久挂起 owner dispose**。后患：`onExit` 里 `void finish(session, false)`（:620）变成 unhandled rejection；重入 finish 因 `settlePromise !== undefined` 只返回同一个 rejected promise，无法自愈。
- **缺口 ②（组合条件）：`timer` 缺失 + 子进程永不退出 + 无人 stop/kill**。finish 的四个触发源里，sweeper 挂在 `timer.interval`（:963-986），`timer === undefined` 时整段不注册；`handle.done` 观察器（:614-620）只在子进程退出时触发。三者同时缺席 → 没有任何东西调 finish → `done` 永久 pending。timer 在标准组合下由 `cordis-plugin-timer` 提供，所以是防御性缺口，但契约明说"done 必须最终 settle"。

**已排除的候选**：`amp_stop` 先删 session（:900）不影响——`done` 在 `await finish` 返回前已注册，settle 时序见 §6；宿主 `teardownAll`（:189-199）只 terminate+clear 不调 finish，但 terminate 会让 `handle.done` fire → onExit → finish，仍会 settle（前提是 `terminate()` 真能杀死进程；若 handle.done 在 terminate 后不 resolve 则同样挂，标疑似）；`jobs.start()` 之后代码段只剩构造返回 JSON（:706-726），即使抛错 job 照常注册、自然退出路径照常 settle，不会永久 running。

**最小修法**：把 settlement body 中 `absorb` 之后、`markSettled()` 之前的所有语句包进 `try { … } catch (e) { session.failure ??= { kind: 'other' }; session.exitError ??= sanitize(String(e)) }`，并把 `markSettled()`（连带 `session.finished = true`、`settling = false`）挪进 `finally`。缺口 ② 顺手修法：`run()` 返回的 hooks 里再挂一个 `setTimeout` 式最长寿命保险（或要求 timer 必须存在时 fail loud），非必须。

## 2. `readOutput` 与平台契约一致性

**已确认：不是契约违背——用户前提有偏差。** 平台契约（`dsh-jobs/lib/types/types.d.ts`）对 `readOutput` 的定义是 "Consume output produced since the previous call… each job has one consuming cursor"；`JobRead.text` 对 **stream kinds** 明确只承诺 "the consuming delta since the previous read"；"settlement 之后返回幂等的最终输出" 只适用于 **final-output kinds（不提供 `readOutput` 的 job）**，其载体是 `JobOutcome.output`（"Final output for jobs **without** readOutput; stream jobs leave it unset"）。当前实现（:678-688）推进 `deliveryOffset` 的增量读，正是 stream job 的正确形态；`done` 不带 `output` 也正确。

**已确认的真实行为**：结算后第一次 `job_output` 返回**上次读以来的剩余尾部**（非空、非幂等），再读得空串。契约允许，但 Completion notice 固定文案是 "Read its output with job_output"（tool-jobs README:40），而被唤醒的委派方多半**没在运行中读过**——那它会一次拿到全部尾部，行为可接受；若它运行中用过 `job_output`，醒来只拿增量，再读一次拿空。**建议（体验非契约）**：在 `done` 的 detail 里附 `lastText` 尾部 200 字（§7），就把"最终输出摘要"带进通知本身，零游标消费，符合设计评审 §2.4 第 5 点（通知不读 stdout、不推游标）。

**疑似（小）**：`outputLimitBytes: DELIVERY_MAX_CHARS`（:700）把**字符数**当**字节数**传——契约按 UTF-8 字节截断，中文输出会被平台更早截断（保守方向，无害但名不副实），改为 `Buffer.byteLength` 口径或改名注释即可。

## 3. 偏离评估：spawn 先于 `jobs.start()`

**已确认窗口极小，但偏离真实存在且有副作用**。`spawn`（:529）到 `jobs.start`（:694）之间全是同步代码（stdin.write :570、artifacts.open :581、saveCheckpoint、noteDispatch :597、exit 接线），宿主 tick 内墙钟 < 数 ms。`jobs.start` 的准入（servesOwner、每 owner 上限 10，jobs-local `index.js:131-150`）同步拒绝后立刻 `terminate()`（:680）——而 Amp CLI 冷启动 ~10s，子进程出生 <10ms 就收到 SIGTERM，**来不及发起任何模型请求或消耗额度**。"写入过字节" 成立（prompt 已写进 stdin），但那只是 pipe buffer。"发起过请求/消耗额度" 在正常路径下不可能。

**已确认的两个实际残留**（偏离的代价，与进程安全无关）：
1. **孤儿 artifact 目录**：`artifacts.open`（:581）+ append + checkpoint（:587-591）在拒绝前已执行，拒绝路径（:677-690）不 finalize、不清目录——磁盘留下只有 manifest/prompt 的半成品 run 目录。
2. **账本虚记 dispatch**：`noteDispatch`（:597）已记，拒绝后既无 finish 也无 noteRefusal，该账号的在途计数虚高直到自有窗口过期。

**结论**：进程/额度风险 ≈ 0，不值得为它做"spawn 搬进 run()"的大段重排；但设计评审 §2.1 的原文要求（"必须在 spawn 前调用 `jobs.start()`"）没有满足，且上述两个残留是真实缺陷。**可执行建议**：保留结构，在拒绝分支补三行——`try { artifacts.finalize-ish 清理或至少记录 }`、`noteRefusal` 或 ledger 释放、以及把错误文案里 "before it could do work" 改成 "before it could do work beyond receiving the prompt"（当前措辞过强）。若后续做重构，再按评审建议把 spawn 挪进 `run()`。

## 4. 状态映射 killed/failed/completed

**已确认一处不诚实：外部 SIGKILL 会被报成 `completed`。** 失败判据（:646-649）：`result.is_error || failure !== undefined || (exitCode !== undefined && exitCode !== null && exitCode !== 0)`。SIGKILL 的 `outcome.exitCode === null`、无 result、`handle.done` 是 resolve 而非 reject（故无 `exitError`）→ 三条全不中 → `completed`。同病：`outcome === undefined` 时 `exitCode === undefined` 也漏网。**正确语义**：`exited === true` 且没有干净的 0 退出/成功 result，就不得是 `completed`。最小修法：判据改成 `exited === true && !(exitCode === 0 && result?.is_error === false && failure === undefined) ? failed : …`（即把"成功"改成白名单，而不是给"失败"列黑名单）。

**已确认的次级不诚实**：`cancelRequested` 一旦置位就是 `killed`（:644-645），即使 run 在 cancel 之前已自然完成（cancel 落在 settle 后，`finish` first-wins 返回既有 settlePromise，但映射重看 `cancelRequested`）。这正是设计评审 §2.5 批评的"terminal 原因由最后一个 API 参数推断"。最小修法：`cancelRequested` 只在 `session.finished !== true` 时才参与映射（或引入 `terminalCause` 记录谁先到）。

**已确认正确的部分**：`result.is_error` 与已分类 `failure` 两条真实；`failure` 由 `classifyAmpError` 兜底为 `other`（outcome.js:19-33），所以"有任何 error prose → failed"成立，包括非零退出伴随 stderr 文本的路径。与设计评审 §3.2.4 的映射表（completed→completed、teardown kill→killed、refused/partial→failed+detail）方向一致，缺的只是上面两条。

## 5. owner 与围栏

**已确认 `owner: exec.agent` 正确。** 契约要求 "must be the one currently registered under its agent id"（types.d.ts `JobStart.owner`）；`ensureOwnerCleanup` 硬校验 `agents.get(owner.id) !== owner` 即抛（jobs-local `index.js:423-428`），所以若 `exec.agent` 不是注册实例，`jobs.start` 当场失败、走拒绝分支，不会产生错主 job。amp_run 入口已拒 `exec.agent === undefined`（:476），不会造出 unowned job（那才是任何 caller 可见的开放围栏）。

**已确认两套围栏语义一致，未发现分歧**。平台围栏：`assertAccess` 比较 `job.owner.id !== caller?.id`（jobs-local `index.js:311-316`），no-agent caller 永不匹配 owned job；插件围栏 `requireSession`（:325-349）比较 `session.owner !== String(caller.id)` 且对 no-agent fail closed。"平台允许但插件拒绝" 需要 caller.id 匹配而插件另设条件——没有；"插件允许但平台拒绝" 同理不存在。唯一粒度差异：平台在 **start 时** 还要求 Agent 对象身份，插件全程只看 id——这只影响注册成败，不影响存续期的读/停权限。**已确认一致**：`amp_stop` 删 session 后 job 仍只属于同一 owner，无第二套 owner。

## 6. 与 `amp_stop` 的竞争

**已确认：`done.detail` 的 `artifact=` 一定指向已 finalize 的路径。** 顺序链：`artifacts.finalize`（:421-428，`finalized.ok` 时写 `session.artifactPath`）→ `session.finished`/`closedAt` → `session.settling = false` → `markSettled()`（:435）→ `settled` resolve → `done.then` 构造 detail（:643-653，此刻读 `session.artifactPath`，已赋值且无人清空）。`amp_stop`（:858 `await finish` → :900 `sessions.delete`）删除的是 map 条目，不动 session 对象字段；`readOutput` 闭包经 `session.handle.collected.stdout` 读，同样不受 map 删除影响。时序上 `done.then` 在 amp_run 时注册，先于 amp_stop 的 await 续体入队，不存在"删完才读"的竞争。

**已确认两个残留体验问题**：① finalize 失败时 `artifactPath` 为 undefined，detail 直接省略 `artifact=` 也**不提 `artifactError`**——被唤醒方拿到的是无 artifact 线索的失败通知；建议 detail 加 `session.artifactError` 一项。② 设计评审 §2.3 要求的"重复 amp_stop 返回同一 terminal snapshot，而非 `unknown run`"未实现（:900 照删，二次 stop 报 unknown run，而 job 还在）；这是 A1 范围外的既有行为，但 job 记录存活使其更显眼。

## 7. 可观测/体验

**已确认现状够用但不完整**。label（:696）`mode: prompt 前 80 字`——定位多 run 足够；detail（:649-652 实际在 :649-653 区段，`run/mode/account/thread/failure/artifact`）有身份、有归属、有 artifact，被唤醒方知道该读哪。**建议补三样（都可执行，改 :643-653 的 detail 数组即可）**：
1. **`lastText` 尾部 ~200 字**——委派方醒来最想要"它最后说了什么"，现在必须再花一次 `job_output` 往返；`session.lastText` 已有现成字段（checkpoint 用了 2000 字版，:309）。
2. **`exitCode=`**——amp_stop 的 diagnostic 有（:885 附近），job detail 没有；SIGKILL 误报 completed 的场合（§4）这是唯一线索。
3. **重试建议**——`failure=` 只给 kind；`describeFailure(kind, retryAfterMs)`（outcome.js:49-66）已经产出生动文案（含 `retryAfter=N s`），detail 里换成或拼上它，失败类别与"下一步"一次到位。`artifactError`（见 §6）顺手带上。

不建议把失败全文塞进 detail（`outputLimitBytes` 会截，且 artifact 才是真源）；不建议在通知里内联 stdout（设计评审 §2.4.5 明令通知不读 stdout）。

## 8. 测试缺口（最小清单）

现有 7 条 A1 测试（live.test.mjs:288,302,318,366,376,383,391）覆盖了注册/双游标/正常 settle/kill/拒绝/无 jobs 服务/非零退出。应补：

1. `A1: a throwing settlement body still resolves done`——mock `artifacts.finalize`（或 absorb 的 reader）抛错，断言 `done` settle 为 failed 且非 pending（对应 §1 缺口①，修复前应红）。
2. `A1: a SIGKILLed child (exitCode null, no result) settles as failed, not completed`——handle.done resolve `{exitCode: null}`，断言 status（对应 §4，修复前应红）。
3. `A1: a cancel arriving after natural completion does not flip completed to killed`——先自然退出，再 `cancel()`，断言 status 仍 `completed`（对应 §4 次级）。
4. `A1: readOutput after settlement returns the remaining tail once, then empty`——固定当前流式语义，防将来向"幂等终稿"漂移时无人察觉。
5. `A1: a refused job slot leaves no orphan artifact dispatch`——拒绝分支断言 artifact 目录清理/标记与 ledger 未虚记（对应 §3 两个残留）。
6. `A1: idle-sweeper settlement resolves the job's done`——不显式 stop，推进时钟触发 sweep，断言 `done` settle（覆盖 §1 的 finish 触发源之一）。
7. `A1: completion detail names failure kind and retry advice`（对应 §7，若采纳建议 3）。

## 结论摘要

最关键三条：① `markSettled()` 不在 finally——settlement body 中 absorb/finalize 一旦抛错，`done` 永不 settle，job 永久占名额且 owner dispose 永久挂起（`lib/live.js:406-435`），最小修法是 try/finally 包 settlement body；② 状态映射把 SIGKILL（exitCode null、无 result）报成 `completed`（:646-649），应把"completed"改为白名单判据；③ spawn 先于 `jobs.start()` 的偏离在进程/额度上风险≈0（拒绝时子进程存活 <10ms），但留下孤儿 artifact 目录与虚记 dispatch（:581,:597），拒绝分支补清理即可，暂不必重排 spawn。

**A1 能不能算接对了**：能——owner、双游标、cancel 幂等、artifact finalize 先于 settle、围栏一致这些契约主干都接对了，且比"无唤醒"的旧世界质变；但 ①② 是必须在生产信任它之前修掉的两个洞，修完才算"接对且诚实"。
