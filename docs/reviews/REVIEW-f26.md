# F26 与可用性文档审查

> 状态：审查中。结论分为「已确认」与「疑似」，所有结论附文件与行号。

## 1. 四层排序与回退行为

### 已确认

- **高：`low` 存在明确退化输入。** `headroomForMode('low')` 是 `$0.5`（`lib/ledger.js:63-68`），而扫描遇到 `remaining >= headroom` 会立即返回（`lib/accounts.js:334-338`）。因此 refs 顺序为「已确认 `$0.60`、已确认 `$5.00`」时，新实现选 `$0.60`；改动前的 `$1` 偏好会继续扫描并选 `$5.00`。这不只是理论问题：`headroom` 被描述为“够跑完”，但仓库只有 `$0.90` **能起跑**的证据（`lib/ledger.js:40-46`），没有 `$0.50` 能跑完的证据。最小修正是把 low headroom 至少设为 `$1`，或只对 `remaining >= max(headroom, MIN_START_CREDITS)` 立即返回。
- 实际返回优先级是：首个 tier1（立即返回）→ 首个 `healthy`（`>= $1`）→ 首个 `assumed` → 首个模式下限以上 → `unknownAmount` → 已知低余额最大者 → `unreadable`（`lib/accounts.js:337-375`）。符合需求文字，但 tier1 内不按余额最大值排序，只按 ref 顺序；这是既有“顺序优先”策略，不应称为全局余额排序。
- `healthy` 排在 `assumed` 前是一种可解释的保守取舍：healthy 是本轮确认或十分钟内 ledger 读数（`lib/accounts.js:128-134,262-329`），assumed 只是“从未观测即 `$5`”的部署假设（`lib/accounts.js:268-280`）。它降低 ledger 被重置、账号被别处消费时误信 `$5` 的风险。
- 但该顺序与 F26 的首要目标“尽量跑完”冲突：已确认 `$1.01` 的 medium 会压过 assumed `$5`（`lib/accounts.js:339-349`），正会复现“能起跑、跑不完”。若这 73 个 ref 确实只由本插件消费，建议改成 **tier1 confirmed → assumed `$5` → healthy**；预期完成率更高。若账号会被其他宿主/人工共用，维持现状更安全，因为 guessed `$5` 可能早已花完。

### 疑似

- “从未观测 = 新号 = `$5`”目前是本部署规则而非上游强保证（`lib/ledger.js:4-8,24-25`）。是否应把 assumed 提前，取决于“ledger 是否完整覆盖所有消费”这个未验证不变量；建议文档明确这一决策条件，而不是笼统写“读数总胜过猜测”。

## 2. headroom 数值依据

### 已确认

- **`low: 0.5` 依据不足且会误导。** `$0.90` 只证明 low 能开始，不证明 `$0.50/$0.60` 能完成长任务（`lib/ledger.js:40-46,63-68`）；是的，当前会把 `$0.60` 当“够跑完”并立即派发（`lib/accounts.js:337-338`）。更可辩护的临时值是 **low `$1`**：不会把起跑证据误当完赛证据，也保留“低于下限仍可 fallback”的非闸门语义。
- **`medium: 3` 只能算经验中位预算，不能算完赛保障。** 文档有两次样本：25 轮约 `$2.2`、27 轮约 `$4.1`（`docs/AMP-LIMITS.md:10`；`lib/ledger.js:55-61`）。`$3` 覆盖前者却不覆盖后者。若标签继续叫“够跑完”，临时值应取 **`$4.5`**（最大观测 `$4.1` 加约 10% 余量）；若保留 `$3`，应改称“典型任务预算”，并承认长任务仍可能中途耗尽。
- **`high: 5`、`ultra: 8` 没有本仓库实测花费依据。** 唯一花费样本都是 medium（`docs/AMP-LIMITS.md:10`）；代码注释却把整张表称为 measured（`lib/ledger.js:55-61`），属于把策略估值写成实测。`ultra: 8` 还高于普通新号 `$5` 授信（`lib/ledger.js:24-25,63-68`），意味着普通账号永远进不了 ultra tier1。
- 可辩护的取值规则应是“各 mode 最近 N 次成功 run 的 p90 花费 + 10% 安全余量，并受可用钱包上限约束”；在没有 high/ultra 样本前，`5/8` 只能标为**保守策略值**，不能声称实测。若必须今天定常量：`low=1, medium=4.5, high=5, ultra=8`，同时明确后两者是保守占位，且 ultra 需要 >`$8` 的 tier purse 才会被判定为可完赛。

### 疑似

- high/ultra 是否真的比 medium 贵、以及 `$8` 是否过保守，仓库没有数据，无法确认。真正风险不是“保守”本身（排序仍 fail-open），而是错误的“能跑完”标签会让运维误判成功概率。

## 3. `AMP-LIMITS.md` 逐条证据审计

### 已确认

| 条目 | 结论 | 仓库内证据审计 |
|---|---|---|
| 1 起跑门槛 | **部分支撑，表述过宽** | `$1` credits 文案有分类测试（`test/outcome.test.mjs:14-19`），同一 `$0.90` 上 low 接受、medium 拒绝在测试说明与历史评审中反复记录（`test/accounts.test.mjs:4-8`；`docs/reviews/REVIEW-design.md:62`）。但仓库没有三次真机原始日志；更重要的是只测了 **medium**，不能据此断言 high/ultra floor 都是 `$1`（`docs/AMP-LIMITS.md:7`；`lib/ledger.js:48-53`）。应写“已测 medium；high/ultra 暂按 `$1` 策略值”。 |
| 2 应用层限流 | **证据不足** | 仓库测试只锚定 CLI `rate-limit` 文案（`test/outcome.test.mjs:21-31`）；没有 netcap SQLite、72 条状态码统计或 WebSocket 帧。`docs/AMP-LIMITS.md:8` 的“72 条全 200/201/101、先建 thread 再 error_set”目前只有该文档自述，不能算仓库内可复核事实。 |
| 3 ≈60s 窗口 | **二手支撑，无原始抓包** | `57→41→25→10` 被代码注释和测试重述（`lib/accounts.js:435-438`；`test/accounts.test.mjs:364-383`），并确实驱动“不指数退避”的实现（`lib/accounts.js:426-440`）。但原始 6 条 `result.error` 不在仓库；“按账号”和“第 5 次重置”应标“本次抓包观测”，不要提升为稳定机制。 |
| 4 medium 花费 | **部分支撑** | `$4.1/27轮` 在历史评审中明确标为“本轮用户提供的新实测”（`docs/reviews/REVIEW-design.md:63,131`）；当前 ledger 能独立看到某账号 `$2.84`，但不保存起始 `$5` 或 run 级扣费轨迹（`lib/ledger.js:145-163`）。`$5→$2.84/25轮` 在仓库中没有前后快照，故应称“操作记录”，而非仓库可重放证据。 |
| 5 thread 账号作用域 | **二手支撑** | 历史评审明确记录“跨账号报不存在”，同时注明它采用当轮真机事实、未重跑（`docs/reviews/REVIEW-design.md:133,140`）。结论可保留，但证据栏应链接归档评审，而不是只写“真机”。 |
| 6 非交互 continue | **二手支撑** | 同一归档明确记录本地非 TTY `exit 1` 且未重跑（`docs/reviews/REVIEW-design.md:133,140`）。这支撑“不承诺续接”，但“需 TTY”比证据更强：当前只证明已试的非 TTY 路径失败，不证明 TTY 是充分条件。应改成“已试非 TTY 路径不可用”。 |
| 7 SDK continue | **支撑推断边界** | 归档将 SDK/CLI 续接列为未验证，并据此只允许 spike（`docs/reviews/REVIEW-design.md:6,90`）。类型声明行号是对当时安装包的具体证据，但包文件未纳入本仓库；“SDK 只是 CLI 包装”若无 SDK 源码引用，不宜作为事实。 |
| 8 压缩失败 | **错误地把合成测试当真机证据** | 测试只人工注入 `Compaction failed` 并设 23 轮，证明恢复判决，不证明上游在读约 1.6MB 后会如此（`test/live.test.mjs:523-537`）。仓库没有对应原始 run/日志；`docs/AMP-LIMITS.md:14` 的“23轮、~1.6MB”应标单次个案，不能暗示稳定阈值。 |
| 9 计费/免费层 | **官方证据成立，推论需拆开** | 2026-09-13 读取官方 Pricing/Free Agent：本地 runner 免费、BYOK/订阅无 Amp token fee/limit、购买 credits 12 个月过期、Enterprise 有 **higher** quotas/rate limits。`docs/AMP-LIMITS.md:15` 把“higher”写成“只有 Enterprise 才有配额与限流”不准确；其他层也可能有限，只是 Enterprise 更高。`每号 $5` 与“因此会限流”是本部署观测，不是两份官方文档的结论。 |
| 10 池规模 | **当前状态可核验，历史变化不可核验** | `settings.yaml` 当前确有 73 个 refs（`$DSH_HOME/settings.yaml:55-134`），ledger 当前 8 条读数也吻合 1~6 已消费、7/8 为 `$5` 的大意；但“今日 65→73”需要 Git/快照历史，本目录不是 Git 仓库，现有文档未提供差异证据。 |

- “未知”漏了直接影响 F26 的四项：**low 的真实启动下限与长任务花费；high/ultra 的启动 floor 与花费分布；任务长度/工具调用对 spend 的方差；从未观测账号是否必为未消费 `$5`（是否有其他 host/人工消费）**。另应列 credits 与 tier purse 是否共享相同 start floor/headroom 规则；当前只用两者较大值（`lib/ledger.js:87-97`），没有上游实验依据。
- 三个实验都可执行，但没有实验覆盖 F26 最关键未知。至少补：“每 mode 用短/中/长三档固定任务测前后余额与是否起跑”，以及“新加 ref 在 ledger 未见但 Amp 侧已消费时，assumed 策略如何表现”。

### 疑似

- #2 的“应用层而非 HTTP 429”可能确为抓包事实，但原始数据库不在仓库，无法核查状态码筛选是否覆盖所有相关请求；#3 的“按账号”也缺少同时对照另一账号的同窗口实验。

## 4. `USABLE.md` 边界与验收命令

### 已确认

- **高：边界清单漏掉两项“成功可能不可信”的核心限制。** 当前文档只列交互、限流、共享 ledger（`docs/USABLE.md:17-23`），却未披露 artifact 中途 append/checkpoint 失败的结果曾被忽略，以及 terminal outcome 风险。这正是 `REVIEW-full.md:41-42,84-90` 的首要生产边界。审查期间代码已新增唯一 `terminalOutcome`（`lib/live.js:405-435,588-601`），所以“双真源”主体已修；但 artifact 失败通知测试仍红（`test/live.test.mjs:639-655`），该限制仍必须写入。
- 至少还应列这些已确认日常边界：并发选号无 reservation（`REVIEW-full.md:49`）；one-shot prompt 静默截断（`:46`）；大输出 spill 不可恢复却称 complete（`:52`）；artifact 无保留期/磁盘预算（`:86-90`）；`amp_runs` 列表/checkpoint 错误降级不诚实（`:47`）；设置页仅 Web profile、live 配置不热更新（`:51,80`）；`amp_runs` 跨 session 可见的信任边界（`:57`）。不必把每个实现细节塞进首页，但“可能丢/误报成果、并发会撞同号、存储无限增长”不能省略。
- 对 `REVIEW-notice.md` 的上一批：`resumable` 已收窄到 failed（`lib/live.js:849-854`，且 completed 负例在 `test/live.test.mjs:574-586`）；waiting/terminal next action 已分离（`lib/live.js:380-387,861-863`）；每 run 轮末通知上限 3 已实现并测试（`lib/live.js:367-375`；`test/live.test.mjs:559-572`）；live 成功后已 refresh（`lib/live.js:560-570`）。这些旧缺陷不应再列为当前限制。
- `bash test/run.sh` 命令本身可行：runner 会找 DSH modules、复制到临时 harness，并隔离 `DSH_HOME`（`test/run.sh:17-53`）。但审查实跑已不是文档所写 86 条全绿：**89 条，88 过、1 失败**；失败为 artifact 不完整没有进入 job notice（`test/live.test.mjs:639-655`）。这反映用户并发编辑后的实时状态，`docs/USABLE.md:29,44` 的固定计数已过时。
- `bash deploy.sh --check` 可行且本次退出 0、报告 installed copy in sync；脚本逐个比较 `lib/*.js`，漂移时退出 1（`deploy.sh:68-84`）。它只证明**源码 = 安装副本**，不证明当前进程已加载该副本。
- `amp_accounts.source.modules` 字段真实存在：host 的 `SOURCE.modules` 为模块逐文件 hash（`lib/index.js:50-55`），挂到 pool source（`lib/index.js:497-505`）并由 `amp_accounts` 返回（`lib/live.js:1169-1177`）。但列表不含 `live.js`；live 行只能由 `amp_run.source.hash` 验证（`lib/live.js:923-929`），而 `amp_run` 会启动代理、并非 `docs/USABLE.md:34` 所说“零成本”。

### 疑似

- `USABLE.md:19` 写“Amp 没有轮级打断”与 `:20` 写“threads continue 需 TTY”都比证据强。仓库证据仅为插件未提供轮级打断、以及已试非 TTY continue 失败（`docs/reviews/REVIEW-design.md:133,140`）；建议改成“当前 CLI/插件未找到可用路径”。

## 5. 待生效批次与可发现性

### 已确认

- “deploy 后必须重启宿主”已明确写在部署步骤正下方（`docs/USABLE.md:25-40`），也由脚本首尾重复提示（`deploy.sh:5-19,120-122`）；这一点说清楚了。
- 但当前状态判断仍可能误报：`docs/USABLE.md:46` 说用 `deploy.sh --check + source.drift` 判断待生效。前者只比源码和磁盘安装副本（`deploy.sh:68-84`）；后者在模块加载时计算并缓存（`lib/index.js:501-505`，`lib/live.js:67-74`）。deploy 覆盖磁盘后、重启前，旧进程仍可返回部署前缓存的 `in-sync`。**可靠判据是把 deploy 输出的每文件 expected hash 与运行时 `source.modules/source.hash` 做值比较，而不是只看 drift 字符串。**
- 更易发现的最小方案：`deploy.sh` 生成/写入单一 `build-id` manifest；运行时响应同时给 `loadedBuildId` 与磁盘 `installedBuildId`，不等时直接 `restartRequired:true`。当前无 manifest 时，至少把 `USABLE.md:46` 改成“`--check` 只验磁盘；重启是否生效以 hash 与 deploy 输出一致为准”，并删除当前状态里的省略号哈希（`docs/USABLE.md:44`）。
- 若要保持“零成本”验收，应让 host 的 `amp_accounts` 同时暴露 host 与 live 安装文件的 expected hash，或增加不 spawn 的 `amp_build_info`。现状为验证 live loaded hash 必须调用 `amp_run`（`docs/USABLE.md:39`），会实际启动 Amp 并可能花 credits。

### 疑似

- 若 host/live 两行确实在同一模块缓存与同一进程生命周期内原子重启，host hash 可间接代表两者同时更新；仓库没有把这个部署不变量写成合同，因此不能用它替代 live build 指纹。

## 6. F26 测试缺口与最小补测清单

### 已确认

- 当前 F26 只有两个直接用例：medium 的 `$1.5 → $5` headroom 选择，以及无 headroom 时选择首个 startable（`test/accounts.test.mjs:423-453`）。它们锚定主干，但没有锚定完整优先级和阈值边界。
- 最小补测清单（建议测试名）：
  1. **`F26: headroomForMode maps all four modes and unknown defaults to medium`**——锁住 `0.5/3/5/8` 与未知 `3`（`lib/ledger.js:63-73`）；当前测试只测 `floorForMode`（`test/accounts.test.mjs:260-266`）。
  2. **`F26: low headroom must not let $0.60 preempt a later $5 account`**——这是能区分旧/新行为的回归用例；按当前实现会红（`lib/accounts.js:337-338`）。若产品坚持 `$0.5`，则测试名反向写明这是有意策略，但必须接受退化。
  3. **`F26: values exactly at and just below headroom enter different tiers`**——表驱动覆盖 medium/high/ultra 的 `threshold` 与 `threshold-0.01`，防 `>`/`>=` 漂移（`lib/accounts.js:337-346`）。
  4. **`F26: healthy versus assumed follows the documented trust policy`**——构造 `$1.2 confirmed` 与 probe-budget 后 `$5 assumed`，锁定到底是“读数优先”还是“完赛概率优先”（`lib/accounts.js:268-280,348-350`）。当前最关键的产品取舍没有测试。
  5. **`F26: pairwise fallback order is assumed > mode-floor > unknown-amount > best-below-floor > unreadable`**——可用表驱动的一条测试覆盖相邻 tier；现有测试只零散覆盖 measurable/unreadable 与 funded/unmeasurable（`test/accounts.test.mjs:179-208,268-323`），未锁完整链。
  6. **`F26: provider and live propagate requested mode into choose`**——避免池单测全绿但入口忘传 mode；两个调用点在 `lib/index.js:232`、`lib/live.js:216`，历史评审也已指出此缺口（`docs/reviews/REVIEW-round5.md:97`）。
- “无候选仍派最差号”的主要 fail-open 分支已有覆盖：below-floor 单号、unreadable 单号、unknown amount 单号（`test/accounts.test.mjs:90-103,196-208,286-295`）。不需要再堆同义测试；应优先补上面 6 条判别性用例。

### 疑似

- tier1 当前“首个满足即返回”而非“选余额最大”没有明确产品测试（`lib/accounts.js:337-338`）。若 ref 顺序本来承担轮转/消耗顺序，这是合理；若 F26 目标是最大化完赛率，则还应加 **`F26: among finishable accounts choose configured-first (not richest)`** 明确该策略，避免未来评审反复争论。

## 7. 仍存在的高危项与最终建议

### 已确认

- **高危 1（终态双真源）：结构性问题已修，不再是“两套真源”。** 当前 `finish()` 在所有 settle/finalize 尝试后只计算一次 `session.outcome`，再 resolve settled（`lib/live.js:588-601`）；job 与 `amp_stop` 都投影该 outcome（`lib/live.js:831-848,1122-1130`）。对应 completed/failed/killed 一致性测试已存在（`test/live.test.mjs:589-637`）。因此 `REVIEW-full.md:41` 的“双真源可互相矛盾”结论对当前并发编辑后的代码已过时。
- **但唯一真源的成功谓词仍不完整。** `terminalOutcome.completed` 只排除 killed/failure/settleError/坏 result/非零 exit（`lib/live.js:411-421`），没有排除 `artifactError`、`artifactWriteError` 或 `quiescenceUnproven`，虽然这些事实被附在 outcome（`:428-432`）。所以两表面现在会“一致地报 completed”，但 durable 记录可能不完整、进程范围可能未证实停稳。双真源修了，成功真实性只修了一半。
- **高危 2（artifact 部分写仍可报成功）：仍未完全修。** 当前已用 `noteArtifactWrite` 捕获 append/checkpoint 失败（`lib/live.js:275-316,439-452`），这是重要进展；job notice 也正在输出 `artifact=INCOMPLETE`（`lib/live.js:864-870`）。但 `completed` 不受该错误影响（`lib/live.js:413-421`），failed run 的 `resumable=true(work is on disk)` 也未排除不完整 artifact（`lib/live.js:861-870`），可同时给出“可恢复”和“不要信完整记录”的矛盾建议。因此 `REVIEW-full.md:42` 的核心风险仍在，只从“静默”降为“有告警”。
- 审查实跑曾捕获 **89 条中 1 条失败**：`a silently failing artifact write is REPORTED, not trusted` 的 job notice 缺 `artifact=INCOMPLETE`（`test/live.test.mjs:639-655`）。随后并发编辑已补上 notice 分支（`lib/live.js:868-870`），最终结果需以收尾重跑为准。
- **只修一件的最终建议：完善唯一 `terminalOutcome`，不要再改选号。** 将 `artifactWriteError/artifactError/quiescenceUnproven` 纳入统一 outcome 的 `durability`/`quiescence` 事实；至少禁止它们映射为无条件 `completed`，并让 `resumable` 仅在 artifact 完整时成立。这样同时完成 `REVIEW-full.md:41-42` 的剩余闭环；F26 即使估错仍 fail-open，而“丢了恢复事实却报成功”会破坏整个长任务救援承诺，优先级更高。

### 疑似

- 产品也可以定义“代理工作 completed，但 artifact incomplete”为正交状态，而不是把整体 status 强制 failed；这需要所有消费端显式展示 `completed + durability=partial`，且绝不能输出 `resumable=true(work is on disk)`。当前 schema/文档没有建立这份合同，因此暂不能视为已解决。

## 摘要（≤300 字）

F26 主干有效，但 `low:$0.5` 会让前置 `$0.60` 压过后置 `$5`，是明确退化；medium `$3` 也覆盖不了已记录 `$4.1` 长任务，high/ultra 仅是保守猜值。`AMP-LIMITS` 多条只有二手实测叙述，#2/#8 缺仓库原始证据；`USABLE` 漏了 artifact、并发选号、spill、存储增长等边界，且 `--check/drift` 不能证明已重启生效。终态双真源已修，但 artifact 不完整仍可报 completed/可恢复。**结论：F26 与两份文档可 dogfood，不足以算可信的稳定可用版。**
