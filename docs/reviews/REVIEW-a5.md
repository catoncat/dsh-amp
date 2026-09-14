# REVIEW-a5 — 点 1 审查：账号池垄断修复 + A5 持续落盘

审查时间：2026-09-13 · 审查者：Amp 代码审查子代理（只读）
范围：`lib/accounts.js`、`lib/artifact.js`、`lib/live.js`、`lib/ledger.js`、`lib/outcome.js`、`test/*`。
基线事实：`bash test/run.sh` 实跑 **59 条全过**（任务描述说 52，代码在审查期间继续前移，A1/jobs 也已接线）。
行号基于 md5 `cb638a31d046978f9535b33c1e40e67e` 的 `lib/live.js`。

## 1. 垄断修复的正确性

**已确认**

- 主干正确：候选顺序 confirmed ≥ floor（accounts.js:274）> below-floor fallback（275）> unreadable 兜底（289-292），四个新测试锚定（test/accounts.test.mjs:179、197、208、220）。
- **probes 计数无漏洞**：no-token（:218）与 cooling（:221-224）分支都在 probe 检查（:230）之前 `continue`，不消耗预算；`probes += 1`（:234）先于 `readOne`，失败的探测也计入——合理，失败的读同样花一次远程往返。
- **半修复（真实缺陷）**：accounts.js:248-251 —— 远程读**成功**但解析不出钱（`remaining === undefined`）仍然 **eager return**。该号在 ledger 里被存成 `remaining: undefined, readable: false`（ledger.js:100-117），下次 `choose()` 的 `ledger.remaining()` 仍返回 undefined（ledger.js:71-78），再次走 probe 分支、再次 eager return。**"垄断派发 + 每次白付一次远程读"的原病灶对这一类号原样保留**，只是触发面从"读失败"缩到"解析失败"——而解析失败恰是 `parseUsage` 自己文档化的上游改词场景（accounts.js:67-83：一个上游措辞变化即可让全池落入此分支）。修法：:250 不 return，把该号记为 `unparseable` 候选（并入 unreadable 语义）后 `continue`。
- **比修前更差的输入（有意取舍，但代价未被记录）**：refs 顺序 `[LOW(ledger $0.50, fresh), RICH(读失败)]` 时，修前派 RICH（fail-open 立即返回），修后派 LOW（fallback 优先于 unreadable，:275 vs :289）。若 RICH 实际余额充足，一个 medium 任务会在 LOW 上被拒（"must have at least $1"）——**修前能启动的任务修后启动不了**。test/accounts.test.mjs:220 把这个优先级定为意图，但没有记录这个失败方向。
- **报错误导（确认）**：预算耗尽的号记 `not read (probe budget spent)`（:231），但最终抛错的总结句断言 "every configured account is empty, throttled, or unreadable"（:305-306）。没探测 ≠ empty ≠ unreadable。可构造：3 个已知 $0 的号 + 第 4 个从未观测 → 报错谎称"全部为空"。修法：预算耗尽的 ref 也记为兜底候选（state `'unprobed'`），或至少把总结句改为 "…or could not be probed"。

## 2. A5 的完整性

**已确认**

- stdout 主干完整：`absorb()` 先 append 原始 delta 再解析（live.js:259），非 JSON 行、跨 chunk 半行（字节已随 delta 落盘）都覆盖；初始 prompt 也落盘（:579）。
- **stderr 不进 artifact**：live.js:260-263 只进 `session.stderrTail`（截 800、sanitize），且 `checkpointFacts`（:307-316）不含它。stderr 只活在 amp_send_message/amp_stop 的当场输出里，session 被 sweeper 回收（:866-871）或宿主重启后**永久丢失**。
- **lossy 缺口**：`readNew` lossy（:219）时 reader 内存窗口滑出的字节从未进 artifact；完整流在 spill 文件（:500，32MB），但 `spillPath` 与 `lossy` 都不进 checkpoint。更糟：`readOutput` 还向模型断言 "the artifact holds the whole stream"（:668）——lossy 时是假话。用户/下一个 agent **无从知道 stream.log 有洞**，只会把它当完整事实去恢复。
- **steer 消息不进 artifact**：live.js:757 写入子进程的后续用户消息不 append。stream.log 里只有子进程的回应、没有用户后半段的 steer/追问，会话记录不可复原。
- 次要：`checkpointFacts.bytesSeen` 用 `session.offset`（:312）而非 `handle.bytes`；append 失败（磁盘满）时 checkpoint 会声称比实际落盘更多的字节。

## 3. A5 的可用性（事后救援）

**已确认**

- **`artifacts.list()` 与 `readCheckpoint()` 没有任何工具暴露**。grep `lib/{live,index,web}.js`，artifact store 只在 live.js:419 被 `finalize` 引用。`amp_run`/`amp_stop`/完成通知都带路径，但 run 结束后 session 被 sweeper 回收（:866-871），宿主重启后 `sessions` map 为空，**新 agent 没有任何途径发现 runId**。
- 人类的救援路径只有：知道并手 `ls ~/.dsh/state/dsh-amp/runs/`（artifact.js:20-23）。能救，但没写进任何工具描述。
- **runId 复用使重启后救援更糟（高危）**：live.js:181 `seq` 从 0 起，:478 `runId = dsh-amp-run-<seq>`。宿主重启后新的 run-1 会 `open` 到上一个 run-1 的**同一目录**（O_APPEND 追加，artifact.js:105-107），首次 `saveCheckpoint` 就把崩溃 run 的 checkpoint.json **原子覆盖掉**。27 轮事故后重启宿主，恢复事实即被抹掉、stream.log 被混写。test/artifact.test.mjs:86 的 "resume" 用例把这一碰撞固化成了特性。
- **最小实现建议**：在 agent 行注册 `amp_runs` 工具（与 amp_accounts 同级）：
  - 无参：`artifacts.list()` 逐个 `readCheckpoint(runId)`，返回 `{runId, mode, account, threadId, finished, lastText(前200), artifactPath}`；
  - `{run}`：返回完整 checkpoint + streamPath。
  同时：runId 加 uuid/时间戳后缀杜绝复用；`amp_run` 的 note 补一句 "artifacts survive restarts; amp_runs lists them"。

## 4. 磁盘与清理

- 默认 `<root>`：`~/.dsh/state/dsh-amp/runs/`（artifact.js:20-23，`DSH_HOME` 可改），与 ledger.json 同级，目录约定一致。
- **无任何清理**：`rmSync` 只用于 checkpoint tmp 文件；stream.log 每 run 无界增长，完结 run 的目录永不删。
- 建议（不违背"绝不丢成果"）：复用 sweeper 的 `timer.interval`（live.js:855-880）加一段——只删满足 `readCheckpoint(runId).finished === true`（经 finalize 确认完结）且目录 mtime 超 N 天（建议 14d）的 run；总大小封顶（如 512MB）时 LRU 删最旧的**完结** run；**checkpoint 无 `finished` 的 run 永不自动删**；删除动作同时经 `amp_runs` 工具暴露给人类显式触发。

## 5. finalize 路径的三种异常

**已确认**

1. `open()` 失败（live.js:569-575）：`artifactError` 记录，`amp_run` 返回 `'unavailable (...)'`（:597），run 照常进行但**全程无落盘**——回到事故前状态；好在如实报告。可考虑的最小兜底是把 prompt 写到一个固定失败文件，避免"跑了什么都没留"。
2. 子进程在 `finish()` 前自行崩溃（宿主活着）：`handle.done` → `onExit` → `finish(false)`（:611-617）→ absorb + finalize，checkpoint 带 `finished: true`（:419-424）。已覆盖。
3. `finalize` 前宿主被 kill：目录留下 stream.log（prompt + 已吸收字节；OS 回收 fd 后对其他进程可见，仅掉电会丢尾部——append 路径无 fsync，finalize 才 fsync）和最后一次转移时的 checkpoint。**checkpoint 里没有 `finished` 字段**（`checkpointFacts` :307-316 不含，只有 finalize 的 extra 有）——"未正常结束"只能靠 `finished !== true` 隐式推断，对下一个 agent 不够显式。SIGKILL 落在 checkpoint 写 tmp 与 rename 之间会留 `checkpoint.json.tmp-*` 残骸（无害但添噪）。建议：`checkpointFacts` 显式加 `finished: false`。

## 6. 测试缺口（最小补测清单）

现有 59 条未覆盖、且当前代码**会挂**的（即驱动修复的）：

1. `accounts`: `a successful reading that parses no money must not monopolize dispatch`（§1 半修复）。
2. `accounts`: `the all-dry error does not claim unprobed accounts are empty`（§1 报错误导）。
3. `accounts`: `cooling and token-less refs do not consume the probe budget`。
4. `live`: `steering messages land in the artifact stream`（§2）。
5. `live`: `stderr reaches the artifact or the checkpoint`（§2）。
6. `live`: `a lossy stream is marked in the checkpoint`（§2）。
7. `live`: `a run that never finalizes leaves a checkpoint that says so`（§5.3，`finished: false`）。
8. `live`: `a restarted host does not append into a dead run's artifact`（§3 runId 复用）。

现有 59 条未覆盖、当前行为正确的锚定测试（防回归，选补）：

9. `artifact`: finalize 前崩溃（close 未调）后，另一 store 进程能从磁盘读到 stream.log 与最后的 checkpoint。
10. `accounts`: budget-spent 的 ref 仍可作为兜底候选（若采纳 §1 修法）。

## 7. 更简单的做法

- **部分存在**：spill 机制已把完整 stdout 流写盘（live.js:500，`STDOUT_SPILL_BYTES` 32MB）。若把 spill 落点指到 run 目录，`absorb` 的逐 delta append 可以省去（补一行 prompt），磁盘上也只有一份完整流。代价：spill 路径归 subprocess collector 管、stderr/checkpoint 仍需自建逻辑。值得评估，不必为此重构。
- **dsh-jobs 不能替代**：job 记录与 `readOutput` 游标都在进程内存，宿主重启即失——恰是 A5 要防的场景。runs 目录放 `state/dsh-amp/` 与 ledger 同级、无新依赖，自建目录是对的。

## 结论摘要

最关键三条：

1. **垄断修复只修了一半**：读成功但解析不出钱的号仍 eager return（accounts.js:248-251）并每次重付探测，上游改词即可全池复发；且报错会把"没探测"说成"全部为空"（:305-306）。
2. **runId 复用会摧毁恢复事实**：宿主重启后 run-1 追加进旧 run-1 目录、覆盖其 checkpoint（live.js:181/478 + artifact.js:105）——恰好发生在最需要 artifact 的崩溃之后。
3. **artifact 有未被标记的洞**：stderr、steer 消息、lossy 滑出的字节都不在 stream.log，checkpoint 也不标记 lossy/spillPath；`readOutput` 还向模型断言 "artifact holds the whole stream"（live.js:668）。

**这个点能不能算改对了**：方向对、主干对（候选顺序、probe 预算、append-before-parse、原子 checkpoint、finalize 幂等都有测试锚定），但垄断修了读失败没修解析失败、重启后 artifact 会被复用的 runId 污染、事后救援没有任何工具入口——这三处补上之前，只能算"改对了一半"。
