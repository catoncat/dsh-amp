# dsh-amp 变更日志

每一批都遵循同一条纪律：**改 → 测试（含判别性用例）→ `deploy.sh` → 逐文件哈希核对（需重启）**。
"依据"列只写可复查的东西：测试名、真机 artifact、抓包、评审行号。

## 第 14 轮（本批，待重启生效）：第 8 轮 AMP 评审的 3 P1 + 7 P2 处置

> 依据：`docs/reviews/REVIEW-amp2-fixes.md`（0 P0/2 P1/5 P2，fixverify）、`docs/reviews/REVIEW-amp2-runtime.md`（0 P0/3 P1/3 P2，runtime2）。
> 分量最重的是**第 7 轮有三条没真正闭环**：#52（claim 回收）、#59（dispose 停稳）、#65（R10 判别测试）。

| # | 改动 | 依据 |
|---|---|---|
| 67 | **claim 从"按账号 ref 的布尔"改成"按 run 的租约"**：`inflight` 变成 `ref -> (token -> expiry)`，`choose()` 为每次选择铸一个 `claimToken`，`release(ref, token)` 只删自己那条；`noteSuccess`/`noteRefusal`/`refresh` 改为**只释放传入的 token**（不给 token 就什么都不释放）。修掉"fail-open 下 A 结束顺手把仍在跑的 B 的占号删掉" | runtime2 P1（它用真实 pool 复现第三次派发不再带 `already-claimed`）；测试 `AMP-G3`/`G3b`/`G3c` |
| 68 | **结算的释放与 finalize 移进真正的 `finally`**：`finish()` 拆成三段（teardown / 折叠+分类 / finalize），每段各自 contained，**无论哪段抛错**都执行 `release(token)` → `finished` → 重算 outcome → `markSettled()`。修掉"reader/absorb 抛错 → 号被占 30 分钟且记录没 finalize" | fixverify F1 + runtime2 P1（我第 7 轮把 release 写在 try 里，声明强于实现）；测试 `AMP-G1` |
| 69 | **one-shot `dispose()` 有界**：`waitForExit(AbortSignal.timeout(graceMs))`，返回 `false`（边界到期）时**抛错**说明 quiescence UNPROVEN。修掉"没有 signal 时可永久挂住" | fixverify F2；DSH `subprocess/src/types.ts:185-191`；测试 `AMP-G2` |
| 70 | **`alive` 改三态**：`false` 只在进程已退出或 `waitForExit` **证明**范围为空时给；`quiescenceUnproven` 时给 `null`，`statusOf` 同步显示 `finished (quiescence unproven — the process may still be alive)`。新增 `session.quiescenceProven` | runtime2 P1；测试 `AMP-G6` |
| 71 | **`limit:0 = all` 三层修好**：tool 始终传 `{limit}`（不再把 0 规范化成"省略"）、web 路由保留显式 0、client 的"显示全部"改调 `load(0,false)` | fixverify F3 + Lead 亲测；测试 `AMP-G4`（tool + 路由 + client 静态） |
| 72 | **`amp_runs` 同毫秒排序确定化**：`artifact.listDetailed()` 提供 mtime，排序键改为 `(epoch, mtimeMs, key)`；`runId` 仍是 artifact key，语义在注释里写明 | runtime2 P2；测试 `AMP-G7`（live）+ `AMP-G7`（artifact） |
| 73 | **空 prompt 在选号前拒绝**（live 与 one-shot 两条路径）：空指令不再 claim、spawn、记一次派发 | fixverify F5；测试 `AMP-G5` ×2 |
| 74 | **`run()` 抛错时的清理补全**：`terminate()` + **启动**有界 `waitForExit`（`run()` 必须同步返回 hooks，所以只能启动不能 await）+ finalize 已打开的 artifact（`finished:false`，不进 retention 可删集合）+ `markSettled` + 删 session | runtime2 P2（改判）；见代码注释 |
| 75 | **client 只读文案改实话**：宿主根本没挂 settings 时不再建议"重启后可用" | fixverify F6 |
| 76 | **补上 R10 的真正判别测试**：用手动 settlement gate 断言"范围未空之前 disposer **不得** resolve"；把 `await Promise.allSettled` 改回 `void` 会**变红**（第 7 轮那版不会） | runtime2 P2 + fixverify F4（两条独立变异都判它空壳）；测试 `AMP-R10` |

**测试**：151 → **164 条全绿**（新增 13 条回归 + 改写 1 条）。
**反向验证**：13 条新测试跑在第 7 轮构建（`fc0ba7f93be8`/`ebea32961479`）上**全部变红**；`AMP-R10` 另用 `void Promise.allSettled` 变异验证为红。两条 review run 被上游 credits 掐断时都走通了 `resumable` + artifact 续跑路径（第 8 轮本身就是一次实战验证）。

## 第 13 轮（上一批，已生效）：AMP 子代理 × DSH 上游源码契约评审的 15 条处置

> 依据：`docs/reviews/REVIEW-amp-summary.md`（Lead 终审）、`docs/reviews/REVIEW-amp-contract.md`、`docs/reviews/REVIEW-amp-runtime.md`。
> 参考真源：DSH 上游 `master c291e796`（与已安装 `0.1.5-rc.2` 同代）。

| # | 改动 | 依据 |
|---|---|---|
| 51 | **P1 终态不再被"看见 result"冒充**：`foldMessages` 只置 `resultReceived`，`finished` **只由 `finish()` 写**；退出观察者改以 `settlePromise/settling` 去重。原实现让"先读到 result、后收到进程退出"的 run **永远不结算**（DSH job 永久 `running`、终结通知永不到达、owner teardown 可能挂住） | 评审 R1；Lead 亲自复现（假 harness 下 `jobs.hooks.done` 30ms 超时）；测试 `AMP-R1` |
| 52 | **P1 账号 claim 不再泄漏**：pool 新增公开 `release()`；`start()` 把所有无需账号的校验（prompt block、字节上限、cwd）移到选号**之前**，并在"选了号但 run 未发布"的每个失败路径 `release` + 摘掉 abort listener；`noteDispatch` 移到 spawn **成功之后**；live 路径用 `published` 标志在 `finally` 里回收；`finish()` 结束时无条件释放 | 评审 C2 + R5（两面独立命中同一根因）；测试 `a rejected start() hands the account claim back`、`a prompt refused before selection never claims an account at all`、`AMP-C2` |
| 53 | **P1 jobs 契约：执行资源全部移进 `run()`**。`jobs` 服务检查移到选号之前；spawn/会话/artifact 都在 `run()` 内建立，preflight 拒绝 ⇒ **没有子进程、没有 thread、没有占用**；`run()` 自己抛错时 terminate 已建句柄。拒绝文案随之改成真话（"no process was started"） | 评审 R5；DSH `jobs/src/types.ts` 的 `run()` 契约原文；测试 `a refused job slot starts NOTHING…`、`admission is decided BEFORE the prompt is delivered, and a refusal starts no process`、`a refused slot cannot claim anything about a child` |
| 54 | **P1 `amp usage` 探针有真实 deadline**：`graceMs` 改为 5s 终止宽限，另用 `AbortSignal.timeout(20s)` 传给 `resolveExecutable`/`spawn`，`finally` 里显式 terminate；超时/失败一律按 **unreadable**（候选排位靠后）而不是余额为零 | 评审 C5；DSH `subprocess/src/types.ts:83-96`（"The caller owns deadlines"）；测试 `AMP-C5` ×2（旧代码上第二条直接挂死 25s） |
| 55 | **P1 live 路径折叠 `system` 非 init 错误**，分类输入统一为 `result.error ?? systemError ?? exitError`——与 one-shot 同口径，失败 kind 不再两条路径互相矛盾，`noteRefusal` 也终于会收到它 | 评审 R3；测试 `AMP-R3` |
| 56 | **P1 轮末通知镜像宿主预算**：`WeakMap<Agent, n>` + `agent/inbox/claimed`（user 消息）补回 + 预算耗尽**降级为 `inject`**（不再丢弃）。per-run 计数器既绕不过也保不住通知 | 评审 R2（推翻 `REVIEW-LOG` 的"对齐平台预算"）；DSH `tool-jobs/src/index.ts:207-229,268-299`；测试 `the turn-end notice mirrors the HOST wake budget…` |
| 57 | **P2 settlement 重入时后到的 kill 进终态事实**：`finish(session,kill)` 在已有 `settlePromise` 时，若尚未确认退出就先置 `killedByCancel` 再 terminate | 评审 R1b；测试 `AMP-R1b` |
| 58 | **P2 settings 注册失败不再静默**：捕获后写 `error` 日志、把原因挂到 pool 的 `settingsError`、**provider 与 live 派发一律拒绝**；web 路由下发该字段、client 页面显示原因并转只读 | 评审 C1；测试 `AMP-C1`（provider）、`AMP-C1`（web 路由）、`AMP-C7`（client 静态契约） |
| 59 | **P2 `dispose()` 不再吞掉停稳证明失败**：`teardown` 直接 `await handle.waitForExit()`，未证明静止时 dispose 会 reject（与 DSH "awaits … to actual exit" 契约一致） | 评审 C3；测试 `dispose() refuses to claim quiescence it could not prove` |
| 60 | **P2 派发读权威值**：provider/pool/`ampSettings.current()` 都按 `scope.get()` 现取（`currentResolved`），不再依赖异步 watcher 维护的镜像；订阅回调把宿主交付的 `next` 传出去 | 评审 C4；DSH `settings/src/index.ts:787-807`；测试 `AMP-C4` |
| 61 | **P2 run id 改为 `randomUUID()`**：remount/HMR 后不再与旧 provider 仍在跑的 run 重号 | 评审 C6；DSH `subagent/src/types.ts:308-314`；测试 `the run id is unique across mounts…` |
| 62 | **P2 client 的 `write` 改为经 `ctx.get('remote.settings')` 解析**：嵌套 Remote 未就绪时降级为只读，而不是调用即同步抛错、页面永久 busy | 评审 C7；测试 `AMP-C7`（静态锁） |
| 63 | **P2 artifact key 加 pid+uuid**，并修 `amp_runs` 的排序键：纪元改为**正则解析 13 位数字**（key 尾部再不是时间，旧的 "取最后一段" 会把 uuid 当纪元 → 排序全塌成 0、`limit:1` 抽到任意行） | 评审 R4（Lead 亲自复现碰撞：同一目录、prune 删掉在线记录、下次 checkpoint ENOENT）；测试 `A5`、`AMP-R4` |
| 64 | **P2 加固 waiting 通知的重试判据**：`noWork` 复用 `isNoWorkFailure()`（只有 credits/rate-limit/auth 可盲重试）。**诚实说明：该分支在当前实现里不可达**——`session.failure` 只在 `finish()` 里赋值，而那时通知已被 `settling/settlePromise` 抑制；这条是防御性加固，不是修复了一个可复现缺陷 | 评审 R7；不改行为，故无判别测试 |
| 65 | **P2 补上 disposer join 的判别测试**：测试 harness 的 `effect` 现在**返回并 await** disposer 的返回值；把 `await Promise.allSettled(settling)` 改成 `void` 会红 | 评审 R10；测试 `AMP-R10` |
| 66 | **文档降级（R8）**：`AMP-LIMITS #11` 改成"一个样本未见模型 turn"的证据强度，并写明**第 7 轮后 preflight 拒绝根本不 spawn**；计费仍标未验证 | 评审 R8 |

**测试**：135 → **151 条全绿**（新增 16 条回归；其中一条真等 20s 验证探测超时，全套约 25s）。
**反向验证**：把新测试跑在修复前的 `lib/`（子代理留下的副本，逐文件哈希与基线一致）上，**18 条变红**（含 `AMP-C5` 的"永不退出探测"用例挂死 25s）——这些新测试不是空壳。

## 第 12 轮（上一批，已生效）

| 49 | **设置页不再卡在"读取中…"**：`next` 改为**免费预览**（`preview({ probe: false })`，只用台账知识：陈旧正值、assumed 授信都在内）——此前它走的是会探测的选择路径，台账冷时要等最多 6 次 `amp usage`（每个 ~3.4s），而我给工具说明写的 "costs no network" 当时是**假的**（现在为真）。页面与模型的预览都改用它；真实派发仍然照常探测 | 用户实测反馈（页面显示"读取中…"+ 之前发现的过度声明）；测试 "a preview never spends a probe; a real selection still does"（preview 得 `assumed`、真实 choice 得 `confirmed` + `$3`） |
| 50 | **"本会话暂时不能编辑"不再在加载中显示**：那句提示原先在 `!canEdit` 时渲染，而加载中 `phase.kind !== 'ready'`，所以页面还没取到数据就宣称要重启。现在只在 `ready` 时出现 | 同上；测试 "the page does not claim editing is unavailable while it is still loading"（静态守卫 client.js 的门控条件） |

**测试**：133 → **135 条全绿**。



| 48 | **修掉终审唯一的未修高危**：`timer` 缺失时 sweeper **整段静默跳过**——无人轮询的 run 既收不到轮末通知、也没有 20 分钟回收。现在三处出声：mount 时 `warn`（写明后果与"挂载 @deepseek-ai/dsh-timer"）、`amp_run` 的工具说明带 `WARNING:`、**每次派发的返回里都有 `warning` 字段**（子进程自行退出时的终结通知仍会到，因为退出观察者不依赖 timer） | `docs/reviews/REVIEW-final.md:19` 逐条表第 7 行；测试 "a host with no timer service is LOUD about losing notices and the reaper" |

**测试**：132 → **133 条全绿**（并更正：评审称"轮末通知上限无判别测试"是 grep 字段名导致的误判——该测试存在，见 `test/live.test.mjs:573`，5 次轮末只收到 3 条通知）。



| 47 | **实测回应评审的"准入晚于 spawn"高危**：用 netcap 测了"带相同参数、永不投递 prompt"的子进程——它**会**建 thread / 开 actor socket（`POST /api/thread-actors` 201 等），但**不做任何模型工作**（`result{error:"No valid messages found in stdin", num_turns:0}`）。因此把该残余**降级并写明**：拒绝的 slot 不投递 prompt、停稳并 finalize，代价是**一个被遗弃的服务端 thread**，不是付费推理。测量记入 `AMP-LIMITS.md` #11 与代码注释 | `docs/reviews/REVIEW-round8.md:15`；本机实测（`/tmp/amp-noprompt.out` + netcap） |

**测试**：132 条全绿（本项为测量与文档，无新增测试）。



| 46 | **live 路径补上字节守卫**（与 one-shot 口径一致）：`amp_run` 的 prompt 与 `amp_send_message` 的 message 都按 `Buffer.byteLength` 拒绝 >1MiB，且**在选号之前**检查——被拒绝的 prompt 不该消耗账号占用 | `docs/reviews/REVIEW-round8.md` §5 的疑似项；测试 "the live path refuses an oversized prompt before it claims an account" |

**测试**：131 → **132 条全绿**。



| 45 | **修正模型面向的工具说明**（最重要的一处陈旧声明）：`amp_run` 还写着"回合结束后几分钟自动关闭，完成会自己到达"——**那是我第 4 轮就删掉的策略**，而模型正是据此规划委派。现在写明：回合结束**会通知你、run 保持打开**（可继续 `amp_send_message`），结束条件是 `amp_stop` / 子进程退出 / 空闲回收（默认 20 分钟），且**需要宿主 jobs 行**（无 slot 则拒绝）。`amp_stop` 的"thread 保持未归档，所以可以在那个 thread 上继续"也改成实情（**不会续接**，要从 artifact 接着做） | 自查（这类"删了行为、留着文案"的缺陷评审已抓过多次）；新增**漂移守卫**测试 `the model-facing descriptions describe the plugin that exists`（此前若删策略会变红） |

**测试**：130 → **131 条全绿**。



| 44 | **修掉"设置页会占用账号"**（我在第 4 轮加在途预耗时漏改 web 路由）：`/api/dsh-amp/accounts` 的 `next` 此前调用 `pool.choose()`，于是**渲染设置页就会占用账号**并把真实派发挤走——预览会改变它所预览的东西。现改用 `pool.preview()`；池子没有 `preview` 时**宁可不报，也不占用** | 自查发现；测试 "the settings page must PREVIEW the next account, never claim it"（断言 `choose` 调用次数为 0，且旧池子回退时也不调用） |

**测试**：129 → **130 条全绿**。



| # | 变更 | 依据 |
|---|---|---|
| 38 | **无 jobs 服务 → 拒绝启动（fail-closed）**：检查移到 `spawn` **之前**。此前"没有 jobs 也照跑"意味着一个 owner 无法 cancel/await/收通知的付费进程，与 jobs 合同相悖；现在给出明确错误（挂载 host jobs 行，或改用 one-shot 路径） | `docs/reviews/REVIEW-round8.md:15`；测试改为 "a host with no jobs service is refused, not handed an untracked paid run"（断言 stdin 从未写入） |
| 39 | **disposer 会 join 它启动的结算**：`teardownAll` 改为 async 并 `await Promise.allSettled(...)`——此前 `void finish()` 立即返回，final read / checkpoint fsync / close 可能还在飞，宿主退出时 artifact 可能不是一个 `finished` 的完整记录 | `docs/reviews/REVIEW-round8.md:25-27`；Cordis 与平台 jobs 插件都 await disposer |
| 40 | **终态 `status` 写进 checkpoint**：单一 outcome 在 finalize **之前**先算一次（`artifactPath` 改为 open 时记录，否则 `resumable` 会被误抑制），finally 里再**无条件重算**（finalize 失败会改变 `durability → status`）；保留策略优先用 `status` 判"失败"，`failure` 字段仅作向后兼容——这样"没有可分类错误但确实失败"（非零退出、partial、quiescence 未证明、结算抛错）不再被当成成功保留 | `docs/reviews/REVIEW-round8.md:38`；测试 "the checkpoint carries the projected status…" |
| 41 | **quiescence 未证实时不再建议"新开 run"**：终态那行改为先弄清遗留进程、**不要**重跑 | `docs/reviews/REVIEW-round8.md:50` |
| 42 | **`retryable` 仅限真正的失败**：加 `o.status === 'failed'`（killed 的 run 不再可能带"可重试"，尊重用户刚取消的意图） | `docs/reviews/REVIEW-round8.md:55` |
| 43 | **交付上限单位纠正**：`outputLimitBytes` 传的是**真字节预算**（32KB），此前把 8000 个字符的预算当字节交给 registry（中文摘要可能超 3 倍并被二次裁剪） | `docs/reviews/REVIEW-round8.md:64` |

**测试**：128 → **129 条全绿**。

## 第 11 轮（本批，待重启生效）

| 36 | **准入被拒的消息按事实分叉**：进程范围**未证明静止**时不再说 "has been stopped"，改成 "could NOT be confirmed empty — treat it as possibly still alive"（评审当场给出的反证，正是这个批次反复在消的过度声明类型） | `docs/reviews/REVIEW-round8.md` 的中间结论；测试 "a refused slot never claims the child stopped when stop could not be proven" |
| 37 | **保留名额按结果分组**：失败与成功**各有** `keepCount` 个名额，不再共享一个预算——修掉评审的反例"旧失败占满名额后，窗口外的成功全被淘汰"；总数上界 2×`keepCount`，`keepDays` 仍是硬底线 | `docs/reviews/REVIEW-round8.md`；测试 "many old failures must not evict out-of-window successes" |

**测试**：126 → **128 条全绿**。



| # | 变更 | 依据 |
|---|---|---|
| 35 | **`amp_accounts` 增加 `preview:true`**：报告**每个模式会选哪个账号、池子自己的理由**（`state`/`remaining`/`detail`）。走的是池子的**选择**路径而非 `choose()`，所以**预览绝不占用账号**（否则"读一下就占住"会把下一次真实派发挤走，预览会改变它所预览的东西）。默认关闭，不产生网络成本 | 这一晚我反复手工问"为什么派到那个号"（8 号 $5 闲置一晚就是靠它看出来的）；测试：`preview reports the selection without claiming it` + 工具层 `amp_accounts {preview:true}…` |

**测试**：124 → **126 条全绿**。

## 第 10 轮（本批，待重启生效）

| # | 变更 | 依据 |
|---|---|---|
| 30 | **准入前置于投递**（评审 §5 的唯一高危项）：prompt 现在**只在 job slot 拿到之后**才写进子进程；被拒时**先经唯一 `finish()` 停稳并 finalize**，然后抛出一条**真话**（"the prompt was never delivered and the child has been stopped"），不再断言"terminated before it could do work" | `docs/reviews/REVIEW-round7.md:66-67`；测试 "admission is decided BEFORE the prompt is delivered…"（断言 stdin 从未写入、子进程被终止、记录被 finalized 且不留 `interrupted`） |
| 31 | **所有 teardown 汇入 `finish()`**：host dispose 不再"terminate 后立即清空 sessions"，而是逐个走结算（有界等停稳 + final read + artifact finalize） | 同上（owner 合同：`done` 必须在资源释放后结算） |
| 32 | **保留策略优先保住失败记录**：可删集合内**先删成功、后删失败**（同类按最旧优先）——预算紧张时，出错那次记录比多留一次成功更有价值 | `docs/reviews/REVIEW-round7.md:69`；测试 "when the budget forces a choice, a FAILED run survives over a successful one" |
| 33 | **`retryable` 也要 quiescence 门槛**：可能有孤儿进程时，"现在换号重跑"同样是错建议（此前只对 `resumable` 加了） | `docs/reviews/REVIEW-round7.md:69`；测试 "retryable is withheld while quiescence is unproven" |
| 34 | **F9 守卫改为真字节**：限额名为 bytes、子进程收 UTF-8，此前用 `.length`（UTF-16 code units）会让中文/emoji 的 prompt 通过守卫却被截断 | `docs/reviews/REVIEW-round7.md:69`；测试用 40 万汉字（code units < 1M，字节 ~1.2M）证明其判别性 |

**测试**：120 → **124 条全绿**。

## 第 9 轮（本批，待重启生效）

| # | 变更 | 依据 |
|---|---|---|
| 27 | **保留策略安全优先**：只有 checkpoint **可读且 `finished: true`** 的 run 才可能被自动删除；`finished: false` / 损坏 / 缺失记录的 run **永不自动删**（此前它们会随 age/count 一起被删——那正是崩溃后最需要保留的救援对象）。`open()` 不再吞掉清理失败，会写 warn；根目录读不到时按 store 的失败形状返回，但 **ENOENT 视为"没东西可清"**（否则每次全新安装都告警） | `docs/reviews/REVIEW-round7.md:24-28`；测试：未完成/损坏/无记录三种形态在 `keepDays:0, keepCount:0` 下仍存活；策略值也做了钳制（NaN/负数不再能反转策略） |
| 28 | **空闲超时真正可热改**：此前 sweeper 在注册时把它复制成局部常量，改设置无效（评审指出我的文档"立即生效"不实）。现在**每 tick 重读** `resolved` | `docs/reviews/REVIEW-round7.md:14`；`lib/live.js` 的 idle sweep |
| 29 | **订阅不再静默冻结**：agent 行改用 `ctx.inject([ampSettings])` 等待服务（缺失时 warn），订阅时**先 `current()` 对账**，消除 mount→subscribe 之间的丢失窗口 | 同上；测试：服务缺失时告警且工具仍挂载、mount 后被改的值会胜出 |

**测试**：116 → **120 条全绿**。

## 第 8 轮（本批，待重启生效）

| 25 | **并发选号加在途预留**：`choose()` 先把未占用的号排在扫描前面，选完即"占用"（成功/被拒/刷新都释放，30 分钟 TTL 兜底）；**选择与占用原子化**（同 tick 的两次并发会被串行队列隔开——我发现只用 await 后占用会两边都跑完 `select` 再占，等于没占）。全被占用时仍派发并标 `already-claimed`（fail-open） | `docs/reviews/REVIEW-full.md:49` 中危 #6；三条测试：并发不撞号 / 回报后释放 / 唯一号仍派发 |
| 26 | 文档把"并发无预留"这条边界改成已实现 | 同上 |



| 24 | **探测预算不再埋没有钱的号**：预算耗尽时，**陈旧但已知为正**的台账读数（≥$1）现在作为候选（`state: '<…>-stale'`），能完赛就直接当选——此前它被整个跳过，于是把一个看得见有 $5 的号让给了"从未观测"的猜测号（真机：评审被派到 9 号 `assumed`，而 8 号台账写着 $5） | 真机观察 + 测试 "the probe budget must not hide a stale but KNOWN-funded account" |



| # | 变更 | 依据 |
|---|---|---|
| 23 | **live 设置真正生效**：host 行在注册命名空间时**暴露 resolved 订阅**（`SERVICE = 'ampSettings'`：`current()` / `subscribe()`），agent 行订阅后**原地更新**工具闭包持有的 `resolved`。此前 `ampBin`/visibility/keepThreads/grace/空闲超时改了**静默无效**，而设置页却在显示它们 | `docs/reviews/REVIEW-full.md:51` 中危 #8；测试 "the agent row follows a settings change instead of freezing at mount"（断言已注册的工具在改动后解析到**新的** `ampBin`） |

**测试**：111 → **112 条全绿**（当轮）。模式列表仍是 mount 固定（工具 schema 的 enum），已在文档写明。

## 第 7 轮（本批，待重启生效）

| # | 变更 | 依据 |
|---|---|---|
| 19 | **`amp_runs` 降级不再撒谎**：checkpoint 损坏/不可读时给 `checkpoint:'unreadable'` + `checkpointError`（含操作名），且**不再据此断言 `interrupted`**（那是 UNKNOWN）；`list()` 失败改为抛出 store 的真实原因，而不是 spread 一个对象引发次生 TypeError | `docs/reviews/REVIEW-f26b.md:47`（"只修一件"）；测试 "a corrupt checkpoint is UNKNOWN…" / "an unlistable run root reports the store error…" |
| 20 | **`resumable` 加上 quiescence 门槛**：进程可能仍有孤儿时不再邀请"接着做" | `docs/reviews/REVIEW-f26b.md` 摘要；测试 "resumable is withheld while quiescence is unproven" |
| 21 | **修 `pruneRuns` 的潜在 ReferenceError**（它调用了 store 闭包内的 `failure()`），失败时返回 `prune <name>: <原因>` | 测试 "a deletion that fails returns the reason instead of throwing" 逼出 |
| 22 | **文档降级到可复核**：`AMP-LIMITS.md` 逐条标注证据强度（可复核/本机操作记录/未知），收回"high/ultra $1 门槛已实测""SDK 只是 CLI 包装""限流只属于 Enterprise"等强化；`USABLE.md` 收回"Amp 没有轮级打断""live 路径无损""零成本核对"，并补 live 设置不热、fail-open、`interrupted` 精确语义 | `docs/reviews/REVIEW-f26b.md:58-66`（§4 逐条） |

**测试**：107 → **111 条全绿**。

## 第 6 轮（本批，待重启生效）

| 15 | **artifact 有界保留**：`pruneRuns()`——保留 `keepDays`（默认 7 天）内修改过的，且**总是**保留最新 `keepCount`（默认 50）个；`open()` 每小时最多清理一次，删除失败返回错误而不抛出 | `docs/reviews/REVIEW-full.md:87` P0-2；测试 "retention: old runs are pruned, the newest keepCount are always kept" |
| 16 | **spill 文案诚实化**：不再宣称"完整流在 spill 文件里"却给不出路径——有路径就给路径，没有就**明说早期字节不可恢复** | `docs/reviews/REVIEW-full.md:52` P1-5 |
| 17 | **组合冒烟测试**（零额度）：真的 mount 一次 agent 行，断言五个工具名、`amp_run` 必填 `prompt`、`amp_send_message` 必填 `run`、每个工具都有 description/execute | `docs/reviews/REVIEW-full.md:91` P1-6（最轻形态） |
| 18 | 文档：`USABLE.md` 写明 artifact 保留策略与两个新通知字段 | 同上 |

**测试**：104 → **107 条全绿**。



| # | 变更 | 依据 |
|---|---|---|
| 11 | **降级进 job 状态**：平台的 job 状态是封闭枚举（`completed|killed|failed`，`packages/jobs/jobs/src/types.ts:17`），所以**记录不完整（durability=partial）或进程范围未证实停稳（quiescenceUnproven）时投影为 `failed`**，同时保留 `processStatus=completed` 与原因 | `docs/reviews/REVIEW-f26b.md:11-12,17`；测试 "a partial durable record cannot be reported as clean success" / "unproven quiescence cannot be a silent completed job" |
| 12 | **通知投影 quiescence 与降级事实**（`quiescence=unproven(…)`、`degraded=reported-as-failed(processStatus=…)`） | 同上 |
| 13 | **无号可完赛时选"最富"的可用号**（tier2 改为取余额最大；tier1 仍按配置顺序） | `docs/reviews/REVIEW-f26b.md:25`（`$1.01` 压过 `$3.99` 的反例）；测试 "when nothing clears the bar, the RICHEST startable account is used" + 两个退化反例测试 |
| 14 | 补完评审 §6 的整链测试：相邻 tier 顺序、tier1 配置顺序是有意选择 | `docs/reviews/REVIEW-f26b.md:41,47` |

**测试**：99 → **104 条全绿**。

## 第 5 轮

| # | 变更 | 依据 |
|---|---|---|
| 1 | **单一终态**：`finish()` 在结算末尾算一次 `session.outcome`，job 与 `amp_stop` 只做投影（不再各推一套判据）；`settleError` 在 `finally` 之前记录 | `docs/reviews/REVIEW-full.md:41` 高危 1；`test/live.test.mjs` 的 "both surfaces project ONE outcome" / "a kill through the job" |
| 2 | **artifact 写入失败不再被吞**：4 处 `append/checkpoint` 折进 `noteArtifactWrite`，notice 输出 `artifact=INCOMPLETE(...)` | `docs/reviews/REVIEW-full.md:42` 高危 2；测试 "a silently failing artifact write is REPORTED"（用 `chmodSync` 只读目录注入失败） |
| 3 | **`durability` 事实**：`complete` / `partial`；`resumable` 要求 `durability === 'complete'`，partial 时给 `durability=partial(...)` 而不是承诺"work is on disk" | `docs/reviews/REVIEW-f26.md:106-107`、`:109` |
| 4 | **F26 余量感知选号**：`MODE_HEADROOM = {low:1.5, medium:4, high:6, ultra:10}`，`choose()` 四层排序（能跑完 → 能起跑 → assumed → 能起跑但低于闸门 → …） | `docs/reviews/REVIEW-f26.md` 摘要；测试 "F26: a medium run takes the account with headroom…" |
| 5 | **bar 不得低于服务端起跑闸门**（`Math.max(headroom, MIN_START_CREDITS)`） | `docs/reviews/REVIEW-f26.md:90` 点名的退化（$0.60 压过 $5）；测试 "the flagged regression: a $0.60 account must not outrank a later $5 one" |
| 6 | **state 文案与层级对齐**：tier2 → `-below-headroom`、tier3 → `-below-start-gate` | 同上；测试 "exactly at headroom clears the bar, a cent below does not" |
| 7 | **设置页不再复刻选号规则**：`/api/dsh-amp/accounts` 新增 `next.byMode`，由池子回答；页面只渲染 | `docs/reviews/REVIEW-full.md` 中危（"next account" 双真源）；`test/web.test.mjs` 两条 |
| 8 | **F9 大 prompt 拒绝而非截断**（one-shot 路径 >1MiB 抛错） | `docs/reviews/USAGE-FINDINGS.md` F9；测试 "an oversized prompt is refused loudly" |
| 9 | **通知带 `summary`**（最有内容的一轮），避免短追问把成果从通知里挤掉 | 真机事故：`last="OK"` 覆盖了 24KB 报告的摘要 |
| 10 | 文档：`docs/AMP-LIMITS.md`（10 条实测＋证据路径＋未知＋待验证实验）、`docs/USABLE.md`（能力/边界/验收/通知字段） | `docs/reviews/REVIEW-f26.md:33-55,57-66` |

**测试**：83 → **99 条全绿**（新增 16 条，全部是能区分"修前/修后"的判别性用例）。

## 第 4 轮（已生效，重启后核对过哈希）

- **回合结束通知**（`notifyTurnEnd`）：`end_turn` 时对委派方 agent 调 `followup`/`inject`，**run 保持开着**；每 run 上限 3 条（对齐平台 `maxConsecutiveWakes`）。
- **删除 `liveIdleSettleMs`**（原 2 分钟空闲自动结算/关闭）——"通知"与"可追问窗口"不再互斥。
- terminal 通知不再建议 `steer`（已终结的 run 调 `amp_send_message` 必被拒）；`last=` → `lastTurn=`。
- **按提示窗口冷却**（抓包实测 ~60s，提示秒数准确），**删除指数退避**。
- 探测预算耗尽时不再跳过从未观测的号（否则池子会反复挑到烧过的号，让后排 $5 闲置）。
- live 成功后 `refresh` 该账号余额。

## 第 1–3 轮（更早，已生效）

- 失败分类与判决（`retryable` 只在"没干活"时给；`resumable` 只在"干过活 + 记录完整"时给）。
- artifact（append-only、脱敏、含 stderr）＋原子 checkpoint；`amp_runs` 可在重启后指出被打断的 run。
- A1：run 注册为平台 job → 完成通知自动开委派方 agent 的下一轮（**该次运行**实测把 25 次轮询降到 0；这是那次事故的记录，不是稳定收益指标）。
- `deploy.sh`：源→安装副本逐字节校验 + 每个模块的期望哈希；运行时用 `amp_accounts.source.modules` 逐文件对账。
