# dsh-amp 可用性清单

> **刚回来先看这三行：**
> 1. 现在要做的只有一件事：**重启宿主**（十几批改动都等它生效）。
> 2. 重启后跑 `bash verify.sh`，再在会话里调 `amp_accounts({ preview: true })` —— 它必须返回 `next` 字段（旧构建没有），这是**零成本**的行为探针。
> 3. 结论与证据在 §7；边界在 §3；上游实测在 [`AMP-LIMITS.md`](./AMP-LIMITS.md)；每轮改了什么、凭什么在 [`CHANGELOG.md`](./CHANGELOG.md)；**7 轮评审的逐条处置**在 [`REVIEW-LOG.md`](./REVIEW-LOG.md)（第 7 轮 = AMP 子代理 × DSH 源码契约评审）。

## 1. 它是什么

把**本地 Amp CLI** 跑成 DSH 的子代理：一条"一次性委派"路径（走平台 provider）＋一条"可插话的长活"路径（工具三件套）。通知面向**委派方 agent**：回合结束就注入上下文、开出新一轮；run 保持开着，随时可追问。

## 2. 能做什么

| 能力 | 用法 | 说明 |
|---|---|---|
| 一次性委派 | `subagent_amp_low` / `subagent_amp_medium` | 走平台 jobs，完成有通知；适合"派出去等结果" |
| 可插话长活 | `amp_run` → `amp_send_message` → `amp_stop` | 可中途 steer；回合结束会通知我；可追问多轮 |
| 看账号 | `amp_accounts`（加 `preview:true` 可看**每个模式会选哪个号、为什么**；预览**不占号、不走网络**） | 余额、`usable`、`runs`、以及**当前加载的构建哈希与漂移**。默认只读本地台账（不花 credits、不走网络、瞬时）；`refresh:true` 才逐号探测（仍不花 credits，但有约 3.4s/号的网络往返） |
| 看历史/救援 | `amp_runs` | 磁盘上的 run：checkpoint、failure、`interrupted`、artifact 路径；崩溃/重启后可捞回成果 |
| 尽量不丢 | 每个 run 尽力持续落盘 | `state/dsh-amp/runs/<runId-epoch>/stream.log`（append-only、脱敏、含 stderr）＋ `checkpoint.json`。**不是绝对保证**：写入失败会降级为 `durability=partial`；lossy gap 不回补；记录只有在**可读且未被保留策略清理**时才可用于救援 |

## 3. 已知边界（诚实清单）

- **不做轮级打断**：本插件不提供（`amp_stop` 结束整个 run，thread 保留在新 run 的 prompt 里）。**"Amp 没有"这种断言已收回**——只能说已试的非交互路径不可用。
- **不做跨进程 thread 续接**：本机试过的非 TTY 形式失败（**未证明"必须 TTY"**，也没试过 `-ox/--orb-execute`）；SDK 的 `continue` 未验证。续跑＝读 artifact 新开。
- **不做同一次运行内自动改派**：失败后由被唤醒的 agent 决定（`retryable` / `resumable` 是判据）。
- **agent 行要求宿主提供 jobs 服务**：没有 job slot 的 run 无法被 owner 取消/等待/通知，因此**会被拒绝启动**（明确报错）。需要无 jobs 环境时用 one-shot `subagent_amp_*` 路径。
- **账号仍会被上游限流**：见 `AMP-LIMITS.md`；机制的做法是轮转与余量感知，不是免疫。
- **`MODE_HEADROOM` 是偏好不是闸门**：没有号达标时**仍然派发**最合适的那个（fail-open），只是会在通知里带上 `below-headroom`/`below-start-gate` 说明风险。
- **并发选号有在途预留**：选中的号会被"占用"直到该 run 回报（成功/被拒/刷新都会释放；30 分钟 TTL 兜底）。占用是**偏好不是锁**——全被占用时仍会派发并标注 `already-claimed`。
- **artifact 有界保留，且安全优先**：**只有 checkpoint 可读且 `finished: true` 的 run 才可能被自动删除**；`finished: false` / checkpoint 损坏 / 缺失记录的 run **永不自动删**（那正是救援要找的）。在可删集合内保留 `keepDays`（默认 7 天）内修改过的；名额按**结果分组**——失败与成功**各有** `keepCount`（默认 50）个名额，互不挤占（总数上界 2×`keepCount`）。`open()` 每小时最多清理一次，清理失败会写 warn（不再静默）。可用 `retention: { keepDays, keepCount }` 覆盖。
- **超大输出有损（两条路径都是）**：超过阈值时内存里只剩 tail，spill 文件里的 gap **当前不回补**（artifact 只 append 观察到的 tail）。诊断现已诚实：有路径就给路径，没有就明说早期字节不可恢复。
- **`drift` 不能证明"已重启生效"**：`deploy.sh --check` 只比较安装副本与源码；唯一能证明运行中构建的是运行时哈希（host 平面：`amp_accounts.source.modules`；agent 平面：`amp_run.source.hash`）。**判断"待生效"不要用 `--check`**——它永远说 in-sync，即使宿主跑的是旧构建。
- **live 设置是热的（mode 列表除外）**：改 `ampBin`/visibility/keepThreads/grace/空闲超时后**立即生效**——agent 行通过 `ctx.inject([ampSettings])` **等** host 行的订阅服务（服务缺失时会 warn，不再静默冻结），订阅时**先对账一次** `current()`（否则 mount→subscribe 之间的改动会永久丢失），并**原地更新**工具闭包持有的对象；空闲超时**每 tick 重读**，不是挂载时的副本。**唯一例外是模式列表**：工具 schema 的 `enum` 在注册时固定，改 `modes` 需要 remount/重启。
- **多 host 共享 `DSH_HOME` 时 ledger 是 last-writer-wins**：单 host 日常无影响。
- **`amp_runs` 是 host 级的救援视图，不按 session 隔离**：任何挂了 live 工具的 agent 都能列出本机其它 session 的 run（含 account ref、thread id、lastText 与路径）；而在线 steer/stop 严格按 owner 拒绝。这被当作**有意的救援面**；若将来要求 session 隔离，需要把 owner 持久化进 checkpoint 并另做管理员视图。

## 4. 部署与验收

```bash
cd $DSH_HOME/plugins/dsh-amp
bash verify.sh            # 一条命令：跑测试 + 查漂移 + 打印"重启后必须逐文件对上的哈希表"
```

单独用：

```bash
bash test/run.sh          # 全套行为测试（当前 164 条，约 26s：含一条真等 20s 的探测超时用例）
bash deploy.sh            # 同步到 profile 安装副本，逐字节校验，打印每个文件的期望哈希
bash deploy.sh --check    # 只查漂移：in-sync / STALE
```

**然后必须重启宿主**（插件在进程内加载）。重启后核对（host 平面免费；agent 平面要起一次**极小的 low run**——`amp_run` 本身就会真的启动一个 agent，这一点之前被我说成"零成本"，是错的）：

```bash
# 1) 每个模块的哈希（应当与 verify.sh / deploy.sh 打印的表一致）
#    在会话里调用 amp_accounts → source.modules / source.hash / drift=in-sync
# 2) agent 行的 live.js 哈希：调用一次 amp_run → source.hash
```

> `deploy.sh --check` 的 `in-sync` **不能证明宿主已重启**：它只比较安装副本与源码。
> 唯一能证明"运行中的构建"的，是上面两条**运行时哈希**。

## 5. 当前状态（本文件写作时）

- 测试：**164 条全绿**；部署以 `deploy.sh` 实际输出为准（哈希会随每次改动变化）。
- 已实现：失败分类与判决（`retryable`/`resumable`）、artifact＋checkpoint（**写入失败会被上报**）、`amp_runs` 救援、A1 jobs 注册与**回合结束通知**（按 exact Agent 镜像宿主预算：连续 3 次 `followup`，之后**降级为 `inject` 而不是丢弃**，真人输入到达时补回）、模式下限＋**余量感知选号（F26）**、**单一终态**（job 与 `amp_stop` 只做投影）、部署漂移可见、`deploy.sh` 校验。
- 待生效：任何尚未重启的批次。**判断方法只有一个**：重启后比对运行时哈希（`amp_accounts.source.modules` / `amp_run.source.hash`）与 `verify.sh` 打印的表——`--check`/`drift` 读的是磁盘，不能证明进程内已加载。

### 怎么读一条通知

```
Amp run <id> finished its turn and is waiting for you.
mode=… account=… thread=… [failure=<kind>] [retryable=true(…)]
[artifact=<path>] [summary="…"] lastTurn="…"
state=waiting. Next: amp_send_message (steer/read) or amp_stop.
```

| 字段 | 含义 |
|---|---|
| `state=waiting` | 回合结束、**run 仍开着**，可以追问/steer/stop |
| `state=terminal` | run 已结束，下一步是 `job_output`/读 artifact，或新开一个 `amp_run` |
| `interrupted: true`（在 `amp_runs` 里） | 不在本进程、且 checkpoint **明确**未 `finished`。checkpoint 读不出来时给 `checkpoint: unreadable` + `checkpointError`，**不猜** interrupted |
| `lastTurn` | **最后一轮**的文本（可能是"OK"这种短回应） |
| `summary` | **最有内容的那一轮**（避免短追问把成果从通知里挤掉） |
| `durability=partial(…)` | 存档写入中途失败：**不要把它当成完整记录** |
| `quiescence=unproven(…)` | 进程范围未证实停稳：**可能仍有孤儿进程**，`amp_stop` 可复查 |
| `degraded=reported-as-failed(processStatus=completed)` | 子进程成功，但记录不完整或未证实停稳 → **按封闭枚举投影为 `failed`** |
| `retryable=true` | 没干过活（`assistantMessages=0`）→ 换号重跑安全 |
| `resumable=true` | 干过活且**失败** → 不要重跑，读 artifact 接着做 |
| `artifact=INCOMPLETE(…)` | 存档写入中途失败，**不要把它当成完整记录** |

## 6. 日常使用建议

1. **长任务前先看余量**：medium 一次约 **$2.2**（25 轮实测；另一次 27 轮约 $4.1），high/ultra **无实测样本、只用保守策略值**。低于 `MODE_HEADROOM` **不会被拒绝**——池子是偏好优先（fail-open），只会在通知里带 `below-headroom`/`below-start-gate`。
2. **让 run 有序收尾**：用完 `amp_stop`（结束＋取回产出；若诊断显示 `stdout=TRUNCATED`，产出缺了早期字节，artifact 里也只有已观察到的部分）；忘了也有 20 分钟空闲回收兜底（纯泄漏保护，不再影响通知）。
3. **崩了先 `amp_runs`**：`interrupted: true` 只证明"**不在本进程且 checkpoint 未 finished**"——多 host 共用同一 `DSH_HOME` 时另一个仍活着的进程也会命中这个谓词，所以它是**救援提示而非原因判定**；`checkpoint: unreadable` 时状态是 UNKNOWN，别猜。
4. **别把活压在少数账号**：每个号有自己的余额门槛与 ~60s 限流窗口；池子会自动轮转（73 个 ref）。

## 7. 可用性结论（截至本批，逐条附证据）

**结论：可以日常使用（受控 dogfood）；不是"生产稳定"——因为下面"仍属边界"那几条是有意保留的限制，而不是未知缺陷。**

### 已在真机验证过的（不是自述）

| 能力 | 证据 |
|---|---|
| 完成通知自动开委派方 agent 的下一轮 | 那次运行里 **25 次主动轮询降到 0**；今天又多次由通知自动开轮 |
| **回合结束**通知（`state=waiting`）与**终结**通知（`state=terminal`）区分开、且 run 保持可追问 | 真机通知原文（`finished its turn and is waiting` / `state=terminal next="read the artifact, or start a new amp_run"`）；终结通知不再建议 steer、completed 的 run 不再带 `resumable` |
| 上游掐死后**成果不丢** | 三条被掐死的 run（`failure=credits` / `Compaction failed`）事后都有完整报告或骨架落盘 |
| 选号不会再挑到烧过的号 | 真机：派发落到 6/7/9 号（全新或假设全新），不再固定在 $0.90 那几个 |
| 限流是应用层、按账号、~60s 窗口 | netcap 抓包 72 条请求全 `200/201/101` + 连续 6 次的倒数 `57→41→25→10→57` |
| 记录不完整/进程未证实停稳不会被报成成功 | 测试：`durability=partial` 与 `quiescence=unproven` 都投影为 `failed` + `processStatus=completed` |
| 保留策略不会删掉救援对象 | 测试：`finished:false` / 损坏 / 无 checkpoint 的 run 在 `keepDays:0,keepCount:0` 下仍存活 |
| 并发派发不撞号 | 测试：同一 tick 两次 `choose()` 得到不同账号；回报后释放；唯一账号时 fail-open 并标注 |

### 重启后必须做的核对（唯一能证明"进程内已加载"的方法）

```bash
bash verify.sh     # 跑测试 + 查磁盘漂移 + 打印期望哈希表
# 然后在会话里：amp_accounts → source.modules / source.hash / drift
#                amp_run      → source.hash（agent 平面的 live.js；会真的起一次运行）
```

**免费的行为探针**（比哈希直观，且不花 credits、不走网络）：

```
amp_accounts({ preview: true })   # 必须返回 next.{low,medium}.{ref,state,…}
```

旧构建没有 `preview` 参数、响应里没有 `next` 字段——所以**它一出现，就证明新构建确实在跑**。这也顺便回答了"下一次运行会用哪个号、为什么"。

### 仍属"已知边界"（有意保留，不是缺陷）

1. **大输出的 spill gap 不回补**：超过内存窗时 artifact 只有已观察到的 tail；诊断会说明（有路径给路径，没有就说不可恢复）。
2. **多 host 共用 `DSH_HOME`** 时 ledger 是 last-writer-wins，且 `amp_runs` 会把另一进程的 live run 也标成 `interrupted`（救援提示，不是判定）。
3. **模式列表**在 mount 时固定（工具 schema 的 enum）：改 `modes` 需要 remount/重启；其余设置字段都是热的。
4. **`amp_runs` 是 host 级视图**，不按 session 隔离（有意的救援面）。
5. **宿主没有 timer 服务时**：sweeper 不注册 → **轮末通知与 20 分钟回收都不存在**（子进程自行退出时的终结通知仍会到）。这不是静默降级：mount 时告警、工具说明带 `WARNING`、每次派发的返回里都有 `warning` 字段。
6. **`amp_runs` 的顺序键 = `(纪元, 目录 mtime, key)`**：key 里的纪元是解析出来的（正则找 13 位数字），pid/uuid 只保证**唯一**、不表达时间，所以同毫秒用 mtime 打破平局。改动 key 形状时记得同时看 `epochOf` 与 `listDetailed()`。
7. **`amp usage` 探测在 20s 后放弃**：超时按 **unreadable** 处理（该号仍是候选，只是排位靠后），不是"余额为零"。**真实的网络往返仍可能吃掉 20s**——那段时间里这次派发的选号在等它，这是有界的等待，不是无界挂起。
8. **注册不到 settings namespace 时插件拒绝派发**：这是有意的 fail-loud（页面会同步显示原因并转为只读）。修复方式是把冲突的 namespace 或非法的存量分节改掉，然后重启。

### 数字

- 测试：**164 条全绿**（`bash test/run.sh`，约 26s）。
- 代码：`lib/` 10 个模块；`docs/` 4 份（`AMP-LIMITS` 实测表、`USABLE` 本清单、`CHANGELOG` 逐条依据、`archive/` 历史评审）。
- 评审：**7 轮**：6 轮内层逻辑评审（`REVIEW-*.md`）+ 第 7 轮 **AMP 子代理 × DSH 上游源码**契约评审（`docs/reviews/REVIEW-amp-*.md` + `docs/reviews/REVIEW-amp-summary.md`）。第 7 轮的 15 条已全部处置（见 `docs/REVIEW-LOG.md` 末节与 `CHANGELOG.md` 第 8 批）。

---

## 8. 第 8 轮（修复验证）新增/改变的可见行为

- **账号占用是"按 run 的租约"**：并发 run 即使在 fail-open 下共用同一个号，彼此也不会释放对方的占用（`release(ref, token)`）。
- **`alive` 是三态**：`true` / `false` / **`null`（quiescence 未证实，进程可能还活着）**；`status` 会写 `finished (quiescence unproven …)`。
- **`amp_accounts({limit:0})` 与设置页"显示全部"现在真的给全部**（此前三层都把 0 规范化成默认 12）。
- **空 prompt 被拒绝**，不再 claim/spawn。
- **`dispose()`（一次性 provider）最多等 `graceMs`**，超时抛 "quiescence is UNPROVEN" 而不是无限等。
