# Amp 上游行为/限制实测表（出率表）

只列**测到的事实**。每条注明证据强度：**可复核**（仓库内文件 / 可重放命令）、**本机操作记录**（当时观察，无留存物）、或**未知**。
"对插件的修改"只写代码里真实存在的东西。

| # | 观测 | 实测形态 | 证据（强度） | 对插件的修改 |
|---|---|---|---|---|
| 1 | **起跑门槛 = 余额（部分实测）** | `You must have at least $1 in available credits to start this request.`（`numTurns=0`，未干活）。**实测只有 medium 在 $0.90 被拒、low 在 $0.90 被接受**；high/ultra 未实测 | 本机操作记录（当轮 artifact 未留存） | `MODE_FLOORS`（`lib/ledger.js`）：`low:0`、`medium/high/ultra:1`——**high/ultra 的 $1 是保守沿用，不是实测值**；低于下限仍派发（偏好而非闸门） |
| 2 | **限流是应用层消息，不是 HTTP 429（该次捕获范围内）** | 该次捕获的 72 条请求状态为 `200/201/101`：先正常建 thread，再由 thread 通道推 `error_set{subtype:rate-limit-exceeded}`。**这证明的是那一次捕获，不是"永远不会有 429"** | 可复核（外部，**会轮转**）：本机 netcap 抓包库（`captures.db`）；重放：`netcap stats`、`netcap list --host ampcode.com`（DB 已被后续抓包覆盖过，不保证可重放）。CLI 日志：`~/.cache/amp/logs/cli.log` 里的 `type=error_set subtype=rate-limit-exceeded` | 该次没有 `Retry-After` 头可读 → 只能从文案取等待时间（`lib/outcome.js` 的 `retryAfterMs`） |
| 3 | **限流窗口 ≈60 秒（同一条时间线内）** | 连续 6 次请求的提示秒数：`57 → 41 → 25 → 10`（同一条时间线递减）→ 第 5 次回到 `57`（窗口已重置） | 本机操作记录（同 #2 的那次抓包，未留脚本）。**同一窗口内没有第二个账号作对照**，所以"按账号"是推断：换 IP 无效是实测 | **删除指数退避**：`noteRefusal` 按提示窗口冷却（缺省 60s、上限 15min）（`lib/accounts.js`） |
| 4 | **一次 medium 任务的真实花费** | 25 轮 review：`$5.00 → $2.84`（≈ **$2.2**）；早先 27 轮那次 ≈ **$4.1** | 本机操作记录：当时的 `amp_accounts` 读数与两轮 artifact（`state/dsh-amp/runs/`）。**artifact 里没有余额前快照，本地台账也已随之后运行变化，所以这两个数字无法事后重建**——它可核的是"当时看到过"，不是"随时可复算" | **余量感知选号（F26）**：`MODE_HEADROOM = { low:1.5, medium:4, high:6, ultra:10 }`（`lib/ledger.js`）。**这是排序策略值，不是实测完赛预算**——medium $4 低于上面那次 $4.1；high/ultra 无 mode-specific 样本 |
| 5 | **thread 属账号作用域** | 用别的号的 key 续同一 thread → `Thread T-… does not exist` | 本机操作记录（当轮 artifact 未留存） | 不做跨账号续接；「续跑」= 读 artifact 新开一个 run（`resumable`） |
| 6 | **已试的非交互续接路径不可用** | `amp threads continue <id> -x "…" --stream-json`（含 stdin 变体）在非 TTY 下静默 `exit 1`、只吐 TUI 转义码。**没有证明 TTY 是充分条件**，也没有试过 `-ox/--orb-execute`（该 thread 无远端 executor） | 本机操作记录（两次，未留存输出） | A2 降级：`amp_run` 不提供 `thread` 参数 |
| 7 | **SDK 暴露 `continue` 选项（未验证可用性）** | npm `@ampcode/sdk@0.1.0-…` 的 `ExecuteOptions` 含 `continue?: string \| boolean`；公开 API 只有 `execute()` 与 `threads.{new,markdown,setMultiplayer}`。该包自述"wraps the Amp CLI with the `--stream-json` flag" | 可复核（外部包，未纳入本仓库）：`package/dist/types.d.ts`、`dist/index.d.ts` | 仍用 CLI 直连；SDK 的 `continue` 对**本地** thread 是否有效**未验证**，不写进承诺 |
| 8 | **一次长上下文 run 曾触发压缩失败** | 23 轮、读了约 1.7MB 之后：`Compaction failed. Try again.`（`num_turns=23`，已产出的报告完好）。**一次个案，不是普遍规律** | 可复核：`state/dsh-amp/runs/dsh-amp-run-2-1789319407087/stream.log` 末尾 | 委派契约改成「先落盘、每节保存」；失败分类 `other`；`resumable` 指出 artifact |
| 9 | **计费与免费层（官方文本）** | 官方原文：本地 runner 免费、BYOK/自带订阅 "No Amp token fees or limits"；credits 是余额、12 个月过期；Enterprise 卡片写 "Higher resource quotas and rate limits" | 可复核（外部）：[Pricing](https://ampcode.com/docs/pricing)、[Free Agent](https://ampcode.com/news/free-agent) | 本部署的号是"每号 $5 credits"形态。**官方并未说 credits 账号一定被限流**——限流与 credits 的关系是本机观测，不是官方推论 |
| 10 | **账号池规模** | 配置里 73 个 ref（可核验）；其中 1~6 余额 $0.89~2.84、7/8 台账读数 $5.00 | 可复核：`settings.yaml` 的账号列表 + `amp_accounts`；**"7/8 全新"是本地台账未观测到的假设，不是远端未消费的事实** | 探测预算不再跳过后排新号；从未观测的号按 `FRESH_ACCOUNT_CREDITS` 授信作为**候选**（`state: 'assumed'`） |
| 11 | **未收到 prompt 的子进程仍会联系服务端，且该样本未见模型 turn** | 带相同参数启动、stdin 打开且**永不写入** prompt：8 秒内发出 `POST /api/thread-actors`（201，建 thread）、actor WebSocket upgrade、`getThreadTail`/`loadPlugins`/`loadSkills` 等；最终以 `result{error:"No valid messages found in stdin", num_turns:0}` 结束 | 本机实测（netcap 抓包；进程自行退出，输出见 `/tmp/amp-noprompt.out`）。**只有一个样本**：它支持"这一次没有模型 turn"，**不支持**"任何版本/时序都不会调用 inference"，也**不支持**"零费用"——材料里既没有拒绝前后的余额快照，也没有计费事件 | **第 7 轮已改**：`jobs.start` 的 preflight 拒绝**不再 spawn**——全部执行资源移入 `run()`（注册表只在 preflight 通过后调用它），所以被拒时**没有子进程、没有服务端 thread、没有账号占用**。本行保留为"历史上曾出现的形状"的测量记录 |

## 未知（不猜）

- **配额的计量维度与并发上限**：按请求数 / token / 并发？本机看不到。
- **`$1` 门槛的确切规则**：官方文档只说 credits 是余额；`$1` 是服务端行为。
- **用户名下那个常驻 `amp --no-tui` runner 是否共享同一份配额**：未测。
- **F26 决策还缺的数据**：low 模式的完赛花费样本；high/ultra 的启动 floor 与花费分布；任务长度/工具调用数与花费的方差；未观测账号是否可能已被别处消费。
- **同一份 credits/tier 规则是否按账号独立**：未验证。

## 待验证的实验（想更确定时做）

1. 让一个被限流的号**空闲 >2 分钟**，只发一次请求：通过 ⇒ 窗口是时间性的（已有旁证：倒数递减）。
2. 给 mitmproxy 加 `-s` 脚本 dump WebSocket 帧，直接读 thread 通道上的 `error_set` 全文（现在只有 CLI 日志这一手）。
3. 装一次 `@ampcode/sdk`，用 `execute({continue: "<本地 thread id>"})` 试续接——唯一能证实/证伪"SDK 能续本地 thread"的实验。
4. 用一个**从未观测的号**跑一次 low，记录前后余额，得到 low 的花费样本（补 #4 的缺口）。
