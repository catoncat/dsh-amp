# dsh-amp 机制设计：agent 侧与用户侧

这份文档定义的是**契约**，不是待办清单。实现可以变，契约不能悄悄变；每一条都说明"谁看得到、看到什么、凭什么敢这么说"。

## 0. 三条不可让步的目标

1. **诚实**：任何"活着 / 已投递 / 成功 / 已停止"的断言，都必须有进程事实或协议事实支撑。做不到就说不确定，而不是给一个好看的默认值。
2. **可观测**：agent 和用户问"现在有几个在跑、各自到哪、谁在付钱"，必须得到同一个答案。
3. **可收敛**：完成必须**主动到达**（不靠轮询）；产出必须能落盘；十路扇出不能炸掉委派方的上下文。

## 1. 统一状态模型（两侧同一套词）

内部事实与呈现状态分开，呈现层不许自造同义词：

| 呈现状态 | 内部事实 | 含义 | 允许的动作 |
|---|---|---|---|
| `running` | 进程活、本轮未结束 | 正在干活 | steer / stop / 读 |
| `idle` | 进程活、`end_turn` 已到 | 本轮结束，会话仍开 | 再发一轮（不 steer）/ stop / 读 |
| `finished` | 已结算（`result` 或已 `finish`） | 已收口，产出可取 | 只能 `amp_stop` 取产出 |
| `exited`（瞬时） | `handle.done` 已 resolve | 子进程自行结束 | 立即收敛为 `finished` |
| `finishing` | `settling` | 正在收尾 | 等同一个 settle |
| 失败 | `is_error` / 非零退出 / 无 result | 失败 | 读诊断，按 thread 续跑 |

**禁止**：把"读不到输出"当成"还活着"；把 `delivered: true` 建立在意愿而非写入结果上；把无法证明的安静说成"干净停止"（必须报 `quiescence=UNPROVEN`）。以上三条都已在实现中落为字段。

## 2. Agent 侧契约（模型作为用户）

| 工具 | 语义 | 必须返回的诚实字段 | 失败语义 |
|---|---|---|---|
| `amp_run({prompt, mode, thread?})` | 起一个可插话的运行 | `run` / `threadId` / `account` / `cwd` / `source{file,hash}` | 无法选号即拒绝，绝不回退到本机 `amp login` |
| `amp_send_message({run, message?, steer?, wait_ms?})` | 插话，或只读增量 | `status` / `alive` / `exitCode` / `idleMs` / `bytesSeen` / `unparsedLines` / `lossy` / `stdinError` | 写入失败必须抛，不许回 `delivered: true` |
| `amp_stop({run, kill?})` | 结束并取完整产出 | `stopReason` / `diagnostic`（含 `quiescence`、`writes`、`numTurns`、`subtype`） | 无法证明安静要明说；有界，不挂 |
| `amp_accounts({refresh?, limit?})` | 账号与余额视图（免费） | `source{file,hash}` / `rows[]` | 读不到就说读不到，不算 0 |

**机制缺口（按优先级）**

- **A1 ★ 完成通知**：`amp_run` 目前完全靠轮询（实测：56s / 193s / 246s 三次都是我主动读）。正解已查实——注册进 `ctx.jobs`：`readOutput` 复用 `absorb` 增量、`done` 接 `settlePromise`、`cancel` 接 `finish(kill)`、`owner` 传调用方 agent。白拿三样：完成推送、`job_list`/`job_output`/`job_kill` 统一入口、平台级 session-id 围栏（含默认 10 的并发上限）。
- **A2 thread 续跑**：`amp_stop` 后只能从零重开。Amp 支持基于同一 thread `continue`（PLAN 实测结论 1），所以 `amp_run` 必须接受 `thread`。这是 agent 和用户都会立刻感到的缺口。
- **A5 产出落盘**：把完整产出写到 `state/dsh-amp/runs/<run>.md`，工具只回"路径 + 有上限的摘要"。这是十路扇出不炸上下文的前提。
- **A3 steer 的真实落地**：现在只是回显调用方的 `steer` 标志。可按发消息前的状态如实回答：`appliedAs: 'steer (mid-turn)' | 'new turn (child was idle)'`。
- **A6 并发上限**：第 11 个 job 会被 registry 拒绝，必须翻译成人话并给出可行动作。

## 3. 用户侧契约（人作为用户）

- **账号页**（已有）：显示有哪些号、各剩多少、下一个会用哪个、可增删。补两项：**当前加载的构建指纹**（`source.file/hash`，回答"我改的东西到底生效没有"）、**可用 mode 列表**。
- **运行卡片**（缺）：每个 `amp_run`/`amp_send_message`/`amp_stop` 调用的卡片要显示 mode / thread / 耗时 / 状态 / 失败全文入口。这是用户"看见 Amp 在干什么"的唯一入口，不能只有模型能看。PLAN 阶段 4 说的就是这个，一直没做。
- **中断可达**（缺）：用户说"停掉那个 Amp 任务"时，agent 必须能执行；A1 落地后这条路是 `job_kill`（平台围栏）+ `amp_stop`。卡片上是否放按钮属于 A1 之后的事。
- **一致性**：工具输出、卡片、设置页必须同词同义（直接用 §1 那张表）。

## 4. 一次委派的生命周期（谁在什么时候看到什么）

```
发起 ──▶ 冷启动 ~11s（实测）──▶ running ──▶ [steer 可插入] ──▶ idle
                                      │                          │
                                      └────── stop/结束 ◀────────┘
                                                  │
                                      finished（产出可取 + 落盘）
                                                  │
                                     通知到达 agent（A1 后）／卡片更新
```

每个转换点的义务：
- **冷启动**：`amp_send_message` 必须解释这个等待（已有 `hint`），且默认等待要短于冷启动时给出"继续等"的明确指引。
- **idle**：状态必须与 `running` 可区分（已有）。
- **收敛**：结算必须幂等（并发 stop 共享同一个 settle，已实现）；进程自退必须翻转 `alive`（已实现并真机验收）。
- **结束**：通知必须主动到达（缺，A1）；产出必须可落盘（缺，A5）。

## 5. 实施顺序与验收

| 序 | 项 | 验收方式 |
|---|---|---|
| P0 | A1 jobs 接入 | 测试：注册/结算/取消/Fence；真机：`job_list` 能看到在跑的 run，结束时有通知 |
| P0 | A2 thread 续跑 | 测试：`thread` 进入 argv；真机：续跑后 thread 不变 |
| P1 | A5 产出落盘 | 测试：文件内容 = 完整产出，工具回路径 |
| P1 | B2 运行卡片 | 用户实际用一次 + 截图自查 |
| P1 | B3 指纹/mode 进设置页 | 页面能看到 hash，且与 `amp_accounts.source.hash` 一致 |
| P2 | A3 / A6 | 测试：idle 时回调返回 `new turn`；第 11 个 job 的报错可行动 |
| P2 | C 术语一致性 | 三处输出逐字段比对 |

## 6. 不做的（边界，不翻案）

- 不 fork `dsh-subagent` 注册表（进程单例，爆炸半径不可控）。
- 不假装支持轮级打断（Amp 没有；OBSERVED：SIGINT 直接结束进程）。
- 不把账号暴露给模型（provider 名与工具输出都不含可用来选号的信息）。
- 不替使用者决定目录并发隔离（要隔离去 worktree）。
- 报错按效率优先，原始报错直给；全插件唯一抹掉的是 token 字面量。

## 7. 部署与"我到底跑了哪份代码"

profile 以 `file:` 声明本插件 → 包管理器装成**真实拷贝**（F20）。所以：
`bash deploy.sh` 同步 → `bash deploy.sh --check` 查漂移 → **重启 Host** → `amp_accounts.source.hash` 零成本核对。
任何"我改好了"的结论，都必须先过最后这一步。
