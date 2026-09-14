# dsh-amp 边用边改问题台账

来源三类：**实测** = 本机真实使用 `amp_run` / `amp_send_message` / `amp_accounts` 复现；**读码** = 静态审查；**review** = Amp 子代理独立审查（`REVIEW-amp.md`）。
基线（改前）哈希：`/tmp/dsh-amp-baseline/SHA256.txt`，表中行号以基线为准。

| ID | 现象 | 证据 | 来源 | 状态 |
|---|---|---|---|---|
| F1 | 跨 chunk 的 NDJSON 半行被永久丢弃：每次 `readFrom` 后立即按行解析，尾部半行既不入消息也不留待下轮，下轮的前半行同样解析失败 | `lib/live.js:93-110`、`lib/live.js:174-219` | 实测+读码（与我独立结论一致） | ✅ 已修 + 已测 |
| F2 | **完成不通知**：`amp_run` 只返回句柄，子进程结束后无任何推送，只能靠我主动拉。对比 `subagent_amp_*` 走 jobs registry 有推送 | `lib/live.js:365-377`；实测：56s / 193s / 246s 三次都是我主动读 | 实测 | 未修（方案已定，见下） |
| F3 | 冷启动与默认等待不匹配：Amp 冷启动 ~10s+，`amp_send_message` 默认只等 8s；且"思考中"与"卡死"仍不可分（246s 那次 53s 无输出，只有 `idleMs` 可看） | `lib/live.js:429`、`lib/live.js:462-465` | 实测 | 未修 |
| F4 | 并发两次 `amp_stop`：后一次因 `session.settling` 立刻返回，随即报 `completed` + 空 output 并删掉句柄，而第一次仍在收尾 | `lib/live.js:239-241`、`lib/live.js:497-519` | 读码（Amp review 独立复核） | ✅ 已修 + 已测 |
| F5 | `amp_send_message` 的 `stdin.write` 无守卫：子进程已死时写入可能抛错/EPIPE，且 `delivered: true` 是谎报 | `lib/live.js:424-425` | 实测+读码 | ✅ 已修 + 已测 |
| F6 | owner 围栏 fail-open：`amp_send_message`/`amp_stop` 未校验 `exec.agent`，为 undefined 时 `requireSession` 直接跳过归属校验（`amp_run` 反而校验了） | `lib/live.js:221-230`、`lib/live.js:415`、`lib/live.js:498` | 读码 | ✅ 已修 + 已测（改为 fail closed） |
| F7 | ledger 与 live 路径脱节：`noteDispatch` 只在 provider `start()` 调用，live 路径不记；live 路径也不做 post-run `refresh()` | `lib/index.js:265` vs `lib/live.js:352`；实测本机 ledger 中 `AMP_API_KEY_1.runs` 在本轮 live run 后仍为 `0` | 实测 | 未修 |
| F8 | `stale()` 是死代码：`CONFIRM_AFTER_MS = 10min` 定义了却无调用点，陈旧的正余额永不重验，选号可能落到已耗尽的号 | `lib/accounts.js:256-262`（无调用者） | 读码（Amp review 独立复核） | 未修 |
| F9 | one-shot 路径 prompt 静默截断：`prompt.slice(0, STDIN_MAX_BYTES)` 无任何提示或报错 | `lib/index.js:331` | 读码（Amp review 报出） | 未修 |
| F10 | `amp_accounts` 描述写死"48 accounts"，本机实际配置 65 个 ref | `lib/live.js:551` | 实测 | 未修 |
| F11 | 选号无并发占用：两个 run 同时 `choose()` 会选中同一个号（无 in-flight 记录） | `lib/accounts.js:167-235` | 读码（Amp review 报出） | 未修 |
| F12 | 模式清单漂移：`package.json` 描述 low/medium/high/ultra，`cordis.patch.yml` 只挂 `[low, medium]`；且 settings 里 `modes` 的 schema 默认值是四模式，可能在运行时覆盖 patch 的清单 | `package.json:4`、`lib/index.js:57`、`cordis.patch.yml:22` | 读码 | 待确认 |
| F13 | **失败路径泄露注入的 API key**：`detail` 里 `result.error` / system error / stderr 原样拼接，而该 `detail` 被塞进**未经 `truncate()`/`sanitize()` 的 output block** 返回给模型；只有 `diagnostic` 走了脱敏 | `lib/index.js:385-389`、`lib/index.js:413`（基线行号） | review 报出，我读码证实 | ✅ 已修 + 已测（基线复现泄露，改后不泄露） |
| F14 | **stop 没有真实超时**：`STOP_GRACE_MS = 20s` 定义了但从未使用，`waitForExit()` 也不传 signal（seam 合同：无 signal 时可无限等待）→ EOF 后若仍有后代进程，`amp_stop` 永不返回，idle 回收把 session 永久卡在 `settling` | `lib/live.js:38`（无调用点）、`lib/live.js:249`；`dsh-subprocess` 合同 `waitForExit(signal?)` | review 报出，我 grep 证实 | ✅ 已修 + 已测 |
| F15 | live 路径从不观察 `handle.done`：子进程自行退出也不会更新状态，`alive` 仅等于 `!session.finished`，可长时间向模型谎报"process is alive" | `lib/live.js:232-235`、`lib/live.js:414-465` | review 报出 | ✅ 已修 + 已测 |
| F16 | 配了 spill 却从不读：`lossy` 只被写进诊断，`spillPath` 从未用于恢复完整流；超大输出仍会丢，甚至被误判 `no result message` | `lib/live.js:33-34`、`lib/live.js:173-180`、`lib/index.js:144-150` | review 报出 | 未修 |
| F17 | 多进程共享 ledger 时 last-writer-wins：每个进程持有启动时的全量快照，整文件 rename 覆盖，atomic 只防半写不防 clobber | `lib/ledger.js:46-68`、`lib/ledger.js:92-123` | review 报出 | 未修（单 Host 场景影响低） |
| F18 | 文档漂移：PLAN 称阶段 4 未开始（实际 settings page/route/client export 已实现）、仍写不存在的 `amp_interrupt`；`package.json` 描述四种 mode 而实际只挂 low/medium | `PLAN.md:7-10,84-117`、`package.json:4`、`cordis.patch.yml:22` | review 报出 | 未修 |
| F19 | 已结算的 live run 永不被回收：sweep 只处理 `!finished`，`amp_stop` 之后没人 delete 的 session（例如子进程自退后没人来收）会一直留在 map 里 | `lib/live.js:605-614`（基线） | 我读码发现（改 F15 时暴露） | ✅ 已修 + 已测 |
| F20 | **改源码 + 重启 ≠ 生效**：profile 以 `"dsh-amp": "file:$DSH_HOME/plugins/dsh-amp"` 声明依赖，包管理器把它装成**真实拷贝** `profiles/web/node_modules/dsh-amp`。编辑源目录后重启，宿主加载的仍是旧副本（inode 不同、哈希 = 基线）。三次"重启验收"全部落空 | `profiles/web/package.json:9`、`profiles/web/node_modules/dsh-amp/`；哈希 `648996eb…`（副本=基线）vs `d0b520a6…`（源）；`deploy.sh --check` 对旧副本退出 1 | 实测：F15 的真机验收失败（SIGKILL 后仍 `alive: true`）才暴露 | ✅ 已闭环：`deploy.sh`（部署+逐字节校验）+ `--check`（漂移检测）+ 运行时指纹 + 手动重启 |
| F21 | **内部结算会吞掉尚未投递的消息**：`done` 观察器触发的 `finish()` 会先 `absorb`，把"上次读之后"的消息自己消费掉；此后再调 `amp_send_message` 只会得到 `newMessages: []`。数据没丢（`amp_stop` 仍能取到 `output: "OK"`），但"自上次读取以来的一切"这个承诺在结算边界上不成立 | `lib/live.js`（`finish` 内的 `absorb`）；真机实证：SIGKILL 后 `newMessages: []` 而 `bytesSeen` 从 1101 涨到 1474 | 真机验收发现 | 未修（低） |
| F22 | **我自己的误判（记录用，非插件缺陷）**：我读 `lib/web.js` 时只读了 25 行就下结论"`allRefsAvailable` 从未返回 → 账号页永远只读"，实际基线第 85 行就有该字段。据此动手改，反而引入了**重复键**（后一个 `allRefsAvailable` 覆盖了我的完整性校验）。是当天新写的路由契约测试当场抓住的 | 截断读 vs 基线 `lib/web.js:85` | 我 | ✅ 已修（去重）+ 已测；顺带把该字段从"函数存在即为真"收紧为"`allRefs.length === total`"，被截断的清单不再可写 |

## F20 的教训与防复发

我上一轮把"Host 启动时间晚于文件 mtime"当成"新代码已加载"的证据——**验证的是没被加载的那个文件**，因此错误地宣布 F13 已上线。正确的验证对象是**宿主加载的那份产物**。

防复发措施（已实现，`lib/source.js`）：每个入口在加载时对自己取 `import.meta.url` 的绝对路径 + sha256 前 12 位，并通过工具输出暴露：

- `amp_accounts`（**免费**，host 行 `lib/index.js`）→ `source: { file, hash }`
- `amp_run`（agent 行 `lib/live.js`）→ `source: { file, hash }`

于是"这次到底跑的是哪份代码"变成一次零成本调用即可回答，不再依赖 mtime 这类间接证据。


## F2 的修法（已查实，待实施）

`ctx.jobs` 的 seam 契约（`@deepseek-ai/dsh-jobs` / `dsh-jobs-local`）给出了正解，不是新造：

- `JobStart { kind, label, outputLimitBytes?, owner?, run() → JobHooks }`，`JobHooks { cancel(reason), done: Promise<JobOutcome>, readOutput?() }`。
- `onJobDone(listener)` 的监听"**可以同步打开一个 model turn**"——这就是 `subagent_amp_*` 有完成通知、而 `amp_run` 没有的原因：前者注册了 job，后者没有。
- 围栏按 owner 的 session id；`JobKindMap` 可声明合并；`readOutput()` 的语义（"自上次调用以来新增的输出"）与 `absorb()` 的 offset 语义完全同构。
- 并发上限也在这里：`maxConcurrentJobsPerOwner` **默认 10**（`running` + `stopping` 都占名额）。
- `start` 要求"有已挂载的 job controller 服务该 owner"，本 preset 已挂 `tool-jobs`。

因此 `amp_run` 应把每个 live run 注册成 job（kind 例如 `amp-live`）：`readOutput` 复用 `absorb`，`done` 接 `settlePromise`，`cancel` 接 `finish(session, true)`。白拿：完成推送、统一的 `job_list`/`job_output`/`job_kill`，以及平台级围栏。

## 验证

- 测试套件：`bash test/run.sh`（**20 条**：live 工具 9 + one-shot provider 6 + web 路由契约 5；fake ctx + fake 子进程，驱动真实工具注册、provider `start()` 与路由 handler）。
- **判别性证据**：同一套测试跑改前基线 → 6 条失败（F1/F4/F5/F6/F14/F15），跑改后 → 20 条全过；F13 的泄露在基线上直接复现（`TOKEN LEAKED? true` → 改后 `false`）。
- 静态：`node --check` 全部 `lib/*.js` 通过（基线与改后皆跑）。
- **真机验收（已换到新副本，PID 19459，指纹核对通过）**：
  - 冷启动 ~11s（与 PLAN 记录一致）；`unparsedLines: 0`、`lossy: false`。
  - **F15 通过**：外部 `kill -9` 子进程后，`amp_send_message` 报 `status: "finished"` / `alive: false` / `exitCode: null`；同一条测试在旧副本上是 `alive: true` + `idle`。
  - `amp_stop`（子进程已自行退出后调用）返回 `stopReason: "completed"`、`output: "OK"`、诊断 `no result message exitCode=null` —— 不挂、不谎报、产出收得回来。
  - 并发两次 `amp_stop` 经真机试跑时被运行时**串行化**（第二次报 `unknown run`），故这条竞态未能真机构造；其确定性验证来自 harness（F4：两次调用共享同一个 settle，`waitCalls === 1`）。
- 部署校验：`deploy.sh --check` 在源与副本一致时退出 0、对旧副本退出 1；重启后 `amp_accounts.source.hash` 应为 `2f6581e85e67`（host 行）、`amp_run.source.hash` 应为 `2f8c874572be`（agent 行）。
- 未覆盖：F2（A1 通知）/F3/F7/F8/F9/F10/F11/F12/F16/F17/F18/F21 未修；F16 的 spill 恢复、F11 的选号并发未动。机制层的完整缺口与优先级见 `DESIGN.md`。

## 修复原则（沿用 PLAN.md 已定约束）

- 只做加法；爆炸半径限于"我们自己的工具不工作"。
- 报错按效率优先，原始报错直给；唯一抹掉的是 token 字面量（本机 65 个 ref 实测全为 `sgamp_` 前缀，redaction 假设成立）。
- 工具名与语义必须诚实：`amp_stop` 不叫 `amp_interrupt`，因为它确实做不到轮级打断。
- 改动要在本机生效需重启 Host（插件在进程内加载）；`lib/client.js` 的浏览器半边需重建 Web 产物。

## 真机验收暴露的两条机制缺口（2026-09-14，已修）

| ID | 现象 | 证据 | 修法 |
|---|---|---|---|
| F23 | **"这一轮干完了"不等于结算**：子进程回完 `OK`、`end_turn` 之后仍保持 stdin 打开等插话，于是 job 永远停在 `running`，**owner 永远收不到通知**。我结束轮次后没等到通知，就是这个原因 | 真机：`job_output(amp-live-2)` → 子进程已回 `assistant: "OK"` / `end_turn`，而 job `[status: running]` | 新增**空闲结算策略**：回合结束后无人 steer/stop 超过 `liveIdleSettleMs`（默认 2 分钟）即关闭该 run，使其正常结算并通知 owner；`isIdleSettled()` 抽成纯函数可测（6 条断言） |
| F24 | **宿主重启会孤儿化运行中的 run**：内存里的 session 随进程消失（`unknown run`），而它的产出仍在盘上——插件启动后**没有任何机制**把"被打断的 run"指出来 | 真机：重启后 `amp_send_message(run-11)` → `unknown run ... Known runs: dsh-amp-run-1, dsh-amp-run-2`；而 `REVIEW-round5.md` 17.8KB 仍在盘上 | `amp_runs` 新增 `liveInThisProcess` / `interrupted` / `resumeHint`：**不在本进程、且 checkpoint 未记 `finished`** 的 artifact 判为被打断，并给出原始流路径与 thread，供人或新 agent 接手（3 条测试，含"崩溃现场"构造） |
