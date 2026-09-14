# REVIEW-amp-contract：宿主契约一致性评审
> 评审员：AMP contract 子代理；对象 revision：`accounts 691b017f2cbf`、`artifact 8f3ec02d7d15`、`client bc9dc21e75d7`、`index 2a98f74f7a90`、`ledger 209c5fc3ebea`、`live-plugin 4cbeffeb3216`、`live da693738896f`、`outcome 82bbd05cc37c`、`source 152d5ec53d5`、`web 5561f4befb7f`；dsh 源码 revision `c291e796`
> 方法：先以 `shasum -a 256 lib/*.js` 复核 brief revision；随后逐文件读取插件与 `docs/REVIEW-LOG.md`，并对读 DSH master `c291e796` 的 `packages/subagent/subagent/src/{types,index,out-of-process}.ts`、`packages/subprocess/subprocess/src/types.ts` 及 README、`packages/settings/settings/src/index.ts` 及 README、client modules/ui-settings 的 manifest/system/client 源码，以及 credentials、webserver 包源码。
> 编译侧核对本机 `@deepseek-ai/*` `0.1.5-rc.2` manifests、exports 与三个 client 注入包是否存在；执行 `dsh --profile web --dump-config`、`bash test/run.sh`（135/135 通过），收尾以脱敏 `ps` 采样核对本次 medium Amp 子进程 argv 和环境变量键名。除本评审自身 run 外未额外发起付费 live run。

## 1. 结论（3-6 行）

共记录 0 个 P0、5 个 P1、2 个 P2：其中 6 条为源码对照（usage 条目另经 Lead 复核），1 条为 SUSPECTED。
provider 注册、spawn 主路径、settings 合并、credentials、bundle 与 web route 的大部分调用符合宿主契约。
主要缺陷集中在资源发布前回滚、停稳错误传播、异步配置权威性和 usage deadline，均可导致错误账号占用、假停稳或派发卡死。
现有 135 项测试全绿，但没有实证复现上述宿主生命周期与确定性交错；client inject 在真实 web 组合中的可达性仍待验伪。

## 2. 发现（按 P0→nit）

### [P1][源码对照] settings namespace 注册失败被吞掉后形成页面与派发的双真源
- 插件侧：`lib/index.js:540-548`、`lib/index.js:552-569`
- DSH 依据：`packages/settings/settings/src/index.ts:409-426` 明定 namespace 唯一，重复注册会抛错；`:436-448` 表明只有成功注册返回的 scope 才持有按“默认值 → base → 用户层”解析的权威值；`packages/settings/settings/README.zh.md:76` 明定注册时非法存量分节同样直接拒绝注册。
- 为什么错 / 影响：插件把重复 namespace 或非法存量配置导致的注册错误仅记 warning 后 `return`。此时 provider 与账号池继续读取初始化时的 `holder.value`（composition config），`ampSettings` 服务也不会提供；但已占用该 namespace 的其他注册者仍会出现在 settings Remote，`lib/client.js:386` 仍向 `dsh-amp` 写值。结果是页面可显示并成功保存一套值，实际 Amp 派发永久使用另一套值，直到重启/修复注册冲突，属于可观察的错误行为与谎报。
- 复现或验证方式：在同一 host 先注册一个名为 `dsh-amp` 的 namespace，再挂载本插件；确认只出现 warning，随后通过 `remote.settings.update('dsh-amp', { accountRefs: [...] })` 写入。页面写入成功，但 provider 的下一次 `start()` 仍从原 composition `holder.value` 选号。非法 `settings.yaml` 分节也可触发同类分裂。
- 建议最小修法：不要捕获 `settings.register()` 失败，让 host 按 DSH 的 fail-loud 契约拒绝挂载；若必须降级，至少禁用 provider、账号 web 路由与 client 编辑面，不能继续提供与 settings 脱钩的服务。

### [P1][源码对照] `start()` 发布前失败不回滚账号 claim，并提前记成已派发
- 插件侧：`lib/index.js:276-284`、`lib/index.js:286-320`、`lib/accounts.js:245-268`
- DSH 依据：`packages/subagent/subagent/src/types.ts:363-371` 要求 provider 在 `start()` fulfillment 前拥有 setup，并在 reject 前清理所有未发布的部分资源；`packages/subagent/subagent/src/index.ts:545-568` 说明 provider promise reject 时调用方拿不到 run，因此没有可供调用方 `dispose()` 的句柄。
- 为什么错 / 影响：`pool.choose()` 在 `lib/accounts.js:253-260` 原子写入 30 分钟 claim，插件紧接着 `noteDispatch()`，但之后 prompt block 校验、cwd 解析、`resolveExecutable()` 都可能在 run handle 发布前抛错。所有这些路径都没有 `release()`，调用方也拿不到 run 来清理。具体交错：A 选中账号 X 并 claim → 非文本 prompt（或无效 cwd/找不到 `amp`）令 `start()` reject → X 保持 claimed 30 分钟且 ledger 的 runs 已加一 → B 被错误推到较差账号；若全池均 claimed，状态还会被标成共享占用。该任务从未 spawn，却被台账算作派发。
- 复现或验证方式：用两个可解析 ref，调用 provider `start()` 时传一个非 text block，随后立即调用 `pool.choose()`；应观察第二个账号被选中，且 X 的 ledger `runs` 已增加。等待 30 分钟 TTL 后 X 才自动恢复。再以不存在的 `ampBin` 重复，可覆盖异步 `resolveExecutable()` reject 路径。
- 建议最小修法：把所有纯校验与 `resolveExecutable()` 移到选号前；选号后用 `try/catch` 包住发布前 setup，失败时调用显式 `pool.release(ref)`，并把 `noteDispatch()` 移到 spawn 成功之后。

### [P1][源码对照] `dispose()` 吞掉停稳证明失败，违反 quiescence 契约
- 插件侧：`lib/index.js:493-505`
- DSH 依据：`packages/subagent/subagent/src/out-of-process.ts:237-256` 规定 `dispose()` 必须等待 backend teardown 到真实退出；`packages/subprocess/subprocess/src/types.ts:185-191` 规定 `waitForExit()` 只有证明受管范围为空才返回 `true`，无法证明时抛错；`packages/subagent/subagent/src/types.ts:329-333` 将“reach child quiescence”列为 `dispose()` 契约。
- 为什么错 / 影响：插件调用 `handle.terminate()` 后捕获并丢弃 `waitForExit()` 的任何 rejection，随后 teardown resolve，令上层认为 dispose 已完成。若 subprocess owner 丢失范围观测能力，Amp 或其后代可能仍运行，但 holder 已失去错误信号；宿主可以继续释放资源或复用同一工作区，产生并发写入与重复工作。注释“nothing further to do”不改变 DSH 对停稳证明失败必须传播的要求。
- 复现或验证方式：给 `state.handle` 注入 `terminate()` 正常、`waitForExit()` reject `owner observation failed` 的假句柄，调用返回 run 的 `dispose()`；当前实现会 resolve，契约实现应 reject。也可用 subprocess-local 的 owner 观测失败 fixture 做集成验证。
- 建议最小修法：不要吞 `waitForExit()` rejection；让 teardown reject，使 `dispose()` 的调用方获知未证实停稳。若要补充上下文，用带 `cause` 的 Error 重新抛出。

### [P1][源码对照] settings 已提交到权威 scope 后，下一次派发仍可能读取旧 `holder.value`
- 插件侧：`lib/index.js:515`、`lib/index.js:548-567`、`lib/index.js:270`
- DSH 依据：`packages/settings/settings/src/index.ts:114-127` 明定 `scope.get()` 是当前权威快照，而 `watch()` 调用异步执行；`:791-807` 的提交顺序是先把 `registration.resolved` 换成 next，再把 watcher 排入 Promise microtask。
- 为什么错 / 影响：插件没有让 provider 每次从 `scope.get()` 读权威值，而是只在异步 watcher 中更新旁路镜像 `holder.value`。具体交错：settings commit 已把 `accountRefs=A→B` 写入 scope → watcher 尚未开始 → 同一提交触发的同步 `settings/updated` listener（或该 microtask 前的任一调用）启动 Amp → `start()` 在 `lib/index.js:270` 读到 A 并用旧账号派发 → watcher 随后才把 holder 改为 B。因 DSH 明确将 watcher 设计为异步观察者，不能把它当同步状态传播机制。`ampSettings.subscribe` 也忽略 watcher 的 `next` 参数而读取 holder，放大了对回调先后顺序的依赖。
- 复现或验证方式：挂一个同步 `settings/updated` listener，在收到 `dsh-amp` 更新时立即调用 provider `start()`，并用假 credentials/subprocess 记录选中的 ref；当前会记录旧 ref，而此时 `scope.get()` 已是新 ref。
- 建议最小修法：让 provider、pool 和 `ampSettings.current()` 直接按操作调用 `resolveConfig({ ...compositionConfig, ...scope.get() })`；订阅回调用 DSH 交付的 `next` 计算并传出，不以 holder 更新顺序作为正确性前提。

### [P1][实证/源码对照（Lead 复核）] `amp usage` 把 termination grace 误当执行超时，网络挂起会无限阻塞选号
- 插件侧：`lib/accounts.js:30`、`lib/accounts.js:141-166`
- DSH 依据：`packages/subprocess/subprocess/src/types.ts:83-96` 明定 `graceMs` 只供终止流程和退出后的 pipe drain 使用，执行取消由 `signal` 驱动；`packages/subprocess/subprocess/README.md:65` 再次明确“callers own deadlines”，`terminate()`/abort 才启动终止过程。
- 为什么错 / 影响：名为 `USAGE_TIMEOUT_MS` 的 20 秒值只传给 `graceMs`，spawn spec 没有 `signal`，也没有任何 timer 调 `terminate()`。因此 `amp usage` 在 DNS、代理或上游连接上挂起时，`handle.done` 可以永远不 settle。`select()` 在 stale/unknown 账号上等待它，整个 provider `start()` 卡死；设置页 `refresh=1` 的 worker 也会卡死，所谓“bounded reads”只限制并发数，不限制时长。
- 复现或验证方式：把测试 subprocess 的 `done` 设为永不 settle，记录 20 秒后 `terminate()` 是否被调用；当前为 0 次，`pool.choose()` 与 `pool.list({ refresh:true })` 均仍 pending。该实验不需真实 Amp 请求。
- 建议最小修法：为每次 usage probe 建立 `AbortSignal.timeout(USAGE_TIMEOUT_MS)` 并传给 `resolveExecutable` 与 `spawn`；在 `finally` 中 `terminate()` 并有界等待 `waitForExit()`，把超时作为 unreadable 而非余额为零。

### [P2][源码对照] provider remount 会重置远端 run id 计数，可与尚存旧 run 重号
- 插件侧：`lib/index.js:297-299`、`lib/index.js:572-581`
- DSH 依据：`packages/subagent/subagent/src/types.ts:308-314` 要求 remote provider 的 `SubagentRun.id` 在 parent namespace 内唯一；`packages/subagent/subagent/src/index.ts:502-505` 明定移除 provider 只阻止新 start，不撤销已经返回给 holder 的 run。
- 为什么错 / 影响：id 来自每次 `apply()` 新建的进程内计数器。具体交错：父会话 P 启动旧 provider 的第一个 low run，得到 `dsh-amp-low-1` 且仍在运行 → HMR/remount 移除旧 provider，但旧 run 按契约继续存活 → 新插件 counter 从 0 开始 → P 再启动 low run，又得到同一个 id。即使 DSH 的 lifecycle `runId` 另用 UUID，provider 返回给 holder/调用方的 child id 已违反契约，会让按 child id 展示、诊断或关联的消费方无法区分两个并存 run。
- 复现或验证方式：保留一个未 settle 的旧 provider run，dispose 插件 fiber 后重新 apply，再以同一 parent 启动一次；断言两个 `SubagentRun.id` 相同。
- 建议最小修法：像 DSH 内建 out-of-process provider 一样用 `randomUUID()` 生成 id；若保留可读前缀，使用 `${PREFIX}-${mode}-${randomUUID()}`。

### [P2][SUSPECTED] client 未声明 `remote.settings` 生命周期依赖，缺服务时可能同步抛错而非只读降级
- 插件侧：`lib/client.js:379-386`、`lib/client.js:229-247`
- DSH 依据：`packages/client/ui-settings/src/client/index.ts:39-54` 将实际读取的嵌套 Remote namespace 明确列为 `inject = ['remote', 'remote.settings']`；`packages/client/modules/src/client/manifest.ts:46-49` 与 `src/client/system.ts:143-169` 表明 `dsh.client.inject` 只保证依赖包 factory 先到达，并不等同于 Cordis 服务注入就绪。
- 为什么错 / 影响：源码能确认本插件只声明顶层 `remote`，却无条件调用 `ctx.remote.settings.update`；也能确认 `write(nextRefs)` 若在返回 Promise 前同步抛错，后面的 `.catch()` 接不住并会让页面保持 busy。但本轮没有证明真实 web 组合中存在“页面已挂载而 `remote.settings` 未就绪”的可达窗口，因此实际发生性标为 SUSPECTED。刷新后若贡献恰好完成可能恢复，但这同样未实测。
- 复现或验证方式：在真实 web composition 中延迟或令 api-remotes 的 settings contribution `$mount()` 失败，同时保持本插件页面 contribution 成功；若页面仍激活且保存同步 TypeError、busy 不复位，则证实。若 Cordis 因共同 fiber/依赖闭包保证该状态不可达，则验伪并关闭此项。隔离 Context fixture 只能验证失败分支行为，不能单独证明生产组合可达。
- 建议最小修法：把 `remote.settings` 加入 client 的 `inject`；若产品确需只读降级，则不要将其列为必需注入，而应在构造 `write` 前检查 `ctx.get('remote.settings')`，并让 `write` 缺失为 `undefined`，不能保留一个调用即同步抛错的函数。

## 3. 复核一致的既有处置（一句一条）

- `docs/REVIEW-LOG.md` 所记账号选择串行化、30 分钟 fail-open in-flight claim 已落实；本轮 P1 仅针对 run 尚未发布时缺少回滚。
- settings/web preview 走 `pool.preview()`，不会 claim 账号，和台账处置一致。
- spill 诊断已区分“存在完整 spill 文件，可恢复全流”与“仅剩 retained tail、早期字节不可恢复”，和 subprocess 契约一致。
- source drift 以当前包与基线 manifest 的 JS 文件并集检查；多 host ledger 仍是台账明确接受的 single-writer 边界。
- modes 只在 mount 时注册仍是已记录边界；其他设置已有 hot-update 通路，本轮另指出 commit 后、异步 watcher 前的权威性窗口。

## 4. 已确认无误清单

- **subagent 导出：**`NO_START_CAPABILITIES` 用于声明 provider 不支持 start-time overrides，`inheritsParentContext: false` 表示不会自动继承父 agent 上下文；两者均用对。`validateConfiguredCwd()` 后再用 `resolveChildCwd()` 解析 parent/default/configured cwd，符合契约。
- **run settlement：**`settleRunResult()` 的 `result` 是最终成功结果，`cancelled` 是 provider 的权威取消分类，`collectOutput`/`collectDiagnostic` 在进程 settle 后采集，`onError` 只补诊断，`requestCancel` 发起取消，`teardown` 负责真实停稳，`signal` 供 helper 监听 holder abort；插件除本报告所列 teardown 吞错及发布前回滚缺口外，字段和时序理解正确。
- **subprocess：**主 run 对 `resolveExecutable({ executable, env, cwd })`、`spawn({ argv, cwd, env, stdin, signal, graceMs })` 以及返回 handle/`done` 的使用正确。显式 env 在敏感变量及 DSH/Amp ambient scrub 后合并，符合“调用方显式值可回填”的语义。
- **collected output：**`stdout.readFrom(0)` 的 `text` 在 `lossy=true` 时只是当前 retained tail；只有完整 spill 尚存在时 `spillPath` 才指向可恢复的完整流。插件的结果/诊断分支按此区分，没有把 tail 当全流。
- **provider 注册：**每个 mode 注册一个具备 `name`、`description`、`capabilities`、`inheritsParentContext`、`start` 的完整 provider，名称在本插件内唯一。registry 不会提前结构校验缺字段，但本插件没有缺字段；重复名称会抛错并触发 effect 回滚，不会静默覆盖。外层 `ctx.effect` 虽冗余，但保留并返回内层 disposer，生命周期有效。
- **settings：**解析顺序确为 defaults → `base` → 用户值；注册成功后立即 `scope.get()` 能读当前权威合成值。`watch()` 不首调、提交后异步按序调用、返回 disposer；插件初始读取及 disposer 用法正确，异常降级与异步镜像误用见本报告 P1。
- **credentials：**`ctx.credentials.resolve(ref)` 返回 `{ value, source } | undefined`，失败/不存在不会给可用值；插件每次操作重新 resolve，只从 settings 取得 ref，适应宿主“不提供 ref 枚举 API”的边界，没有尝试枚举凭据。
- **bundle/client 装配：**`cordis.patch.yml` 的 insert 行、`dsh.bundle.patch`、`dsh.client.inject`、`exports['./client']` 格式正确；三个注入包在本机 `0.1.5-rc.2` 编译产物中真实存在，`platform: web` 正确。host 平面需要共享 settings/subagent/subprocess 单例，不设 `isolate` 是正确选择。
- **web/client：**`ctx.webserver.register(prefix, handler)` 使用合法，prefix 走最长前缀匹配，注册 disposer 由 effect 托管；插件 `/api/accounts` 路径、local-only/origin 检查及 JSON 响应形状内部一致。client 的 lazy CJS `window.__ModuleLoader__.load()` 工厂和 `./client` export 能被注入，唯一生命周期缺口见本报告 P2。
- **并发状态：**ledger 进程内写入同步；账号选择队列把健康读取、选择与 claim 串成一个原子临界区；`holder.value` 的普通 watcher 更新及跨模块池状态在单 JS realm 下可见。`counter.next` 在一次 mount 内单调唯一，remount 重号和 settings watcher 窗口已分别列为 P2/P1。
- **本次端到端宿主实测：**本轮 contract 评审自身由该插件以 `medium` 启动；脱敏进程采样观察到对应 Amp 子进程 argv 为 `$HOME/.local/bin/amp --execute --stream-json --stream-json-input --mode medium --visibility private --no-color --no-ide --no-archive-after-execute`。两个同 argv sibling（PID 36344、36369）均有 93 个互不重复的环境键；`AMP_*` 仅有 `AMP_API_KEY`，且各进程恰好出现一次，没有其他 `*_API_KEY`，符合插件 argv 构造和凭据单键注入/ambient scrub 契约。未读取或记录任何环境变量值。

## 5. 未能验证 / 需要下一轮（含验伪方法）

- 因账号预算与只读约束，本轮没有发起额外付费 Amp live run，也没有新增回归 fixture；前 6 条缺陷没有由本评审员执行专门复现实验，证据强度按标题标为源码对照，其中 usage deadline 已由 Lead 独立复核。
- client `remote.settings` 项保留为 SUSPECTED；按该条所列方式延迟/破坏真实 settings contribution，观察页面 fiber 是否仍可激活，即可判定生产组合中的状态是否可达。
- 修复后应把每条“复现或验证方式”固化为 host contract test，并重跑当前 135 项回归及一次多轮工具调用 live smoke test。
