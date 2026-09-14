# REVIEW-final：6 份评审高危项终审

> 方法：只读 6 份 REVIEW 的"高危"段落，对每条用 grep + 定向几十行复核当前 `lib/`；实跑 `bash test/run.sh` 一次：**132/132 通过**。行号为今日快照，若 `lib/` 继续被并发编辑会漂移。

## 1. 判决

**还有 1 条未修**：`timer` 缺失时 sweeper/observer 整段静默跳过，无人轮询的 run 可能永远收不到任何通知（REVIEW-notice §6 的"高危条件缺口"，最小修法"fail loud 或宿主 interval"未落地）。另有 1 条已降级为已知边界但残余仍在：jobs 真实 preflight 仍发生在 spawn 之后（拒绝只保证 prompt 未投递 + 进程停稳，不保证"拒绝前无执行资源"）。其余全部高危已修或有测试锚定。

## 2. 逐条高危表

| 评审来源 | 高危内容 | 现状 | 依据 |
|---|---|---|---|
| REVIEW-full 高危1 | 终态双真源，job 与 `amp_stop` 可对同一 run 给出相反结论 | **已修** | `terminalOutcome` 唯一构造 `lib/live.js:439-471`；结算+finalize 后只算一次 `:633`/`:659`；job 投影 `:900`、stop 投影 `:1230-1232` |
| REVIEW-full 高危2 | artifact 部分写/中途失败仍最终报成功 | **已修** | `noteArtifactWrite` `lib/live.js:484-487`，接入 `:305/:312/:491/:847`；`durability` `:450-457`，partial/quiescence 降级 failed `:457`；resumable 排除残缺 `:936` |
| REVIEW-f26 §1（高） | `low` headroom `$0.5` 让 `$0.60` 压过后置 `$5`（退化输入） | **已修** | `lib/ledger.js:73` `low: 1.5`（注释自述原因）；`headroomForMode` `:76-77`；回归测试由 REVIEW-f26b §3.2 验收（`test/accounts.test.mjs:512-530`） |
| REVIEW-f26 §4（高） | `USABLE.md` 边界清单漏掉"成功可能不可信"等核心限制 | **已修** | `docs/USABLE.md:19`（"不是绝对保证……durability=partial、lossy 不回补、保留策略后才可救援"）；已知边界清单 `:21-30` |
| REVIEW-notice §2（高危） | 轮末 `followup` 绕过预算，可无限自激开 parent turn | **已修（有界）** | `MAX_TURN_NOTICES=3` `lib/live.js:392`，预算检查 `:398-400`。残余：按 session 计数而非评审建议的 per-Agent WeakMap，且 `test/` 对 `turnNotices` 零命中——有界性**无判别测试**（疑似弱化，非未修） |
| REVIEW-notice §7（高危） | 改动 C 过宽：completed/killed 也标 `resumable=true`，诱发重复工作 | **已修** | `lib/live.js:936` 要求 `failed && assistantMessages>0 && artifactPath && durability==='complete' && quiescenceUnproven!==true`；quiescence 时的 next-action 条件化 `:941`/`:955` |
| REVIEW-notice §6（高危条件缺口） | 无 `timer` 时 observer/sweeper 不注册：轮末通知、terminal 通知、20 分钟回收全部永不发生 | **未修** | `lib/live.js:1443` `if (timer !== undefined …)` 静默跳过；grep 全仓库无 warn/fail-loud、无测试、`docs/` 无此边界（`lib/live-plugin.js`/`lib/index.js` 均不校验 timer） |
| REVIEW-round7 §5（唯一高危） | job admission 晚于 spawn：拒绝时 child 已启动、已开 thread | **已降级为已知边界（部分修）** | prompt 投递移到 `jobs.start` 之后 `lib/live.js:1011-1016`；无 jobs 服务 spawn 前 fail-closed `:748-757`；拒绝分支 `await finish` + 诚实停稳文案 `:993-1007`；`docs/AMP-LIMITS.md:19` #11 netcap 实测"无 prompt 不做模型工作"。残余：真实 preflight 仍在 `jobs.start` `:981`，spawn 在 `:759`——被拒时 child 进程确实已存在（遗留一个无推理的 thread） |
| REVIEW-round7 §1（新裂缝，round7 §5 列为中危首项） | `retryable` 不查 quiescence，同一 notice 可既说"可重跑"又说"孤儿可能还活着" | **已修** | `lib/live.js:929-930`（retryable 要求 quiescence 已证）、`:936`（resumable 同门槛），两标签互斥 |

## 3. "声称修好但实际没修"检查

- **未发现背景摘要所列五项处置中有虚报**：终态唯一 `terminalOutcome`、`noteArtifactWrite`+`durability`+降级 failed、`amp_runs` 的 store 错误形状与 UNKNOWN（`lib/live.js:1371-1376` 抛原始 store 错误、`:1402-1420` `checkpoint:'unreadable'` + `interrupted` 不设值）、保留策略只删 `finished===true`（`lib/artifact.js:84-91`，unfinished/corrupt/missing 进不了候选）、prompt 后置与 #11 文档——逐条与当前代码一致。
- **最接近"虚报"的一条**：`timer` 缺失通知缺口（表内第 7 行）。它不在背景的"已处置"清单里，但作为 REVIEW-notice 明确标"高危"的条件缺口，至今零处置、零文档披露——是本次唯一真正的未修高危。
- **弱声明一条**：轮末唤醒预算"已修"但无任何测试锁定（`grep turnNotices test/` 零命中），且实现比评审处方（per-Agent WeakMap + user 输入重置）更粗（per-session 永不重置）。行为有界、偏保守，不算错修，但回归无保护。

## 附：验证

- `bash test/run.sh`：`tests 132 / pass 132`（2026-09-14 实跑）。
- 除本文件外未改动任何文件；未发起 agent 运行。
