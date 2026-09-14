# dsh-amp 第 4、5 点代码审查

## 结论摘要

1. A1 原死锁已修：结算异常必经 `finally` 解锁，且最新 catch 让 `finish` 本身也不再 reject（`lib/live.js:423-472`）。但 job 状态可能在该 catch 写入 `settleError` 前生成，结算失败仍可能报 completed。
2. 白名单已覆盖 SIGKILL、迟到 cancel 和“exit 0 但无 result”；仍有 `waitForExit` 先于 `handle.done` 时把优雅成功误报 failed 的竞态（`lib/live.js:405-422,639-689`）。
3. mode 下限与候选顺序正确；最新并发改动也已把漂移扩展为整包 `.js` 集合比较（`lib/source.js:87-123`）。剩余硬缺陷集中在 `amp_runs` 的错误降级、原始 artifact 脱敏和退出竞态。

**总判断：点 4、点 5 的主机制都改对了；修完退出竞态与 `amp_runs` 错误/安全边界后，才算可生产信任。**

## 1. `done` 收敛性

### 已确认

- 上轮 A1 的主洞已关闭。job 拿到的是启动时立即创建、只有 `resolve` 的 `session.settled`（`lib/live.js:588-594`）；`done` 只在它 resolve 后映射结果（`lib/live.js:676-716`）。结算主体的 `absorb`、分类、`finalize` 全在 `try` 内，`markSettled()` 在 `finally`，外层 catch 再把异常收成 `settleError`（`lib/live.js:423-472`）。所以这些步骤即使抛错，`done` 也会 resolve，`finish` 也不再 reject；平台随后提交 terminal record 并解锁自己的 `job.settled`（`dsh-jobs-local/lib/index.js:365-376`）。`session.settled` 没有 reject 入口。
- `finish()` 的早退分支不会漏解锁：首次调用已经创建并运行同一 `settlePromise`；后到的 kill 只升级 `terminate()`，然后返回原 promise（`lib/live.js:382-392`），首次事务仍必经 `finally`（`:457-465`）。自然退出的 resolve/reject 两支都会调用 `onExit()` 再汇入 `finish`（`lib/live.js:634-649`）；显式 job cancel同样汇入（`:672-675`）；idle sweep汇入（`lib/live.js:1108-1125`）。没有 `relaunch` 分支。
- owner / jobs service dispose 会同步调用 producer `cancel`，然后等平台自己的 terminal latch（`dsh-jobs-local/lib/index.js:406-422`）；这里的 cancel 同步且不抛（`lib/live.js:672-675`）。live 插件 dispose 虽先 terminate+clear map（`lib/live.js:196-206`），但 job hooks 和 `handle.done` 闭包仍持有 session，clear 不会阻断结算。

### 疑似 / 剩余边界

- **不再有已证实的“结算抛错导致 `done` 永久 pending”路径。** 仍有一个运行时兼容边界：若 `AbortSignal.timeout` 不存在，`settleSignal()` 返回 `undefined`（`lib/live.js:371-373`），两次 `waitForExit` 便失去本插件的 20s 上限（`lib/live.js:405-422`）。当前 DSH subprocess 契约支持 signal-bound wait（`dsh-subprocess/lib/types/types.d.ts:172-178`），本机 Node 也有该 API；若支持旧 runtime，应在插件内用 `Promise.race` 做不依赖全局 API 的兜底。
- 新 catch 关闭了 `settlePromise` rejection，但 `markSettled()` 在 `finally` 内先 resolve `session.settled`，catch 才写 `settleError`（`lib/live.js:457-470`）；job 的 `done.then` 可能先读状态，而且 completed 判据不含 `settleError`（`:676-696`）。因此“不会挂”已成立，“结算异常一定诚实报 failed”尚未成立。最小修法：在内层 `try` 配对的 `catch` 中先写 `settleError/failure`，再进入 `finally` resolve；或让 `done` 直接 await 已 catch 的 `settlePromise`。

## 2. 完成状态白名单

### 已确认

- SIGKILL/null exit 不再误报成功（`lib/live.js:684-696`；`test/live.test.mjs:423-433`）；自然结束后的迟到 cancel 不再篡改结局（`lib/live.js:396-400`；`test/live.test.mjs:435-448`）；exit 0 无 result 也已明确 failed（`lib/live.js:682-689`；`test/live.test.mjs:472-482`）。
- `exitCode === undefined` 报 `failed` 在“进程结果确实未知”时是正确的保守选择；不能把无法证明退出成功写成 completed。平台定义 `exitCode: null` 为 signal death，正常退出必须是 number（`dsh-subprocess/lib/types/types.d.ts:105-109`）。

### 疑似（一个可达误报）

- **优雅停止存在成功却报 failed 的竞态。** `finish` 等的是 managed range 为空（`lib/live.js:405-418`），但 `exitCode` 只由独立的 `handle.done.then(...)` 回调写入（`lib/live.js:639-648`）。平台也把 `waitForExit`（range empty）与 `done`（direct outcome + output drain）定义成不同 promise（`dsh-subprocess-local/runner-launch-COYGu0Dl.js:1032-1044,1074-1109`）。若前者先 resolve，结算立即 `markSettled`，白名单在 `handle.done.then` 写入前看到 `undefined`，把成功 run 判 failed。现有 fake 的 `waitForExit()` 默认立即成功（`test/live.test.mjs:69-73`），但成功测试都先手动 resolve `handle.done`，没有覆盖该顺序。

**更精确判据：** 先在 quiet 已证明后 `await handle.done`（捕获 reject），由该 await 原子写入 `exited/exitCode/exitError`；然后仅当 `killedByCancel !== true && quiescenceUnproven !== true && settleError === undefined && exitCode === 0 && result !== undefined && result.is_error !== true && failure === undefined` 才 completed。优雅 close 若最终没拿到进程 outcome 或 success result，仍应 failed。

## 3. 模式额度下限

### 已确认

- mode 在两条入口都先确定再选号：one-shot `chooseAccount(ctx,resolved,mode)` → `pool.choose({mode})`（`lib/index.js:224-268`）；live 先定 `requested` 再 `chooseAccount(requested)`（`lib/live.js:501-505`）。
- 候选顺序符合要求：可测量且达标立即返回（`lib/accounts.js:287-293`）→ 可读但无金额（`:295-299`）→ 已知低于 floor（`:300-311`）→ 读取失败（`:312-316`）。对应测试覆盖可读无金额、不可读、mode 两向选择（`test/accounts.test.mjs:212-289`）。
- unknown mode 回退 1 是合理的 fail-conservative 默认，且已测试（`lib/ledger.js:48-57`；`test/accounts.test.mjs:228-234`）；否则拼错 mode 会悄悄获得 low 的宽松待遇。

### 疑似 / 边界结论

- `low: 0` **确会让已测得 `$0.05` 的首个账号胜出**：零余额被明确跳过（`lib/accounts.js:287-290`），但任意正数都满足 `remaining >= 0`（`:291-293`）。实测只证明 `$0.90` 可启动（`lib/ledger.js:42-46`），不能证明 `$0.05` 可启动。因此 `0` 应理解为“尚未测得 low 的启动下限”，不是已证明的精确门槛。
- 不建议再加“至少 > 0 且已被读过”：`remaining === 0` 已被跳过；数值余额来自 ledger 或本次 remote read，陈旧值会重读（`lib/accounts.js:236-286`），所以“已被读过”也已满足。它解决不了 `$0.05` 是否够的问题。
- 可执行建议：把 `MODE_FLOORS` 文档/命名明确为**排序偏好**而非硬启动保证，并继续以真实 refusal 更新证据。若产品要禁止已知极小余额，需另设 `hardMinimum`，但在取得 low 的真实边界前不要猜数；况且当前 below-floor 最终仍会 fail-open 派发（`lib/accounts.js:300-310`），单改 floor 也挡不住 `$0.05`。

## 4. `amp_runs` 信息与安全

### 已确认

- 工具不 spawn、不调用账号探测，只读 `artifacts.list/readCheckpoint/pathOf`（`lib/live.js:1020-1067`），因此确实不启动 agent、不花额度。
- 新格式 key 是 `<runId>-<Date.now()>`（`lib/live.js:603-607`）；取尾部数字按 epoch 数值排序（`lib/live.js:1042-1052`），跨月份、跨正常重启仍正确。风险是两个进程在同一毫秒生成相同 runId/seq 时会碰目录；同 epoch 的排序也没有稳定 tie-break。最小根治是 key 加 UUID，并把 `startedAt` 作为 checkpoint 的显式排序字段，而不是从文件名反解析。
- `limit`：缺省/非法/负数为 5，有限非负数向下取整，0 表示全部；先取最新 N 再 reverse，结果新→旧（`lib/live.js:1048-1052`）。语义与 schema 文案一致（`:1032-1034`）。
- 工具返回的 `lastText` 经 checkpoint 写入时 `sanitize`，再次 clip 到 200；不会直接输出 `sgamp_` token（`lib/live.js:322-337,1053-1065`）。它仍会跨 session 列出所有 run 的 account ref、thread、lastText 和本机路径，且 execute 不检查 caller（`lib/live.js:1041-1067`）；若不同 agent session 之间需要隔离，这是确认的元数据/任务摘要泄漏。恢复需求与 owner fence 冲突，应明确这是“本机全局诊断工具”，或持久化 owner 并提供受控的 `all` 视图。

### 已确认缺陷

- **checkpoint 读取失败被静默伪装。** `readCheckpoint` 在损坏/权限错误时返回 `{ok:false,error}`（`lib/artifact.js:87-96`），映射层却把它当普通 checkpoint，于是 `terminated:false`，其余字段空白且不显示错误（`lib/live.js:1053-1065`）。应返回 `checkpointError`，并把终止状态设为 `unknown`，不能写 false。
- **列表读取失败会抛次生 TypeError。** `artifacts.list()` 失败返回 `{ok:false,error}`（`lib/artifact.js:73-84`），`[...artifacts.list()]` 要求 iterable（`lib/live.js:1048`）。应先判断 Array，失败时返回 `{root,total:0,runs:[],error}`。
- “artifact 内容已做 `sgamp_` 脱敏”对完整流并不成立：stdout 原文直接 append（`lib/live.js:267-277`），初始 prompt 也以原文 `userLine` append（`lib/live.js:150-153,617-618`）。`amp_runs` 本身只泄露已脱敏 checkpoint 摘要，但它给出的 `artifactPath` 指向可能含 token 的原始流。最小修法是在 append 前 sanitize（若“原始协议逐字节”不是硬合同），或把原始文件视为敏感审计物、另写 sanitized rescue stream；至少补测试固定安全承诺。

## 5. 部署漂移提示

### 已确认

- 最新实现已从单入口 hash 扩为 running/source 两侧 `.js` 文件名并集逐项比较，能发现已有文件变更、只在源码新增、只在安装副本残留三类漂移（`lib/source.js:87-123`）；非入口变化已有测试（`test/source.test.mjs:83-108`）。live 与 host 都使用 `describePackageDrift` 并返回 changed/added（`lib/live.js:59-71`；`lib/index.js:493-501`）；`amp_run`、`amp_accounts`、Web route 均带 source。
- STALE 页面文案已明确给出“先跑 deploy.sh，再重启宿主”（`lib/client.js:55-77,347-354`），足以让人知道下一步；不是只有一个无解释徽标。

### 疑似 / 体验缺口

- 任务点名的 `describeDrift(runningFile)` 仍保留旧单文件语义（`lib/source.js:51-63`），真正被消费者使用的是新增 `describePackageDrift`（`:87-123`）。结果已闭环，但两套近义 API 容易被未来调用者误用；应删/改名旧函数并把三态测试迁到 package 版本。
- `unknown` 在页面上完全不显示：UI 仅判断 `=== 'STALE'`（`lib/client.js:352-354`）。因此用户视觉上无法区分“已确认 in-sync”和“无法比较”。打包安装时 unknown 可能正常，不应红色报警，但建议显示中性状态“无法与源码树比较（打包安装时正常）”，避免把未知默认为健康。
- 工具 JSON 的 `source.drift='STALE'` 没有 remediation 字段；只有 Web 页面告诉人怎么做。若 `amp_run/amp_accounts` 也面向人类排障，建议 `describeDrift` 或响应增加 `action: 'run deploy.sh, then restart the harness'`，不要要求读者知道 STALE 的部署流程。

## 6. 测试缺口与最小补测

实跑 `bash test/run.sh`：74/74 通过。现有测试已锚定 mode 两向选择与 unknown 默认（`test/accounts.test.mjs:212-234`）、SIGKILL/late cancel/无 result（`test/live.test.mjs:423-482`）、单个 `amp_runs(limit:1)` 成功读取（`:405-421`）、单文件三态及非入口 `.js` 漂移（`test/source.test.mjs:50-108`）和 Web STALE 接线（`test/web.test.mjs:68-79,109-115`）。以下仍缺：

### 应在当前代码上变红（真实缺陷）

1. `A1: graceful settlement waits for handle.done before classifying success`：先让 `waitForExit=true`、stdout 已有 success result，但延后 resolve `handle.done`；不得先得到 failed（对应 `lib/live.js:405-418,639-689`）。
2. `A1: settlement error cannot be reported completed`：让 final `readFrom` 或 `finalize` 抛错，断言 `jobs.hooks.done` resolve 为 failed 且带诊断；当前 `markSettled` 先于 catch 写 `settleError`（`lib/live.js:457-470,676-696`）。
3. `amp_runs: corrupt checkpoint reports checkpointError and unknown termination`：写坏 JSON 后列 run；当前把 `{ok:false,error}` 当正常 checkpoint，误报 `checkpoint:'ok'` 且吞错误（`lib/artifact.js:88-96`；`lib/live.js:1070-1091`）。
4. `amp_runs: list failure returns the artifact-store error`：把 runs root 做成不可列目录，期望结构化 error；当前 spread 非 iterable（`lib/artifact.js:73-84`；`lib/live.js:1065`）。
5. `artifact security: prompt and stdout redact sgamp tokens on disk`：分别在 prompt 与 assistant output 放 token，读 stream.log 不得出现原文；当前原样 append（`lib/live.js:150-153,267-277,617-618`）。若产品明确选择“0600 原始审计流”，则反向测试文件权限并把“artifact 已脱敏”的承诺限定为 checkpoint/工具输出。
6. `client: unknown drift is visibly distinguished from in-sync`：渲染 unknown，期望中性提示；当前无节点（`lib/client.js:352-354`）。这是体验缺陷，若产品明确决定 unknown 静默，则无需此测试，但必须记录该语义。

### 当前应通过的合同锚定

7. `A1: owner dispose cancels and settles done`：执行 job owner cleanup，断言 cancel 同步、done terminal、dispose 不挂（`dsh-jobs-local/lib/index.js:394-422`；`lib/live.js:672-716`）。
8. `A1: a second finish with kill upgrades termination but shares settlement`：专门覆盖早退分支（`lib/live.js:382-392`）；现有并发 stop 只测两个默认 graceful（`test/live.test.mjs:179-198`）。
9. `A1: refused admission finalizes an admissionRefused checkpoint`：现有测试只断言 terminate（`test/live.test.mjs:379-384`），应同时断言 fd 关闭、checkpoint 有 `finished/admissionRefused`（`lib/live.js:748-756`）。
10. `mode propagation: provider and live pass the selected mode into pool.choose`：目前账号单测直接调用 choose，没有锁住两个调用点（`lib/index.js:224-268`；`lib/live.js:501-505`）。
11. `low floor: zero is skipped but a measured positive remainder remains eligible`：固定当前“0 是无已知 floor、不是免费额度”的语义（`lib/accounts.js:287-293`）。另加 `$0.05` 用例只应记录当前选择，不应声称上游一定接受。
12. `amp_runs: limit 0/all, default 5, invalid fallback, and multi-epoch newest-first`：现有只测 `limit:1`（`test/live.test.mjs:405-421`），未锁定边界及跨月份排序（`lib/live.js:1058-1069`）。
13. `amp_runs: two hosts cannot collide on run key in the same millisecond`：采用 UUID 后补；当前 Date.now key 理论上会碰（`lib/live.js:610-614`）。
14. `source payload: amp_run, amp_accounts and Web all carry drift`：现有 live 测试只验证 run 有 file/hash，accounts mock source 不含 drift（`test/live.test.mjs:456-470`）；Web 已覆盖 STALE。

## 7. 更简单或更根本的方案

1. **一个 settlement deferred、一个顺序明确且不抛的终结事务。** 保留启动时创建 deferred 是对的；`finish` 内先显式取得 `handle.done` outcome，再 finalize；捕获异常并写 failure 后，最后一步才 resolve deferred。`amp_stop` 与 job done 都等同一个已 catch promise。这样同时消掉退出码竞态、结算错误竞态和两套完成事实（当前分裂在 `lib/live.js:382-472,588-594,639-716`）。
2. **额度事实分成“已知启动下限”和“选号偏好”。** 当前 floor 实际只控制优先级，因为 below-floor 仍 fail-open（`lib/accounts.js:291-310`）。把来源写成带证据的表（mode、observedAccepted、observedRejected、时间），而不是把 `low:0` 注释成“needs none”（`lib/ledger.js:40-57`）。没有足够数据时不造硬门槛；真正根治“启动够、跑不完”仍是预计任务成本/预算，不是再猜一个 low 常数。
3. **部署 manifest/build id 是整包扫描的更简单替代。** 当前 `.js` 文件并集比较已能抓住本轮源码漂移（`lib/source.js:87-123`）；若还需覆盖 package metadata、静态资源或大包性能，`deploy.sh` 应生成确定性 manifest/build id，运行时只比 id。打包安装则明确显示“无 source manifest”，而不是模糊 unknown。
4. **artifact 索引直接存元数据。** artifact key 用 `epoch-uuid`，checkpoint 存 `startedAt/owner/visibility`；`amp_runs` 按字段排序并显式传播 store/read 错误。比从目录名尾部反解析 epoch 更简单可靠（当前：`lib/live.js:610-614,1058-1093`）。

## 附录：已确认与疑似问题清单

### 已确认

- A1 原死锁（结算异常使 job done 永久 pending）已修复；`session.settled` 无 reject 方。
- 白名单修复了 null exit、迟到 cancel 与无 success result；仍有 outcome 到达顺序竞态。
- mode 下传、四级候选顺序、unknown mode=1 正确。
- `amp_runs` 免费且正常路径排序/limit 正确；错误降级、跨 session 暴露边界和原始 artifact 脱敏仍有问题。
- 整包 `.js` 漂移比较与 STALE 文案可执行；unknown 静默、旧单文件 API 重复仍有误导风险。

### 疑似

- managed range 先于 `handle.done` 完成时，优雅成功会因 exitCode 暂为 undefined 被误报 failed；代码与平台 promise 边界支持该竞态，需红测确认真实调度顺序。
- 同毫秒、同 seq 的跨进程 artifact key 碰撞概率低但结构上存在。
