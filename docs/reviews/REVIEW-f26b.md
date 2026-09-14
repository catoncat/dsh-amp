# F26 修复闭环与测试缺口验收

> 状态：验收完成。结论分为「已确认」与「疑似」，所有实质结论附 `文件:行号`。

## 1. 终态与 durability 闭环

### 已确认

- **双真源闭环成立。** `finish()` 在结算、artifact finalize 和异常捕获之后，于唤醒消费者前只生成一次 `session.outcome`（`lib/live.js:572-635`）；job 与 `amp_stop` 分别投影该 outcome（`lib/live.js:854-893,1148-1155`）。completed/failed/外部退出及 killed 的双表面一致性已有测试（`test/live.test.mjs:589-637`）。
- **`completed + durability=partial` 的语义现在自洽，且整体状态已正确降级。** outcome 保留正交 `processStatus` 与 `durability`；当进程成功但 durability partial 或 quiescence unproven 时，Jobs 封闭三态投影为 `status:'failed'`，同时保留 `processStatus:'completed'` 说明业务进程确实成功（`lib/live.js:422-454`）。这比把业务工作也说成失败更精确，又保证只读 status 的消费者不会听到 clean success。job notice 投影 partial/quiescence/degraded，`amp_stop` 同 outcome 给 `error`（`lib/live.js:854-896,1148-1160`）。对应两条判别性测试已覆盖 partial 与 quiescence 的 job/stop 一致性（`test/live.test.mjs:682-720`）。
- **artifact 不完整时的恢复承诺已闭环。** `durability` 只在无 `artifactError/artifactWriteError` 时 complete；partial 明确告警且绝不会满足 resumable（`lib/live.js:431-454,887-896`）。测试断言 partial → failed、显示 `processStatus=completed`、无 resumable、stop 同为 error（`test/live.test.mjs:682-703`）。
- **仍有一个 quiescence 次生谓词漏洞。** `resumable` 只检查整体 `o.status==='failed'`，而 quiescence 降级会把 `processStatus:'completed'` 投影成 failed；若该成功 run 产生过 assistant message、artifact 完整但 quiescence unproven，当前会错误给 `resumable=true`，诱导继续一个已完成任务（`lib/live.js:435-454,884-893`）。现有 quiescence 测试只推入 result、`assistantMessages===0`，没有触发该分支（`test/live.test.mjs:705-720`）。条件还应要求 `o.processStatus==='failed'`。
- **finalize-only `artifactError` 仍缺判别测试与 job 原因文案。** job 会给 `durability=partial`，但 `artifact=INCOMPLETE(...)` 只展示 `artifactWriteError`；只有 `amp_stop` 明示 `artifactError`（`lib/live.js:890-896,1138-1160`）。当前 chmod 用例通常同时触发 checkpoint/write 与 finalize，不隔离 finalize-only 分支（`test/live.test.mjs:639-703`）。

### 疑似

- 无。

## 2. MODE_HEADROOM 数值与回退退化

### 已确认

- **`$0.60 → $5` 明确退化已修。** `low` bar 已为 `$1.5`，且 `choose()` 额外取 `max(mode headroom, $1 start gate)`（`lib/ledger.js:63-75`；`lib/accounts.js:209-218`）；原反例已直接回归覆盖 low/medium（`test/accounts.test.mjs:512-530`）。
- **新值中只有 medium 有较强证据，且注释略有过度。** medium 的依据是一次 27-turn 约 `$4.1`，代码却取 `$4`，严格说仍低于已观测 burn，不是“足够完成”的保守值（`lib/ledger.js:55-70`）。low `$1.5` 只由 `$1` 中途门槛外加 `$0.5` 缓冲构成；high `$6`、ultra `$10` 没有本仓库 mode-specific 花费样本。因此 1.5/4/6/10 可作为**排序策略值**，不能称为四档 measured finish budget（`lib/ledger.js:55-75`）。
- **所有号低于新 bar 时不会拒绝，且回退现已选 measured healthy 中最富者。** tier1 仍按配置顺序立即返回；无 tier1 时，`remaining >= $1` 的 healthy 取最大余额（`lib/accounts.js:336-353`）。medium `$1.01,$3.99` 现选 `$3.99`，并有专门反例测试；两名 tier1 则继续按配置顺序，策略也有测试锁定（`test/accounts.test.mjs:439-487`）。因此上一版“新 bar 下首个低余额回退”的退化已消除。
- **`assumed $5` 的相对位置仍有张力，但实现有意且已测试。** assumed 不参与 tier1；任何 measured `$1+` healthy 都优先于 guessed `$5`（`lib/accounts.js:241-284,339-354`）。所以 medium `$1.20 confirmed` 会压过 `$5 assumed`，而 high/ultra 的新 bar 又让普通 `$5` assumed 永远不可能成为“可完赛”候选。该信任策略已由测试锁住（`test/accounts.test.mjs:555-573`），并非未察觉退化；代价是“未观测即真新号”若可靠，会牺牲完赛概率。
- **fail-open 的最差回退仍成立。** measured healthy → assumed → mode-floor acceptable → unknown amount → 最大 below-floor → unreadable（`lib/accounts.js:350-379`）；因此提高 bar 不会制造“有号却不派”的新硬门。

### 疑似

- high/ultra 的 `$6/$10` 是否更安全或只是让 tier1 常年空缺，缺少真实 run 前后余额数据；尤其默认新号只有 `$5`（`lib/ledger.js:24-25,63-70`）。在补数据前只能标“保守占位”。

## 3. REVIEW-f26 §6 测试缺口逐条验收

### 已确认

1. **已覆盖** `headroomForMode maps all four modes and unknown defaults to medium`：锁定整表、四 mode 映射及未知回退（`test/accounts.test.mjs:532-537`）。
2. **已覆盖** `low headroom must not let $0.60 preempt a later $5 account`：原退化输入直接覆盖 low/medium（`test/accounts.test.mjs:512-530`）。
3. **已覆盖** `values exactly at and just below headroom enter different tiers`：medium/high/ultra 覆盖 `bar` 与 `bar-$0.01`（`test/accounts.test.mjs:539-553`）。low 精确 `$1.50` 边界仍没有同款用例，但不属于上一轮明确列出的三档。
4. **已覆盖** `healthy versus assumed follows the documented trust policy`：`$1.20 confirmed` 明确压过 `$5 assumed`（`test/accounts.test.mjs:555-573`）。
5. **已覆盖** `pairwise fallback order ...`：新增相邻 tier 判别用例锁住 low acceptable > unknown amount、medium unknown amount > known below-floor（`test/accounts.test.mjs:489-510`）；再结合 assumed > tiny（`test/accounts.test.mjs:575-592`）和 below-floor > unreadable（`test/accounts.test.mjs:309-323`），完整链已闭合。
6. **已覆盖（结构性）** `provider and live propagate requested mode into choose`：测试要求两个入口源码含 `.choose({ mode })`（`test/accounts.test.mjs:594-601`），真实调用点也匹配（`lib/index.js:230-232`；`lib/live.js:213-216`）。

**仍未覆盖项的最小补测：**

- `terminal outcome: completed process with assistant output and unproven quiescence is not resumable`（`test/live.test.mjs`）：先推 assistant text，再 success result + exit 0 + 两次 `waitForExit(false)`；断言整体降级但无 `resumable=true`。它能抓当前 `status failed` 被误当“工作失败”的次生谓词漏洞（`lib/live.js:435-454,884-893`）。
- `terminal outcome: finalize-only failure names artifactError on both surfaces`（`test/live.test.mjs`）：让 finalize 单独失败，断言 partial、无 resumable、job detail 与 stop 都展示原因（`lib/live.js:608-620,890-896,1138-1160`）。
- 可选低成本边界：`F26: low exactly at $1.50 clears headroom and $1.49 does not`，补齐四档同形阈值测试（当前仅 medium/high/ultra：`test/accounts.test.mjs:539-553`）。

### 疑似

- 无。

## 4. AMP-LIMITS / USABLE 证据与边界复核

### 已确认

- **本轮四个重点边界有三项已诚实落文档。** 并发无 reservation 与实现吻合（`docs/USABLE.md:23`；`lib/accounts.js:209-250,397-400`）；artifact 无清理与固定 root/全目录 list 吻合（`docs/USABLE.md:24`；`lib/artifact.js:21-24,73-84`）；`drift` 不能证明重启、必须比运行时 hash 的边界也正确（`docs/USABLE.md:26`；`lib/live.js:61-73`；`deploy.sh:68-83`）。
- **spill 边界只写对一半。** one-shot 确实只解析内存 `read.text`，lossy 时仅声称完整流在 spill，未返回或读取路径（`docs/USABLE.md:25`；`lib/index.js:160-164,374-378,419-427`）。但“live 路径无损”无证据且与实现相反：live 只记录 `lossy/spillPath`，artifact 仅 append `readFrom` 返回的 tail，gap 没从 spill 补回（`lib/live.js:230-237,289-298`；DSH 合同 `$HOME/work/repos/deepseek-harness/packages/subprocess/subprocess/src/types.ts:121-148`）。
- **`AMP-LIMITS` 仍有陈旧/无证据强化：**
  - #1 只测得 medium 在 `$0.90` 拒绝、low 接受，却继续把 high/ultra `$1` 写成实测门槛（`docs/AMP-LIMITS.md:7`；`docs/reviews/REVIEW-design.md:62,131-140`）。
  - #4 的实现值仍写旧 `{0.5,3,5,8}`，当前代码已是 `{1.5,4,6,10}`；并把策略 bar 称“够跑完”，但 medium `$4` 低于文档自己的 `$4.1` 个案（`docs/AMP-LIMITS.md:10`；`lib/ledger.js:55-75`）。
  - #5 只有“真机（00:5x）”、#6 只有“两次实测”，没有 artifact/log 路径；它们是二手操作记录，不是可复核证据（`docs/AMP-LIMITS.md:11-12`；二手记录在 `docs/reviews/REVIEW-design.md:133,140`）。#6 的“需 TTY”还把“已试非 TTY 失败”错误提升为 TTY 充分条件。
  - #7 给了未纳入仓库的 npm 声明行号，却无源码证据支撑“SDK 只是 CLI 包装”（`docs/AMP-LIMITS.md:13`）。
  - #9 把官方 “Enterprise 有 higher quotas/rate limits”强化成“更高资源配额与限流只属于 Enterprise”，且把本部署 `$5 credits → 会限流` 写成官方推论（`docs/AMP-LIMITS.md:15`；上一轮已核官方边界：`REVIEW-f26.md:45`）。
  - #10 的当前 73 refs 可由配置核验，但“今日 65→73”无版本快照；7/8“全新”也把未观测当成远端未消费事实（`docs/AMP-LIMITS.md:16`；assumption 的真实合同仅在 `lib/ledger.js:4-8,24-25`）。
- **#2/#8 的证据路径现在真实存在，但证据强度不同。** netcap DB 路径存在，文档仍未保存能重放“72 条全为 200/201/101”的具体查询/结果，因此 #2 仍是外部可查、仓库不可复核的操作记录（`docs/AMP-LIMITS.md:8`）。#8 指向的 artifact 存在、约 1.76MB，末尾确有 `num_turns=23` 和 Compaction failed；但标题“长上下文会触发”仍把一次个案写成一般规律，应改“一次长上下文 run 曾触发”（`docs/AMP-LIMITS.md:14`）。
- **未知项仍漏 F26 决策所需数据。** 当前只列配额桶、`$1` 来源和另一 runner 是否共享（`docs/AMP-LIMITS.md:18-22`），仍未列 low 完赛花费、high/ultra 启动 floor 与花费分布、任务长度/工具调用的 spend 方差、未观测账号是否可能已被别处消费，以及 credits/tier purse 是否同规则（对应实现假设：`lib/ledger.js:40-75,90-100`）。
- **`USABLE` 仍有互相矛盾或无证据声明：**
  - “Amp 没有轮级打断”与“continue 需 TTY”都强于证据；只能说当前插件/已试非 TTY 路径不可用（`docs/USABLE.md:19-20`；`docs/reviews/REVIEW-design.md:133,140`）。
  - 部署段称“重启后零成本核对”，但 live hash 要调用会实际启动 agent 的 `amp_run`（`docs/USABLE.md:38-44`；`lib/live.js:775-820`）。
  - 测试数已更新为当前实跑的 104/104，两处一致（`docs/USABLE.md:33-40,55-58`）；这一项已闭环。
  - `:26`/`:52-53` 已正确否定 drift 判重启，`:59` 却仍让用户用 `--check + source.drift` 判断待生效，内部矛盾（`docs/USABLE.md:26,52-59`）。
  - “低于 MODE_HEADROOM 会被跳过”不符 fail-open；实际无更好候选仍派发。“high/ultra 更高”也没有实测支撑（`docs/USABLE.md:85`；`lib/accounts.js:339-381`；`lib/ledger.js:55-75`）。
  - `interrupted:true` 并不总能精确代表宿主中断：checkpoint 损坏返回 `{ok:false}`，当前映射仍会误标 checkpoint ok + interrupted（`docs/USABLE.md:87`；`lib/artifact.js:87-96`；`lib/live.js:1264-1295`）。

### 疑似

- #3 的“≈60 秒”倒数有二手记录，但“按账号”缺少同窗口另一账号对照；可暂列观测，不应称稳定机制（`docs/AMP-LIMITS.md:9`）。

## 5. REVIEW-full 高危项排序

### 已确认

按“只修一件”的顺序（严格对照 `REVIEW-full.md:33-56`，剔除已关闭的双真源、artifact 写失败漏记，以及本轮已确认关闭项）：

1. **`amp_runs` 错误降级仍会坏掉或撒谎（原 #4）。** `list()` 失败返回对象，调用方仍直接 spread，触发次生 TypeError；损坏 checkpoint 返回 `{ok:false,error}`，调用方仍判 `checkpoint:'ok'`、`interrupted:true`（`lib/artifact.js:73-96`；`lib/live.js:1252-1297`）。这是救援入口在磁盘/权限/损坏事故时恰好不可用；若严格只修一件，先修它，改动小且直接保护核心“崩溃后捞成果”承诺。
2. **spill 恢复链仍断（原 #9）。** one-shot/live 都会拿到 `spillPath`，但不读回缺口；one-shot/stop 还声称 “complete stream in spill file” 却不返回路径（`lib/index.js:160-164,374-378,419-427`；`lib/live.js:230-237,358-363,1120`）。大输出会丢协议/结果，且诊断过度承诺。
3. **并发选号无 reservation（原 #6）。** `choose()` 多次 await 后直接返回，`noteDispatch()` 仅写 runs，不参与选择（`lib/accounts.js:209-250,336-352,397-400`；`lib/ledger.js:169-175`）。两个并发 run 可同撞最佳账号，放大 credits/rate-limit 失败。
4. **live settings 仍非 live（原 #8）。** agent 行只在 apply 时读一次 settings 并传固定 resolved（`lib/live-plugin.js:17-29`）；账号 refs 因共享 pool 会更新，但 `ampBin/visibility/keepThreads/timeout/modes` 仍需 remount 才变。
5. **prompt 截断已 fail-loud，但 byte 合同仍错（原 #3，部分修）。** 现在会拒绝而非静默执行半任务，这是实质闭环；但常量叫 BYTES，判断和发送仍用 JS code units，非 ASCII prompt 可实际超过 1MiB UTF-8（`lib/index.js:78-80,338-363`；测试只覆盖 ASCII：`test/provider.test.mjs:123-132`）。
6. **多 host ledger clobber 仍在（原 #10，低）。** 每进程读一份全量 state，每次整文件 rename；共享 `DSH_HOME` 时 last-writer-wins（`lib/ledger.js:102-125,148-175`）。文档已把单-writer 边界说出（`docs/USABLE.md:27`），故不是单-host 首修项。

**已关闭，不应重复修：** 设置页 next account 已改由服务端 pool 按 mode 计算并有路由测试（原 #5；`lib/web.js:42-61,100-116`；`test/web.test.mjs:119-145`）；live 成功后已 fire-and-forget refresh（原 #7；`lib/live.js:592-603`）。

**范围外但生产优先级高：** `REVIEW-full.md:86-90` 的 artifact 无限增长、spawn-before-job-admission、同步 live disposer 仍在（`lib/artifact.js:21-24,73-84`；`lib/live.js:198-208,917-947`）。若排序目标从“修 `:33-56` 的真缺陷”改为“长期生产风险”，artifact 保留期/总字节预算应升到第一，因为增长必然发生；资源所有权紧随其后。

### 疑似

- **原 #11 取决于信任模型。** `amp_runs` 仍不检查 caller，也不持久化 owner，会跨 session 返回 account/thread/lastText/本机路径（`lib/live.js:1222-1235,1245-1297`）。本机所有 agent 若同一信任域，这是有意 rescue 面；若 session 需要读隔离，则是元数据泄漏。

## 验证

- 已实跑 `bash test/run.sh`：**104 tests / 104 pass / 0 fail**。runner 使用临时 harness、复制当前 `lib`/tests，并将 `DSH_HOME` 指向临时目录，不写真实 ledger（`test/run.sh:3-15,38-53`）。本轮测试运行期间并发编辑新增了 F26 fallback/tier1 与 terminal degradation 用例，因此报告已在测试后重读当前代码并修订，不沿用开场的 91 条快照。
- 未发起 Amp agent、未重跑额度型真机实验；外部 netcap DB 与 compaction artifact 仅做只读存在性/目标错误核对。除本报告外，本审查未修改或新建任何文件。

## 摘要（≤250 字）

双真源、partial 降级和 quiescence 告警已闭环；但“进程成功＋有输出＋未证实停稳”仍会误给 resumable。F26 的 `$0.60→$5` 回归、最富回退及 §6 六项缺口已覆盖，104/104 全绿；1.5/4/6/10 仍是策略值，high/ultra 无实测。文档仍有旧 headroom、live 无损、零成本 live hash 等过度声明。只修一件：先修 `amp_runs` 错误降级。**现在可受控 dogfood，不能算稳定生产可用。**
