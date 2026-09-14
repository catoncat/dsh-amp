# Round 7：F26b 修复闭环验收

> 状态：审查完成。结论分为「已确认」与「疑似」，每条实质结论附 `文件:行号`。

## 1. 五组代码修复与新裂缝

### 已确认

- **1（`amp_runs`）主体闭环。** `list()` 的失败对象先经 `Array.isArray` 分流，再抛出保留 store 原因的普通 `Error`，不会再 spread 失败对象；checkpoint 的 `{ok:false,error}` 被映射为 `checkpoint:'unreadable'`，`checkpointError` 补上 `read checkpoint failed:` 操作名，且 `interrupted`/`terminated` 均保持 UNKNOWN，`resumeHint` 也明确写 UNKNOWN（`lib/live.js:1266-1274,1286-1320`；store 原始失败形状见 `lib/artifact.js:125-170`）。两条故障测试直接覆盖损坏 checkpoint 与不可列目录（`test/live.test.mjs:722-755`）。
- **2（quiescence 门槛）指定的 `resumable` 修复闭环。** `resumable` 已显式要求 `o.quiescenceUnproven !== true`（`lib/live.js:884-889`）；判别用例构造“有 assistant 工作＋成功 result＋exit 0，但 managed range 始终不静止”，能让修前条件误给 resumable、修后不再给（`test/live.test.mjs:757-774`）。但同类 `retryable` 谓词没有该门槛，见下方新裂缝。
- **3（封闭 job 枚举投影）闭环。** DSH 终态只允许 `completed|killed|failed`（`$HOME/work/repos/deepseek-harness/packages/jobs/jobs/src/types.ts:31-38`）；插件将“进程 completed 但 durability partial / quiescence unproven”统一降为 `status:'failed'`，同时保留 `processStatus` 与 degraded 原因（`lib/live.js:422-456,870-896`）。`amp_stop` 从同一 outcome 投影为 `error`，因此 stopReason 与 job 状态一致（`lib/live.js:1153-1165`）；partial 与 quiescence 两条测试都同时断言 job/stop（`test/live.test.mjs:682-720`）。
- **4（有界保留）对 active/interrupted 的安全修复已闭环。** 当前只把 checkpoint 可读且 `finished:true` 的目录放进删除候选；missing/corrupt/unfinished 永久受保护，参数也已校验，root/list 与删除失败均保留操作名，`open()` 会 warn 自动清理失败（`lib/artifact.js:45-113,175-180`）。四条 retention 测试覆盖 finished 的 age/count、三种受保护形状、删除失败与 root 不可读（`test/artifact.test.mjs:179-267`）。仍未按“业务失败的重要性”保留，见 §2。
- **5（live 设置）正常 host 组合已闭环。** host 暴露 `current/subscribe`；agent 行改用 required-service `inject` 等待晚到 provider，先 `current()` 对齐 mount/subscribe 竞态，再订阅并原地 mutate；idle timeout 也改成每个 sweep tick 读取 `resolved`（`lib/index.js:532-566`；`lib/live-plugin.js:29-60`；`lib/live.js:1337-1372`）。模式 enum 在 mount 固定的边界已明示（`lib/live.js:663-677`；`docs/USABLE.md:28`）。
- **新裂缝：quiescence 未进入 `retryable`。** terminal notice 只凭 no-work failure + `assistantMessages===0` 给 `retryable=true`，不检查 `quiescenceUnproven`；同一 notice 可同时说“可安全重跑”和“孤儿可能仍活着”（`lib/live.js:877-892`）。`resumable` 测试没有覆盖该对称分支（`test/live.test.mjs:757-774`）。
- **新裂缝：缺 settings service 的“可知”测试不符合真实框架。** 代码把 warn 放在 `ctx.inject([ampSettings], callback)` 的 callback 内（`lib/live-plugin.js:40-45`），但 Cordis required inject 在 service 缺失时根本不加载 callback，只会等待 provider（`$HOME/work/repos/deepseek-harness/vendor/cordis/src/registry.ts:164-176`；`docs/user/develop/framework/service.md:87-99`）。因此“永远未提供”时工具会以 mount 快照继续工作，但不会出现该 warn；测试 fake 强行在依赖缺失时调用 callback，证明的是框架不会发生的路径（`test/composition.test.mjs:125-151`）。晚到 service 会接上，永久缺失仍不可知。

### 疑似

- **订阅对其余字段的整链覆盖仍不足。** 当前行为测试只观察新 `ampBin` 以及订阅前的 `current()` 对齐；visibility、keepThreads、grace 从同一对象在新 run 启动时读取，idle timeout 也已改为 tick 时读取，静态上成立，但没有各自的行为断言（`lib/live.js:681-713,1337-1372`；`test/composition.test.mjs:67-123,154-206`）。

## 2. artifact 保留策略安全性

### 已确认

- **不会自动删正在跑或宿主崩溃留下的 run。** active run 初始 checkpoint 为 `finished:false`，missing/corrupt/unfinished 都不进入候选；因此不再需要把 live session map 传给 store，也不会 unlink 仍打开的目录（`lib/artifact.js:75-113`；初始 checkpoint 见 `lib/live.js:746,790-803`）。对应三种形状的 90 天旧 run 都有判别性保护测试（`test/artifact.test.mjs:216-237`）。
- **但 `keepDays`/`keepCount` 仍可能删“最需要的业务失败 run”。** `finished:true` 只代表 lifecycle 已 finalize，不代表任务成功；失败后有 assistant 成果、可 resumable 的 run 同样会写 `finished:true`（`lib/live.js:608-620`）。反例：8 天前一个完成收尾但额度中断、已有大量成果的 run，之后出现 50 个短成功 run；它会在 finished 候选中落出 age/count 并被删（`lib/artifact.js:85-100`）。当前 checkpoint 也没有持久化 terminal `status`，pruner 无法区分成功与失败（`lib/live.js:347-364,613-617`）。
- **错误形状与可观测性已闭环。** root 不存在是空集；其他 list 失败返回 `{ok:false,error:'list runs for prune: …'}`，删除失败返回 `prune <name>: …`，实际 `open()` 会 warn（`lib/artifact.js:66-74,90-100,175-180`）。测试分别锁住 root/list 与删除失败（`test/artifact.test.mjs:239-267`）。
- **机械 age/count 策略本身成立。** 只在 finished 候选中保留时间窗内全部以及最新 N 个（`lib/artifact.js:85-100`），参数负数/NaN/小数也已归一化（`lib/artifact.js:55-65`）。
- **仍缺小时节流的判别测试。** 代码用 store 内 `lastPruneAt` 实现（`lib/artifact.js:119-123,175-180`），但当前 retention 测试都直接调用 `pruneRuns`，未证明连续 `open()` 一小时内只扫一次（`test/artifact.test.mjs:192-267`）。

### 疑似

- **是否要永久保护所有业务失败属于产品策略。** 当前实现只承诺保护未 finalize 的救援现场；若“7 天或 50 个 finished run”已被明确接受，旧 resumable run 被删是已知 retention，而非代码错误。但文档目前没有把这个取舍说清（`docs/USABLE.md:25`）。

## 3. 文档证据强度

### 已确认

- **`AMP-LIMITS` 的主要降级已做对。** #1 明确只实测 low/medium，并把 high/ultra 标成保守沿用；#6 不再把 TTY 写成充分条件；#7 把 SDK continue 标成未验证；#8 明说一次个案；#9 拆开官方文本与本部署观测；#10 把“全新”降为假设（`docs/AMP-LIMITS.md:8,13-17`）。未知清单也补了 F26 所需数据（`docs/AMP-LIMITS.md:19-25`）。
- **但 `AMP-LIMITS` 仍有三条强于证据：**（a）#2 标题仍断言“限流在应用层，不是 HTTP 429”，证据只支撑“该次捕获的 72 条请求如此”，且所指 DB 会轮转（`docs/AMP-LIMITS.md:9`）；（b）#3 的“按账号”没有同窗口另一账号对照，文档自己的未知项也承认账号独立规则未验证（`docs/AMP-LIMITS.md:10,25`）；（c）#4 把两次花费标“可复核”，但列出的 artifact 不包含余额前快照，本地 ledger/`amp_accounts` 当前值也不能重建 `$5→$2.84` 的历史，证据强度最多是本机操作记录（`docs/AMP-LIMITS.md:11`）。
- **`USABLE` 的“崩溃不丢/可捞回”仍是绝对承诺。** 能力表写“崩溃不丢”且“崩溃/重启后可捞回成果”，没有在同处限定 partial write、lossy gap 或 finished-run retention（`docs/USABLE.md:14-15,25-26`）。当前 unfinished/corrupt/missing 已受保护，但 append/fsync 失败和有损采集仍是反例；应改为“尽力持续落盘；artifact 可读且未过保留策略时可救援”。
- **artifact retention 文档少了成败优先级合同。** `docs/USABLE.md:25` 只说 7 天/50 个，没有说 missing/corrupt/unfinished 永不删，也没有说 finished 的成功与失败同等淘汰；读者无法判断旧 resumable 成果何时会消失（`lib/artifact.js:75-113`）。
- **live 设置的正常路径声明现与实现一致，但缺 service 的降级仍被过度承诺为可知。** idle timeout 已每 tick 读取，`current()` 竞态也已补（`lib/live.js:1337-1372`；`lib/live-plugin.js:47-59`）；然而 required inject 缺失时 callback/warn 不运行，文档未披露这一静默 mount 快照边界（`docs/USABLE.md:28`；`lib/live-plugin.js:40-45`；DSH 合同 `$HOME/work/repos/deepseek-harness/docs/user/develop/framework/service.md:87-99`）。
- **日常建议仍有四处旧强化/内部矛盾。** “high/ultra 更高”无样本；“低于 `MODE_HEADROOM` 会被跳过”与 fail-open 相反；“`amp_stop` 取回完整产出”不适用于 lossy gap；“`interrupted:true` 的就是被宿主中断”把状态谓词提升成原因，且多 host 共用 root 时另一个 host 的 live run 也会被当前进程这样标（`docs/USABLE.md:89-91`；与正确边界 `docs/USABLE.md:23,26,77` 对照）。
- **部署状态段仍自相矛盾。** 前文正确说 `--check`/drift 不能证明宿主已重启，后文又让用户用 `deploy.sh --check + amp_accounts.source.drift` 判断“待生效”；这两者读的都是磁盘文件，无法证明进程内已加载新模块（`docs/USABLE.md:27,55-56,62`；`lib/source.js:60-96`）。
- **测试计数已经漂移。** `CHANGELOG` 仍写本轮 112 条，而 `USABLE` 两处写 116 条；本轮第一次实跑已发现当前收集 120 条（`docs/CHANGELOG.md:21`；`docs/USABLE.md:42,60`）。这些固定数字不能同时成立，最终结果见 §6。

### 疑似

- **“免费”容易继续误导，但可按货币语义解释。** `amp_accounts` 默认只读 ledger，显式 refresh 才发生约 3.4s/号的网络往返（`docs/USABLE.md:13,47`；`lib/live.js:1181-1215`）。若“免费”只指不花 credits 则成立；若指零时间/零外部调用则不成立。建议写“默认本地且不花 credits；refresh 不花 credits 但有网络成本”。

## 4. 代码注释证据强度

### 已确认

- **mode floor 注释仍把局部个案写成全表 measured。** 注释标题说 `MODE_FLOORS` “MEASURED, not guessed”，但证据只覆盖同一 `$0.90` 账号上的 low 接受、medium 拒绝；high/ultra 只是沿用 `$1`（`lib/ledger.js:39-53`）。`accounts.js` 又把它概括成“medium and up need $1 (measured)”（`lib/accounts.js:209-218`）。两处都应限定为“low/medium measured；high/ultra conservative policy”。
- **headroom 注释仍把策略值写成各 mode 实测花费。** “What a run of each mode is expected to SPEND, measured”与当前证据冲突：只有两次 medium 长任务，low/high/ultra 都无完赛分布，`6/10` 明显是策略值（`lib/ledger.js:55-70`；证据边界见 `docs/AMP-LIMITS.md:11,24`）。同段“low 低于 `$1` 后续请求会被拒（measured gate）”也没有对应留存证据，只测到 low `$0.90` 可启动与 medium `$0.90` 被拒（`lib/ledger.js:63-68`）。
- **artifact 注释仍承诺“任何 ending 都能活下来”。** 实现注释称 artifact 让 partial work “survive any ending”，工具说明又称它 “survives whatever ended the run”；partial write、未 fsync 的突然掉电、以及 finished-run retention 都构成反例（`lib/live.js:186-194,1245-1249`；`lib/artifact.js:85-100,292-315`）。应改“best-effort durable record；失败会显式降级”，不能写 any/whatever。
- **`interrupted` 的代码注释仍把谓词写成唯一原因。** “previous process”与“is an INTERRUPTED run”忽略多 host 共用 `DSH_HOME`：另一个仍活着的进程不会出现在本进程 sessions map，也会命中该谓词（`lib/live.js:1278-1295`）。代码输出只断言“不在本进程且 checkpoint 未 finished”才是证据允许的表述。
- **live-settings 注释把不可达 warn 当成可观测降级。** 注释说晚到 service 会接上是对的；但又声称旧 mount freeze 会在日志可见，而 warn 位于 required inject callback 内，永久缺 service 时 callback 不运行（`lib/live-plugin.js:37-45`；`$HOME/work/repos/deepseek-harness/vendor/cordis/src/registry.ts:164-176`）。
- **运行构建漂移注释比实现强。** `describePackageDrift` 自称比较“RUNNING package”与源码，实际每次从 loaded module 的**磁盘路径**重新读文件；部署脚本覆盖磁盘后、宿主尚未重启时，它可以 in-sync，但内存仍运行旧模块（`lib/source.js:48-60,83-96`）。文档已经承认这一点（`docs/USABLE.md:27,55-56`），注释应同步改成“installed copy on disk”。
- **`amp_accounts` 模型可见说明不准确且陈旧。** description 称余额总是“read from `amp usage`”，实际默认只读本地 ledger、只有 `refresh:true` 才探测；参数说明还写死“48 accounts”，当前文档记录为 73（`lib/live.js:1181-1192,1207-1215`；`docs/AMP-LIMITS.md:17`）。这会直接误导工具调用成本判断，不只是文风。

### 疑似

- **“25 active reads/waits”属于一次事故记录，不应被理解为稳定收益。** 注释明确写 measured today，作为机制动机可以保留；若未来对外引用，必须限定为该次运行，不能推广成所有 run 都从 25 次轮询降到 0（`lib/live.js:838-844`；相同强化仍见 `docs/CHANGELOG.md:79`）。

## 5. 高危项与“只修一件”

### 已确认

- **仍有 1 个高危：job admission 发生在 child 启动并收到 prompt 之后。** `amp_run` 先 `spawn`、把 prompt 写进 stdin、创建 artifact、登记 dispatch/exit observer，最后才调用 `jobs.start`（`lib/live.js:673-827,925-934`）。若 jobs 因 owner admission 拒绝，child 已可开始花额度/做工作；catch 只同步 `terminate()`、不等待 process range 静止，却向调用者断言“terminated before it could do work”（`lib/live.js:935-956`）。host dispose 同样只 terminate 后立即清空 sessions，不 await quiescence/artifact finalize（`lib/live.js:198-208`）。这仍违反 DSH `done` 必须在资源释放后结算的 owner 合同（`$HOME/work/repos/deepseek-harness/packages/jobs/jobs/src/types.ts:71-84`）。
- **“只修一件”最终建议：先把 admission 移到 spawn/prompt 之前，并让所有 teardown 汇入唯一 `finish()`。** 目标不是补一句文案，而是保证“slot 拒绝 ⇒ child 从未启动”；一旦启动，job cancel、host dispose、spawn 后失败都必须 await managed range、最后 absorb、artifact finalize，再释放 session。它比继续补选号或文档更优先：当前风险是未受 jobs 所有权约束的付费进程，且错误消息会明确否认它已经开跑。
- **其余是中危/已知边界，不再冒充高危。** `retryable` 缺 quiescence 门槛会给矛盾动作建议（`lib/live.js:877-892`）；旧 finished 失败成果会按普通 retention 淘汰（`lib/artifact.js:85-100`）；永久缺 `ampSettings` 时降级不可知（`lib/live-plugin.js:40-45`）；one-shot UTF-8 byte 口径仍按 JS code units（`lib/index.js:340-357`）。这些都应修，但没有上述资源所有权问题直接。
- **可接受但必须继续写明的边界：** mode 列表 mount 固定（`lib/live.js:661-677`）；headroom/claim 都是 fail-open 偏好而非硬锁（`lib/accounts.js:169-188,260-264`）；spill gap 当前不回补（`docs/USABLE.md:26`）；ledger 单 writer、`amp_runs` 为 host 级跨 session rescue 面（`docs/USABLE.md:29-30`）；本地 thread continue 与 high/ultra 成本仍属未知（`docs/AMP-LIMITS.md:13-14,24-25`）。

### 疑似

- **没有额外疑似高危。** 现有疑点要么已有显式降级/边界，要么需要产品选择；不应为了凑数量升格。

## 6. 当前 120 条测试的判别性

### 已确认

- **1：有。** corrupt checkpoint 用例同时断言 unreadable、操作错误、`interrupted` UNKNOWN 与 UNKNOWN hint；unlistable root 用例断言原 store 失败且不是次生 TypeError，恢复旧实现任一处都会红（`test/live.test.mjs:722-755`）。
- **2：指定的 resumable 有。** 用例必须同时有 assistant 工作、success result 与 unproven quiescence，恰好区分“只看 status failed”与新门槛（`test/live.test.mjs:757-774`）。但没有对称的 `retryable + quiescenceUnproven` 负例。
- **3：有。** partial 与 quiescence 分别构造“进程确实 completed，但整体必须 failed”，并同时断言 detail、degraded processStatus、无错误 resumable 与 `amp_stop.stopReason='error'`，会抓住只改 job 或只改 stop 的半修（`test/live.test.mjs:682-720`）。
- **4：主体有，但 `open()` 集成缺口仍在。** finished age/count、unfinished/corrupt/missing 保护、删除失败、root list 失败四组都能让旧策略变红（`test/artifact.test.mjs:192-267`）。缺“同一 store 连续 open 一小时内只 prune 一次”、`open()` 对 prune failure 实际 warn，以及“旧 resumable failure 是否保留”的策略用例。
- **5：正常订阅有，完整声明没有。** `ampBin` 用例会让 mount 冻结旧实现变红，`current()` 用例会抓 mount/subscribe 竞态（`test/composition.test.mjs:67-123,154-206`）。缺 visibility/keepThreads/grace/idle timeout 的行为断言；“缺 service 会告警”测试使用了违背 required inject 的 fake，因此不能证明真实 DSH 降级可知（`test/composition.test.mjs:125-151`；DSH 合同 `$HOME/work/repos/deepseek-harness/docs/user/develop/framework/service.md:87-99`）。
- **结论：1、2、3 有完整判别性；4、5 只有主体判别性。** 另外当前没有测试锁住 §5 的 spawn-before-admission：现有“refused slot terminates child”只证明调用了 terminate，未证明 prompt 未投递或 process range 已停稳（`test/live.test.mjs:387-392`；生产顺序 `lib/live.js:705-827,925-956`）。

### 疑似

- 无。

## 验证

- 最终实跑 `bash test/run.sh`：**120 tests / 120 pass / 0 fail**。运行前后 `lib/*.js + test/*.test.mjs` 聚合哈希一致（`6def3b2f5353afa63ac48786f531d80caa674a8c`），该次结果对应稳定快照。
- 首次运行恰逢并发编辑，只得到 120 中 119 过；重读已变文件后才在稳定快照复跑。未发起 Amp agent、未花额度、未改本报告之外的文件。

## 摘要（≤200 字）

1~3 闭环；4 保护 active/interrupted，但旧 finished 失败仍可能被成功 run 挤掉；5 订阅生效，永久缺 service 仍静默。唯一高危：child 先启动收 prompt、后做 jobs admission，拒绝/退出不 await 停稳。文档仍有“崩溃不丢”、high/ultra、drift 强化。**可受控 dogfood，不能算稳定生产可用。**
