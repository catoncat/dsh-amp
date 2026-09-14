# dsh-amp

把本机 [Amp](https://ampcode.com) CLI 接成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) 的**子代理 provider**，另外给一条**可插话的长活会话**路径。

> 非官方适配器，与 Amp/Sourcegraph、DeepSeek 均无隶属或背书关系；它驱动的是你自己已经装好的 `amp` 可执行文件。

英文文档见 [README.md](README.md)。

## 它提供什么

**一次性委派**：`subagent_amp_low` / `subagent_amp_medium`（每个 Amp mode 一个 provider，`amp-<mode>`）。

**可插话长活**：

| 工具 | 作用 |
|---|---|
| `amp_run` | 起一个 Amp 进程执行任务，立刻返回 run handle |
| `amp_send_message` | 再发一条消息（忙时 steer、闲时开新回合），并返回上次读取后的全部产出 |
| `amp_stop` | 结束 run 并取回产出 |
| `amp_runs` | 列出磁盘上留下记录的 run —— 崩溃/重启后的救援面 |
| `amp_accounts` | 余额、下一次派发会选哪个号、以及**当前加载的构建指纹** |

回合结束后 run **保持打开**：委派方 agent 会收到通知，可以继续对话或结束并收集。

**账号池**：`~/.dsh/settings.yaml` 里每个凭据 ref 是一个池成员；派发会跳过被限流或余量不足的号，
按各自的窗口记住拒绝，并且**绝不**回落到本机 `amp login` 的账号（凭据解析不出来就直接拒绝运行）。

**落盘记录**：每个 live run 在 `$DSH_HOME/state/dsh-amp/runs/` 下追加脱敏流 + checkpoint，
被掐死/崩溃的 run 事后仍可读；记录不完整时 `durability` 会如实报告。

## 要求

- 带 `subagents`、`subprocess`、`credentials` 的 DSH；live 路径还需要 **jobs** 行（没有 job slot 时拒绝启动）。
- `amp` CLI 在 `PATH` 上（或用 `ampBin` 指过去）。
- `~/.dsh/.credentials.yaml` 里有 Amp 凭据 ref。

## 安装

```bash
git clone https://github.com/catoncat/dsh-amp.git $DSH_HOME/plugins/dsh-amp
cd $DSH_HOME/profiles/<profile>
npm install --save $DSH_HOME/plugins/dsh-amp
```

本 bundle 贡献的是 **host 平面行**（`cordis.patch.yml`）：按配置的 mode 注册 `amp-<mode>` provider、
提供 `ampAccounts` 服务、注册 `dsh-amp` 设置命名空间。它**故意不授予**模型可见的工具 ——
`subagent_amp_*` 与 `amp_run` 家族应放在 agent preset 里。

## 配置

设置页（或 `settings.yaml`）里的 `dsh-amp` 段：

| 键 | 默认 | 含义 |
|---|---|---|
| `accountRefs` | `[AMP_API_KEY_1]` | 池子成员（凭据 ref），按偏好排序 |
| `modes` | `[low, medium, high, ultra]` | 注册哪些 provider。**改它需要重启**（工具 schema 在 mount 时固定 enum） |
| `ampBin` | `amp` | 可执行文件 |
| `visibility` | `private` | 传给 `amp --visibility` |
| `keepThreads` | `true` | 加 `--no-archive-after-execute`，thread 保持可审计 |
| `liveIdleTimeoutMs` | `1200000` | 无人过问的 run 被回收的空闲上限 |
| `graceMs` | `10000` | 交给 subprocess seam 的终止宽限 |

## 测试

```bash
bash test/run.sh     # 164 条；伪造 DSH seam，不碰真实台账、不花 credits
bash deploy.sh       # 同步到 profile 安装副本并打印哈希
bash verify.sh       # 测试 + 漂移 + 重启后要比对的哈希表
```

套件需要 DSH 的包（`@deepseek-ai/dsh-tools` / `-llm` / `-subagent` / `schemastery`），
会自动从全局 DSH 安装里找；也可显式指定：

```bash
DSH_NODE_MODULES=/path/to/node_modules bash test/run.sh
```

## 运维必读

- **改了插件不重启宿主等于没改**：bundle 以真实副本形式被进程内加载。`deploy.sh --check` 说
  `in-sync` 也**不能**证明运行的进程加载的是新构建；唯一证据是运行时指纹
  （`amp_accounts.source.hash` / `amp_run.source.hash`）。
- **通知是重点**：插件镜像宿主的 per-agent 唤醒预算（连续 3 次唤醒后降级为 `inject`，不丢通知）。
- **余额来自 `amp usage`**：不花 credits、不起 agent；探测有 20s 真实 deadline，读失败按"未知"处理，绝不当作 0。
- **已知边界**见 [`docs/USABLE.md`](docs/USABLE.md) §3：包括 Amp 没有回合级取消（停就是结束 run）、
  非交互 thread 续接不可用（续跑＝读 artifact 新开一个 run）。

## 文档

| 文件 | 内容 |
|---|---|
| [`docs/USABLE.md`](docs/USABLE.md) | 能用什么、怎么读一条通知、诚实的边界清单 |
| [`docs/AMP-LIMITS.md`](docs/AMP-LIMITS.md) | 上游实测（门槛、限流窗口、花费样本）与证据强度 |
| [`docs/DESIGN.md`](docs/DESIGN.md) | 为什么是这个形状 |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | 每一批改了什么、凭什么 |
| [`docs/REVIEW-LOG.md`](docs/REVIEW-LOG.md) | 八轮评审每条发现的处置 |
| [`docs/reviews/`](docs/reviews/) | 评审报告原文 |

## 安全

- Amp token 在派发时从 **DSH 凭据 ref** 读取，作为 `AMP_API_KEY` 注入**单一子进程**；
  子进程 seam 会先擦除环境里 credential-shaped 的变量。
- token 形状的字面量在进入 transcript、诊断与磁盘记录前会被替换。
- 账号视图是仅回环的 JSON 路由，还要求匹配的 `Host`/`Origin` 与插件自有 header。
- **不要提交** `.credentials.yaml`、`settings.yaml`、`state/`；`.gitignore` 已覆盖。

## 许可

MIT，见 [LICENSE](LICENSE)。
