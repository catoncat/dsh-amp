# dsh-amp 后续计划

## 当前进度

| 阶段 | 状态 |
|---|---|
| 阶段 1 机制（长活 + steer + stop） | ✅ **已实测通过**：steer 落在多步任务中途、部分原产出保留、`numTurns=3`、output `STEER_OK` |
| 阶段 2 默认异步 | ✅ 由 `amp_run` 天然满足（立刻返回 run 句柄，不阻塞对话） |
| 阶段 3 配置点 + 账号池 + `amp usage` 预检 | 代码完成，等重启验收 |
| 阶段 4 UX（工具卡片 + 设置页） | 未开始（卡片走 `defineTool` 的 `presentCall`，不是 client Slot） |

### 阶段 1 验收中发现并修掉的两个真问题

1. `amp_send_message` 的空读与"卡死"**长得一样**（`newMessages: []` + `threadId: null`）→ 改成**有界等待**（默认 8s，`wait_ms` 可调）并**永远**返回 `alive` / `elapsedMs` / `idleMs` / `bytesSeen` 与一句 `hint`
2. `amp_stop` 诊断加入 **`numTurns`** —— 判断"steer 是否真的发生在中途"的直接证据


### 阶段 1 的产物

| 文件 | 平面 | 作用 |
|---|---|---|
| `lib/index.js` | host | provider（one-shot，走 `ctx.subagents`），含 9 处审计修补 |
| `lib/live.js` | — | 可插话会话：长活进程 / 保持 stdin / 增量读 / owner 围栏 / 空闲回收 |
| `lib/live-plugin.js` | agent | `dsh-amp/live` 入口，把 live 三件套注册进 preset 层 |
| `cordis.patch.yml` | host | 只放 provider 行（`modes: [low, medium]`） |
| preset `amp` | agent | 2 行 `subagent_amp_*` + 1 行 `amp-live` |

工具协议（3 个，不需第 4 个读工具）：

```
amp_run({prompt, mode})           → 立刻返回 run 句柄
amp_send_message({run, message?}) → 投递 / 插话；同时返回上次读过之后的新内容
amp_stop({run, kill?})            → 结束并一次返回完整产出
```

### 重启后的验收清单

1. 新会话工具列表出现 `subagent_amp_low`、`subagent_amp_medium`、`amp_run`、`amp_send_message`、`amp_stop`
2. 重跑 mount-validation（上次失败是运行中进程缓存了旧的 `package.json` exports；新进程解析同一子路径是成功的）
3. 真实 steer 验收：`amp_run` 起多步任务 → 中途 `amp_send_message` 覆盖指令 → 看是否改道 → `amp_stop` 收完整产出

## 已定的约束（来自你的决定，不再翻案）

| # | 约束 | 理由 |
|---|---|---|
| 1 | **不 fork `@deepseek-ai/dsh-subagent`** | 它是 host 层进程单例。fork = spawn/fork/Agent Teams/workflows/ralph/codex/claude-code 的**每一条**子代理路径都换成我的版本。影响面不由我们控制 |
| 2 | **只做加法** | 只 `registerProvider`（已有的开放扩展点）+ 只加自己的工具。爆炸半径 = "我们自己的工具不工作" |
| 3 | **账号不暴露给模型** | provider 名不含账号，池内 health-aware 选号；模型没有任何依据去选号 |
| 4 | **报错按效率优先** | 原始报错直接给模型；全文件唯一抹掉的是 `sgamp_` 字面量（理由也是效率：泄露活密钥要轮换） |
| 5 | **同一目录并发不加锁** | 想隔离去 worktree，那是使用者的决定，插件不替它决定 |
| 6 | **UX 是一等公民** | 不是只有模型看得到的东西才算功能 |

## 实测结论（先做实验再定设计，已完成）

### 结论 1｜Amp **没有**轮级打断

`kill -INT` 一个正在跑第一轮的 Amp 进程：进程**退出**，并在退出前干净地报出

```json
{"type":"result","subtype":"error_during_execution","is_error":true,
 "num_turns":1,"error":"User cancelled (SIGINT/SIGTERM)"}
```

DSH 的 `interrupt_agent` 承诺 *"Only the current turn stops… the agent itself stays available for follow-ups"* —— **这个语义在 Amp 上不存在**。

| 能力 | 结论 |
|---|---|
| steer（跑到一半插话） | ✅ 已实测生效 |
| follow-up（新进程接老 thread，`continue`） | ✅ |
| **打断当前轮但保留活着的子代理** | ❌ **做不到** |

取消是**干净**的（结构化 result + thread 保留 + 部分产出留在 thread 里），所以丢的是"活着的子代理"，不是"已做的工作"。

**因此工具叫 `amp_stop` 而不是 `amp_interrupt`** —— 名字必须诚实，否则模型会以为打完之后还能对同一个子代理说话。

### 结论 2｜`--stream-json-input` 模式下**没有 per-turn 的 `result`**

原始记录：steer 之后能 poll 到 `assistant: STEER_OK`，但**没有 `result`**；只有关闭 stdin 之后才出现
`{"type":"result","subtype":"success","result":"STEER_OK","numTurns":3}`。

**`result` 只在 stdin 关闭时出现一次。** 所以 `SubagentRun.result` 不能靠"收到 result"结算。
可用的轮级信号是 assistant 消息的 `stop_reason: "end_turn"`。

## 阶段 1｜机制：不阻塞、可插话、可停（设计已据实测修正）

- provider 长活化：`spawn` 用 `stdin: 'pipe'` + `--stream-json-input`，**保持 stdin 打开**，stdout 增量读（offset 非消耗式）
- **结算时机**：收到 `stop_reason: "end_turn"` 的 assistant 消息 / 超时 / `amp_stop`
- `amp_send_message`：跑着 → 最近 step boundary 注入（steer）；空闲 → 同进程开新一轮
- `amp_stop`：**结束本次运行**（进程级终止）。thread 保留，继续要基于同一个 thread 开新的运行
- 语义对齐 DSH 的两个动词，但**在 `amp_stop` 上明确标注与 `interrupt_agent` 的差异**

**验证**：真实任务 + 中途 steer → 改道；`amp_stop` → 拿到带 `User cancelled` 的结构化结束。


## 阶段 2｜默认异步，不占着对话

- 委派默认走后台（job id 立刻返回），用户和主 Agent 都不被阻塞
- 完成时结算通知主动到达

**验证**：发起后立刻能继续对话；`job_output` 能收到结果。

## 阶段 3｜账号池

- 凭据：`~/.dsh/.credentials.yaml` 的 `refs.AMP_API_KEY_1..N`
- **`amp usage` 预检余额**（零成本、不跑 agent）→ 主动跳过余额不足的号，而不是等报错再猜
- provider 名不含账号（约束 3）
- 每次运行把「用了哪个号、余额多少」写进日志与结果诊断

**验证**：两个号，把其中一个标成低余额 → 看是否自动跳过；余额数字与 `amp usage` 一致。

## 阶段 4｜UX（我原来漏掉的一整块）

- **工具卡片**：给 `subagent_amp_*` 注册 `tool.call.toolview`，显示 mode / thread id / 耗时 / 状态（跑着·完成·失败）/ 失败时的全文入口
- **设置页**：`settings.section` 显示各账号余额与健康状态、启用哪些 mode —— 不用去读 YAML
- **中断可达**：你说"停掉那个 Amp 任务"，主 Agent 就能调 `amp_interrupt`

**验证**：截图自查 + 你实际用一次。

## 顺序与理由

1 → 2 → 3 → 4。阶段 1 的 interrupt 实测结果会决定阶段 4 的按钮能做什么，所以它必须最先做完；阶段 3 与 1 独立，但账号池的"用了哪个号"信息要进阶段 4 的设置页。
