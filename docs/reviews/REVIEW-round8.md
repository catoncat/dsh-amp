# dsh-amp round 8 定向验收

范围：只复核 `REVIEW-round7.md` §5 的 1 个高危与 4 个中危，以及本轮声称连带修复的相关路径。评审期间 `lib/live.js`、`lib/artifact.js` 及测试被多次并发更新；以下已逐次重读，以最后一次测试所用快照为准。

## 1. 高危：job admission 是否真的前置并闭环

### 已确认

- **原高危只消除了一半，不能判定“真的消除”。** `jobs.start()` 已在首次 `stdin.write()` 之前（`lib/live.js:959-998`）；拒绝分支先 `await finish(session, true)` 再抛错（`lib/live.js:969-988`）。因此在 jobs 服务存在且 `start()` 同步拒绝时，prompt 确实未投递。
- 拒绝分支使用已完整构造的 `session.handle`、`session.settled` 和 artifact（`lib/live.js:739-830`），`finish()` 对重复进入用同一个 `settlePromise`（`lib/live.js:525-535`），这部分安全。它会 terminate、最多两次有界 `waitForExit`、final read，并以 `finished: true` finalize checkpoint（`lib/live.js:537-641`）；随后才 resolve `settled`（`lib/live.js:646-657`）。
- artifact 不会因提前 `sessions.delete(runId)` 被漏结算：删除发生在 `await finish` 前（`lib/live.js:969-976`），而 `finish` 直接持有 session。`amp_runs` 只根据 checkpoint 的 `finished` 判断 `interrupted`（`lib/live.js:1360-1369`），所以 finalize 成功时不会留下 `interrupted`。
- spawn 后立即退出不会把已注册 job 永久留在 pending：`handle.done` 的回调进入 `finish()`（`lib/live.js:838-853`），job 的 `done` 绑定 `session.settled`（`lib/live.js:880-943`）；初始 prompt 同步写入若抛错，也会 `await finish`，最终释放该 job（`lib/live.js:996-1002`）。

- 停稳文案已在并发更新后修正：`finish()` 两次有界等待仍得不到 `true` 时设置 `quiescenceUnproven`（`lib/live.js:548-584`），拒绝错误随后明确说 process range “could NOT be confirmed empty”，只有证明静止才说 stopped（`lib/live.js:977-988`）。这一项现在诚实，但“已停稳”仍是条件结果，不是所有拒绝路径都能达到的事实。
- 无 jobs 服务现在会在 spawn 前 fail closed（`lib/live.js:728-738`），prompt 和进程都不应出现；对应行为测试在 `test/live.test.mjs:394-403`。因此这个绕过已消除。

### 疑似

- **高危（事实已确认）：真正 admission 仍发生在 `spawn` 之后。** 代码只在 spawn 前检查 jobs 方法存在，随后立即 spawn（`lib/live.js:728-749`），而 owner/controller/并发上限的真实 preflight 在 `jobs.start()` 内（`deepseek-harness/packages/jobs/jobs-local/src/index.ts:131-150`），插件到 `lib/live.js:959-968` 才调用它。DSH 合同明定 preflight rejection “leaves no … execution resource”（`deepseek-harness/packages/jobs/jobs/src/index.ts:73-82`）；当前拒绝测试反而断言已 spawn 的 handle 被 terminate（`test/live.test.mjs:387-392`）。prompt 未投递已证实，但 child 确实已启动，原资源所有权高危仍在。
- 两处注释已经与运行时事实相反：拒绝分支先无条件写“STOPPED AND CONFIRMED STOPPED”，下文才承认 quiescence 可能未证明（`lib/live.js:970-984`）；delivery 注释又称无 jobs 时“proceeds untracked”，实际在 spawn 前拒绝（`lib/live.js:728-738,992-995`）。不改变执行结果，但会误导下轮维护。

## 2. `teardownAll` 是否安全

### 已确认

- **当前实现安全。** 并发更新后 `teardownAll` 已是 async，收集每个 `finish(session,true)` 并 `await Promise.allSettled`，且这个 async 函数本身就是 Cordis disposer（`lib/live.js:203-218`）。DSH scope 明确把 disposer 建模成 `Promise<void> | void` 并等待 fiber inertia（`deepseek-harness/packages/core/scope/src/index.ts:104-118`），其测试也验证 async disposer 不会提前完成（`deepseek-harness/packages/core/scope/tests/scope.spec.ts:55-71`）。因此 host 的 quiescent dispose 返回前会完成 terminate、有界 wait、final read、artifact finalize/close 与 session settlement（`lib/live.js:525-659`）。
- 重复结算幂等：`finish` 缓存并复用 `settlePromise`（`lib/live.js:525-535`），artifact `finalize` 也缓存首次结果（`lib/artifact.js:306-333`）。jobs cancel、host dispose、amp_stop 并发进入不会重复 finalize。
- host teardown 直接遍历自有 `sessions` 并 join `finish`，不依赖 jobs registry 的 teardown 顺序，也不再提前 `sessions.clear()`（`lib/live.js:203-218`）。

### 疑似

- 没有 teardown 正确性的剩余疑点；但当前 fake `ctx.effect` 丢弃 disposer 返回的 Promise（`test/live.test.mjs:104-115`），测试未证明 host 确实等到 artifact finalized。

## 3. 失败优先保留是否饿死成功 run

### 已确认

- **当前版本不会。** 并发更新后，finished failure 与 success 被分成两组，每组各自保留最新 `keepCount`，再按同一个 `keepDays` 地板保护（`lib/artifact.js:86-109`）。原反例——50 条一年前失败 + 1 条 8 天前成功、`keepCount=50`——现在成功记录进入 success 自己的预算并存活。
- 未分类失败也已补上：checkpoint 现在持久化单一 outcome 的 `status`（`lib/live.js:357-375,621-634`），`readRunRecord` 优先按 status 判失败，旧记录才回退到 `failure`（`lib/artifact.js:112-128`）；对应非零退出无分类器测试在 `test/live.test.mjs:849-860`。
- 当前新增测试直接覆盖失败超过预算而成功仍保留的反例（`test/artifact.test.mjs:297-319`）。原“失败优先”测试仍在（`test/artifact.test.mjs:270-291`），但在分组预算后它实际证明的是两组分别有保留位，不再证明一个共享预算里的优先级。

### 疑似

- 独立预算把最坏 count 保留量从约 `keepCount` 提高到约 `2 × keepCount`（另加窗口内记录及永不删的 unfinished）；这是明确的磁盘换救援策略。代码与使用文档均已写明 per-outcome 预算（`lib/artifact.js:45-54`；`docs/USABLE.md:25`）。
- checkpoint 中的 status 在 `finalize()` 前投影，运行时 outcome 在 finalize 后重算（`lib/live.js:621-655`）。因此极端的“checkpoint 写成功、随后 close 失败”会让磁盘仍记 preliminary status；代码注释已承认这条无法回写的持久化边界（`lib/live.js:626-628`）。这是中危边界，不是成功/失败互相饿死。

## 4. `retryable` / `resumable` 是否自洽

### 已确认

- 两个终态标签现在互斥：`retryable` 要求 `assistantMessages===0`，`resumable` 要求 `assistantMessages>0`；两者都要求 `quiescenceUnproven!==true`（`lib/live.js:906-918`）。`resumable` 还要求 failed、artifact path 存在且 durability complete，避免把成功或残缺记录叫作可恢复（`lib/live.js:914-918`）。
- quiescence unproven 时的终态 next 也已条件化为“先确认旧进程、不要启动新 run”；只有 quiescence 已证明才建议新开（`lib/live.js:932-938`）。因此终态动作建议现在与两个门槛一致。
- 回合结束 notice 的 `retryable=true` 是另一套较松逻辑：只要已有任意 failure 且 assistantMessages 为 0 就给出（`lib/live.js:388-402`），不调用 `isNoWorkFailure`。不过该状态明确是 `waiting`，下一步只建议 send/read 或 stop，并不建议新开 run，故它是命名不统一，不是与 quiescence 门槛相同的重复执行漏洞。

### 疑似

- killed 状态不会再携带 terminal `retryable=true`，该分支现在显式要求 `o.status==='failed'`（`lib/live.js:894-911`）。

## 5. 字节守卫及同类口径

### 已确认

- one-shot F9 的拒绝判断已真正按 UTF-8 bytes：`Buffer.byteLength(prompt, 'utf8')` 与 `STDIN_MAX_BYTES` 比较（`lib/index.js:80,340-350`）。后续 `prompt.slice(0, STDIN_MAX_BYTES)`（`lib/index.js:353-363`）虽仍按 code units，但守卫通过意味着完整 prompt 的 code-unit 长度不大于其 UTF-8 byte 长度、也就不超过该上限；因此这里不会再实际截断，是冗余而非残余漏洞。
- subprocess stdout/stderr/spill 的阈值都明确以 `*_BYTES` 命名并直接交给 subprocess byte collector（`lib/index.js:80-83,359-363`；`lib/live.js:38-40,709-716`），没有再用字符串 `.length` 冒充这些阈值。artifact 写入也先转 Buffer，并以真实 bytes 分块累计（`lib/artifact.js:220-240`）。
- `PENDING_MAX_CHARS`、`DIGEST_MAX_CHARS`、`DIAGNOSTIC_MAX_CHARS` 与 `clip`/`truncate` 都明确是展示或 JS 内存字符预算（`lib/live.js:44-54,81-84,307-315`；`lib/index.js:84,92-95`），不声称 byte contract。它们可能在 surrogate pair 中间裁切，但最多造成末尾替换字符，非指令静默截断。
- `DELIVERY` 口径也已拆开：本地展示仍按 8000 code units clip，传给 jobs 的则是独立 `DELIVERY_MAX_BYTES=32KiB`（`lib/live.js:47-57,944-968`）。8000 个汉字约 24KB，连附加 lossy 说明仍落在 byte cap 内；不再把 chars 数值冒充 bytes。

### 疑似

- live `amp_run` / `amp_send_message` 本身没有类似 1MiB prompt byte guard（`lib/live.js:986-996,1034-1055`）。这是另一条无限 pipe 输入策略，不一定错误；但若 Amp CLI 或 subprocess pipe 实际也有输入上限，当前没有 fail-loud 保护，材料中未给出该上限证据。
