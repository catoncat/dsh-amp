# dsh-amp 代码审查报告

## 摘要（最关键 3 条）

1. **输入与输出都存在静默数据丢失**：one-shot prompt 超过 1 MiB 会被无提示截断；live NDJSON 跨两次增量读取时，前一次尾部半行会被永久丢弃。
2. **live 结算存在严重并发与超时缺口**：同一 run 并发两次 `amp_stop`，后一次可在进程仍运行时提前报告 `completed` 并删除句柄；正常 stop 的 `waitForExit()` 没有任何 deadline，可能永久挂住。
3. **账号池不能兑现“耗尽账号会被跳过”**：并发 dispatch 没有 reservation，会同时选中同一账号；未知 usage 格式、失败后遗留的正余额都会继续放行实际已耗尽的账号。

以下问题均按当前文件行号记录。“已确认”表示仅由代码与已安装 DSH seam 合同即可推出；“疑似”表示仍需真实运行验证。本次没有运行 `amp`。

## 发现表

| 严重度 | 文件:行 | 问题 | 最小触发条件 | 建议 |
|---|---|---|---|---|
| 高 | `lib/index.js:324-341` | **已确认：one-shot prompt 被静默截断。** `prompt.slice(0, STDIN_MAX_BYTES)` 既不报错也不向结果标注截断；而且 `slice` 计 UTF-16 code unit，常量却名为 bytes。子代理可能基于不完整指令成功返回，形成不可见的数据丢失。 | 合并后的纯文本 prompt 长于 1,048,576 个 code unit。 | 在 spawn 前按 UTF-8 bytes 校验并明确拒绝，或完整送入 stdin；若必须限制，返回结构化错误，不能静默裁切。 |
| 高 | `lib/live.js:173-218` | **已确认：增量 NDJSON 不保留半行。** `readFrom()` 后立即推进 offset，再对本次 delta 单独 `split('\n')`；尾部不完整 JSON 被计为 unparsed，后续剩余字节从新 offset 读取，永远无法重新拼合。跨 chunk 的 UTF-8 code point 也有同类问题。thread id、assistant 文本、`end_turn`、最终 result 均可能丢失。 | 任一 JSON 行在两次 `absorb()` 之间只写出前半段；普通 pipe chunk 边界即可触发，不要求异常输出。 | session 持有 byte buffer/decoder 与 `pendingLine`；只解析完整换行记录，进程结束时再处理最后一行。不要先消费无法完整解析的尾部。 |
| 高 | `lib/live.js:238-263`, `lib/live.js:497-523` | **已确认：并发 `amp_stop` 可提前成功并丢句柄。** 第一次 `finish()` 设置 `settling=true` 后 await；第二次看到 `settling` 直接 return，随后以 `result===undefined` 判作非失败、返回 `completed`，并从 `sessions` 删除仍在运行的 session。 | 同一 owner 对同一 run 几乎同时调用两次 `amp_stop`，第二次在第一次 `waitForExit()` 未结束时进入。 | 给 session 保存唯一的 `settlePromise`，所有 stop/sweeper 调用 await 同一个 promise；只由该 promise 的单一收尾路径删除 session 和生成终态。 |
| 高 | `lib/live.js:38`, `lib/live.js:238-263` | **已确认：正常 stop 与空闲回收没有实际超时。** 注释称“bounded, then hard-stop”，也定义了未使用的 `STOP_GRACE_MS`，但 `waitForExit()` 未传 AbortSignal；该 API 合同明确为无 signal 时可无限等待。若 EOF 后仍有后代进程存活，`amp_stop` 永不返回，idle session 永久停在 `settling`。 | Amp 或其后代在 stdin EOF 后不退出，且 managed range 一直非空。 | 用 `STOP_GRACE_MS` 建 deadline AbortSignal；超时后 `terminate()`，再用第二个有界 wait 验证 quiescence，并把无法证明退出报告为 error。 |
| 高 | `lib/index.js:337-340`, `lib/index.js:377-417` | **已确认：失败输出可泄露注入的 API key。** token 被放进子进程环境；失败详情直接拼入未 sanitize 的 `result.error`、system error 和 stderr，随后把原始 `detail` 写进返回给模型的 output。仅 `snapshot.diagnostic` 会经过 `truncate()`/`sanitize()`，挡不住 output。 | 子进程以非成功状态结束，且 stderr 或结构化 error 含 `$AMP_API_KEY`（例如任务或故障处理把环境打印到 stderr）。 | 在任何 stderr/error 进入 `detail` 前统一 sanitize；最好按本次精确 token 做替换，不只依赖 `sgamp_` 形状。日志、output、diagnostic 共用同一脱敏边界。 |
| 中 | `lib/accounts.js:167-220`, `lib/index.js:260-268` | **已确认：并发选号没有 reservation。** `choose()` 只读余额，`noteDispatch()` 只增加 runs、不扣减或标记 in-flight；多个同时开始的 run 都会选中配置顺序中的第一个正余额账号，可能并发透支并绕过池的分散能力。 | 两个或更多 provider/live run 在首账号 ledger 仍为正时并发调用 `choose()`。 | 在池内串行化 choose+reserve，记录每账号 in-flight/保守预算，并在 run settle 后 release + refresh；至少用轮转 reservation 防止同瞬间全部命中一个账号。 |
| 中 | `lib/accounts.js:61-85`, `lib/accounts.js:176-218`, `lib/accounts.js:256-262` | **已确认：usage 解析未知形状与陈旧正余额都会放行耗尽账号。** exit 0 但金额字段未识别时，`isUsable({})` 明确 fail-open；已有正余额时 `choose()` 直接返回，未使用已实现的 `stale()`。一次 refresh 失败后，旧正余额可无限期继续使用。 | (a) `amp usage` 改文案但仍 exit 0，实际余额为 0；或 (b) ledger 曾记录正余额，之后账号耗尽且后置 refresh 失败/未完成。 | “读不到”与“有余额”分状态；未知格式最多作为一次受控降级而非 confirmed。选择时执行 stale 重验，对连续不可读设置短期 quarantine/退避，并在诊断中明确余额未知。 |
| 中 | `lib/live.js:232-235`, `lib/live.js:414-465` | **已确认：子进程自行退出不会更新 live 状态。** live 路径从不观察 `handle.done`；`alive` 仅等于 `!session.finished`，而 `finished` 只在解析到 result 或主动 finish 后设置。CLI 已退出但 result 丢失/不存在时，会持续向模型声称“process is alive”，最长到 idle sweeper 介入。 | Amp 自行退出，且没有可解析 result（包括上述半行丢失、非结构化崩溃或 spawn 后 provider failure）。 | 启动时立即挂接 `handle.done`（含 rejection handler），记录 exit outcome 并触发一次最终 absorb；`alive` 应来自真实 process outcome，而不是协议消息推断。 |
| 中 | `lib/live.js:33-34`, `lib/live.js:173-180`, `lib/index.js:64-66`, `lib/index.js:144-150`, `lib/index.js:343-388` | **已确认：配置了 spill 却从不读取，超大输出仍然丢失。** 一旦内存窗口滑动，代码只标记 lossy 并解析 tail；即使 `spillPath` 保存了完整流，也不恢复。one-shot 超过 4 MiB、live 两次读取间超过 8 MiB 时，开头及 JSON 边界会丢失，最终还可能被误判为“no result message”。 | 单次 one-shot stdout 超过 4 MiB，或 live 消费间隔内新增 stdout 超过 8 MiB（且总量不超过 spill cap 时完整数据其实仍可恢复）。 | lossy 时从 spill 按 offset 恢复完整 bytes，或明确把超限作为 error 并给可读取入口；不能只声称“complete stream in spill file”却不使用它完成结算。 |
| 中 | `lib/ledger.js:46-68`, `lib/ledger.js:92-123` | **已确认：多个 DSH 进程共享 ledger 时会 last-writer-wins 丢更新。** 每个进程启动时各自读取全量 state，之后每次把自己的旧快照整体 rename 覆盖目标；atomic rename 只防半写，不能防跨进程 clobber。 | 两个 DSH host 进程共用 `~/.dsh/state/dsh-amp/ledger.json`，分别更新不同账号或 runs；后保存者未重读对方更新。 | 写前加跨进程锁并在锁内重读+合并，或按账号拆记录/使用 SQLite；保留 atomic replace 作为落盘完整性措施。 |
| 低 | `PLAN.md:7-10`, `PLAN.md:84-117`, `package.json:6`, `cordis.patch.yml:14-23` | **已确认：文档阶段与实际部署不一致。** PLAN 称阶段 4 未开始，但 settings page、route 与 client export 已实现；又称 `end_turn` 是“结算时机”，代码只是标 idle；第 115 行仍写不存在的 `amp_interrupt`。package description 枚举四种 mode，而实际 bundle/preset 仅挂 low、medium，容易让安装者误判当前可用工具。 | 按 PLAN 或 package description 验收/运维当前插件。 | 把 PLAN 拆成“已实现/待验收/未实现”，改 `amp_interrupt` 为 `amp_stop`，说明 `end_turn` 仅代表 idle；package description 改为“per configured mode”或明确默认部署只有 low/medium。 |

## 已核对确认无问题的点

- **凭据不在 argv**：one-shot 与 live 均通过显式 `env.AMP_API_KEY` 注入，prompt 走 stdin；进程列表不会直接暴露 key 或 prompt（`lib/index.js:304-340`, `lib/live.js:295-330`）。
- **缺失凭据不会回退到本机 `amp login`**：pool 与无 service fallback 都会拒绝空 token（`lib/accounts.js:170-175`, `lib/index.js:220-229`, `lib/live.js:158-170`）。
- **offset reader 本身是非消耗式的**：使用的是调用方自持 whole-stream byte offset；问题在插件没有 framing buffer，不在 DSH reader 合同（`lib/live.js:173-189`）。
- **one-shot 对 exit/result 双通道做失败分类**：非零 exit、缺 result、`is_error`、system error 都不会被当作成功（`lib/index.js:343-355`）。
- **owner 围栏在正常 agent tool 调用下有效**：session 保存 `exec.agent.id`，不同 id 会被拒绝（`lib/live.js:221-229`, `lib/live.js:331-352`）。run id 可预测本身不足以越权。
- **host provider 名与实际 preset/patch 一致**：当前部署均为 `amp-low`、`amp-medium`；账号没有编码进 provider 名。`cordis.patch.yml` 与 `.agent-presets/amp/agent.cordis.yml` 的 mode 列表一致。
- **stderr/stdout 都有内存上限**，且 subprocess service 在自身 dispose 时负责终止仍登记的 managed processes；未发现 token 被放入 spawn argv。
- **ledger 单次写不会留下半个 JSON**：同一进程内同步写 temp + rename 可保证落盘原子性；上表问题仅是多进程快照覆盖。

## 未覆盖与不确定性

- 按要求**没有运行 `amp` 自身**，没有做真实 steer、stop、余额预检、线程保留或账号耗尽实验。
- 没有重启 DSH、没有执行 mount-validation，也没有打开浏览器验证 settings UI；因此未验证 Cordis 注入顺序、HMR、Remote 写设置和 Web route 的实际挂载。
- 没有动态 fault injection：未实际制造半行 stdout、EPIPE、超大行、managed descendant、并发 stop 或多进程 ledger 写入；这些发现来自代码路径与本机已安装 `@deepseek-ai/dsh-subprocess` 类型/实现合同。
- owner 围栏在 `exec.agent === undefined` 时会放行（`lib/live.js:221-228`），而 send/stop 不像 run 那样显式要求 calling agent；当前未确认 DSH 的 agent-plane tool runtime 是否可能产生这种调用，故未把它列为已确认越权缺陷。若 runtime 允许无 agent 调用，应改为 fail closed。
- 未读取或打印 `.credentials.yaml` 的真实 token；因此没有验证是否所有 Amp key 都符合当前 `sgamp_…` redaction 正则。
- 未发现插件自带测试。仅执行了所有 `lib/*.js` 的 `node --check`（通过），并用纯函数 fixture 确认未知 usage 文案会得到空金额且 `isUsable` 返回 true。
