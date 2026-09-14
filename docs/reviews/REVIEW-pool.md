# 账号池 + 失败分类器 审查报告（REVIEW-pool）

审查范围：`lib/outcome.js`（新）、`lib/accounts.js`、`lib/ledger.js`、`lib/live.js`、`lib/index.js`、`test/`。
不含：`lib/artifact.js`、`test/artifact.test.mjs`（并发开发中，未审、未扣分）。

---

## 1. 分类器准确性

**已确认**

- 三条真实原文中两条可直接命中：#1 credits 由 `lib/outcome.js:30` 的 `at least \$[0-9.]+\s+in available credits` 命中（测试 `test/outcome.test.mjs:14-19`）；#2 rate-limit 由 `outcome.js:33-36` 命中并提取 57s（测试 `outcome.test.mjs:21-26`）。**#3（27 轮后被掐）没有测试锚定原文**——若那条路径上 Amp 只以非零 exitCode 退出、`result.error` 为空，则 `lib/live.js:356-359` 的 `errorText` 为空、`lib/index.js:371-375` 同样得 `failure === undefined`，账号余额只能靠 `refresh()` 落账，不会进任何分类分支。这是漏报，不误伤。
- 误报面：分类只作用于错误通道（`result.error` / `systemError` / `exitError`，见 `lib/live.js:356-359`、`lib/index.js:371-374`），不扫 assistant 正文，普通输出里出现 "credits"/"rate limit" 不会被误判。credits 分支的四条模式都很窄。
- **唯一偏宽的是 `/rate ?limit/iu`（`outcome.js:33`）**：错误文本里任何 "rate limit" 字样（例如上游按模型限流被透传进 `result.error`）都会被判为"账号级、窗口后恢复"，给该号记 60s 冷却（`accounts.js:323-331`）并告诉委派方"transient"。后果有限（默认 60s、credits/auth 不受累），但会把模型级限流错误归因到账号上。
- 偏向判定：整体偏向**漏报**（落入 `other`，`outcome.js:41`），`other` 被明确"不得盲目重试"（`outcome.js:63`、`outcome.test.mjs:39-47`）。这是正确的偏向：误报的代价是盲重试可能重复已发生的副作用，漏报的代价只是少一次自动恢复。

**建议**：给 #3 的真实报错原文补一条 `classifyAmpError` 断言（见 §7）；`rate-limit` 正则可加一个锚（如要求句首 `^Rate limit exceeded` 或同时出现 `try again`），或至少在测试里固定当前宽度的意图。

---

## 2. `choose()` 各返回路径（`lib/accounts.js:195-288`）

**已确认**

- **无任何路径返回空 token**：`tokenOf`（`accounts.js:122-125`）对未解析/非字符串一律返回 `''`，`accounts.js:203-205` 在循环最前面拦截 `trim()===''` 并 continue；后续所有 return（含 222-231、235-238、239-249）和 fallback（262-273）都在该检查之后。fallback 对象在 258 行构造，同样在 token 检查之后。✔
- **"其实还能派发却抛错"的路径收敛到两条**（279-287）：全部 ref 无 token（这是真 blocker，拒绝是对的，注释和 `test/accounts.test.mjs:179-192` 都锚定了"静默用错号"更糟）；或全部非空号被 cooling / `remaining===0` 拦下（284-287）。这正是本轮要修的病，修对了：低于 `$1` 不再拦截，走 fallback（262-273，测试 `accounts.test.mjs:90-103`）。✔
- 未观测（`remaining===undefined`）→ `accounts.js:215` 进入重读，读到什么派什么，不臆断 $5。✔（测试覆盖：隐式，经 `stale` 用例。）
- 陈旧（`isStale`，115-120，10 分钟窗）→ 重读再决策，不信任旧数字（测试 `accounts.test.mjs:122-136`）。✔
- 读失败：`readOne` 返回 `ok:false`（144-148，失败的读不算零）或抛异常（239）→ 一律 fail-open 立即派发（222-231、239-249）。✔ 方向正确。
- `remaining===0` 且不陈旧 → 254-257 跳过。✔（`ledger.remaining` 在 `exhausted:true` 时返回 0，`ledger.js:100`。）

**疑似（两个真实缺陷，建议下轮修）**

1. **"读不到钱"的账号会垄断派发**。`remaining === undefined` 的号每次 `choose()` 都走 215 的重读分支，且一旦重读仍解析不出钱就在 235-238 **立即返回**——排在列表前面的一个余额永久不可解析（或 `amp usage` 持续失败）的号，会永远排在所有健康号之前被选中，后面的满额号永远轮不到；且每次派发都为它付一次约 3.4s（最长 `USAGE_TIMEOUT_MS`=20s，`accounts.js:30`）的远程读。fail-open 对，但"立即 return"应改为"记为 fallback / 继续看后面"。
2. **10 分钟内 topped-up 的号会被误抛错**：外部充值或另一进程消费后，非陈旧的 `remaining===0` 记录让 254 直接跳过且不重读；全池如此时在 284 抛"no account can start a run"，而实际上号里有前。窗口被 `CONFIRM_AFTER_MS` 限定在 10 分钟，可接受，但值得知道。

- fallback 选"剩余最多"（260：`remaining > fallback.remaining`）：合理。在全都低于偏好下限时，选最可能撑过启动的那一个；且 fallback 保留了 `state` 与解释性 detail（266-269），不撒谎。

---

## 3. `noteRefusal` 三态与 cooling（`lib/accounts.js:321-343`）

**已确认**

- 三态正确：`rate-limit` 记窗口（323-331，非法/缺失 `retryAfterMs` 落 60s 默认，与 `outcome.js:36` 一致）；`credits`/`auth` 强制重读余额替换陈旧猜测（333-341，测试 `accounts.test.mjs:157-177`）；`other`/undefined 返回 `undefined` 不动状态。✔
- **cooling 不会无界增长**：key 是 ref，上限就是配置里的账号数（约 65）。到期不清理也无碍——`isCooling`（112）只做 `> now` 比较，过期即失效；`coolingUntil`（346-348）过期后仍返回旧时间戳，仅诊断展示，无害。
- `cooling.set` 在 noteRefusal 的 rate-limit 分支里**没有任何 await**（323-331 是同步段），Node 单事件循环下 check-then-set 原子，无竞态。✔
- 无账号级上限问题：同一 ref 反复限流只是覆盖时间戳（330），不会累积。

**建议（可选）**：`coolingUntil` 可在过期后返回 `undefined`，避免诊断页展示一个已过期的"冷却到 X"；非必须。

---

## 4. 并发

**已确认**

- **F11 仍在**：两个 run 并发 `choose()`（`lib/live.js:183` 经 `chooseAccount`、`lib/index.js:224-236` 经 provider `start`）之间没有任何预约/锁机制；`choose` 在多个 `await`（tokenOf、readOne）之间让出事件循环，两个调用可以都选中同一个"最优号"。`noteDispatch`（291-293）只写 ledger 计数，**不回流到 choose 的排序**，所以对本问题既无帮助也无害处——F11 保持原状，未被恶化。
- cooling 是进程级共享 `Map`，set 同步原子（见 §3），两个并发 noteRefusal 只会 last-write-wins，无竞态风险。
- 并发 `readOne` 同一号（两个 choose 同时撞上 stale）只会多花一次远程读，`ledger.observe` 后写覆盖前写，账面最终一致（checkedAt 取后者）。可接受。

**结论**：新代码没有让 F11 变坏；要修它需要在 `choose()` 里加"dispatch 预约"（例如 `noteDispatch` 后给该 ref 记一个短 TTL 的 in-flight 标记并在 choose 里跳过），属下一轮工作。

---

## 5. "agent 不再关心余额"是否达成

**沿 live 路径走查**：`amp_run` → `chooseAccount`（live.js:179-201）→ pool.choose（无余额问题抛给 agent；§2 的两条 throw 都是机制级话术）→ spawn → 失败 → `finish()` 里 `classifyAmpError`（live.js:359）→ `noteRefusal`（361-364，fire-and-forget，失败不影响 run）→ 下次 choose 受益。one-shot 路径同构（index.js:375-386）。**主回路成立**。

**已确认的残留泄漏点**

- `lib/live.js:521-522`：`amp_run` 的返回 JSON 里有 `account: account.ref` 和 `balance: account.detail`——detail 在 fallback 时是 `"credits=$0.90 … below the $1 preference floor, dispatching anyway"`（accounts.js:266-268）。这是把余额叙事直接推给委派模型，**与 `DESIGN.md:84`"不把账号暴露给模型（工具输出不含可用来选号的信息）"直接冲突**。要么删 `balance` 字段、`account` 换成脱敏序号，要么更新 DESIGN.md 承认新的归因策略——两者取一，现在是文档说了 A 代码做了 B。
- `lib/index.js:398-399`、`lib/live.js:675`：诊断里的 `account=`/`($…)` 同样暴露账号与余额。作为失败归因是本轮有意为之（live.js:672-674 注释），但同样与 DESIGN.md:84 冲突。
- `amp_accounts` 工具描述（live.js:649-652）继续向模型宣传余额视图，属于既有面，不在本轮改动内，但同样让"模型关心余额"的入口存在。

**未发现**把"去查余额/换号重试"这类作业推回给委派方的报错文本；`choose()` 的两条 throw（accounts.js:279-287）和 `describeFailure` 都不布置作业。

---

## 6. `describeFailure` 是否撒谎（`lib/outcome.js:53-64`）

**已确认**

- credits："another account may still run it"——对**启动前拒绝**（证据 #1/#2）成立。对**中途额度死亡**（#3，27 轮成果）字面仍真（别的号确实能跑），但它与 `isNoWorkFailure('credits')===true`（45-47）合在一起隐含"没有工作损失"。缓解已存在：one-shot 保留 partial output 并明确"先读 thread 再重试，避免重复劳动"（index.js:428-439）；live 路径 `amp_stop` 返回 `lastText` 且诊断含 `thread=`。**建议**给 credits 文案补半句"the run may have done partial work — check the partial output/thread first"，消除与 numTurns>0 场景的张力。
- rate-limit："the account works again after the window"——窗口来自错误文本自身或 60s 默认。当 `retryAfterMs` 是默认值时（文本没给窗口），"after the window" 是猜测而非事实；建议默认路径措辞改 "should"。**不会诱导危险重试**：它只承诺同号稍后可用，没让 agent 立刻盲试。
- auth："retrying elsewhere is pointless"——**这句是错的/危险的方向反了**。凭据被拒时，正确的机制动作恰恰是换一个账号（pool 里其他号），而 `isNoWorkFailure('auth')===true` 的语义也是"可换处重试"。当前文案会劝退委派方，让一次可救的失败变成整体放弃。建议改为 "this account's credential is not accepted; another configured account is the right next move"。
- other："not safe to retry blind" ✔，不撒谎。

---

## 7. 测试缺口（最小补测清单）

现有 20 条（outcome 7 + accounts 8 + live 9 中与分类相关者）覆盖了主干。**缺**：

1. `choose()`：`readOne` 返回 `ok:false`（`amp usage` 非零退出）→ 立即以 `state:'unreadable'` 派发（accounts.js:222-231）；`readOne` 抛异常 → 同（239-249）。当前一条都没测。
2. `choose()`：读到的 usage 解析不出钱（`remaining===undefined`）→ 立即 `state:'confirmed'` 派发（235-238）。
3. `choose()`：多个 below-floor 号时选 `remaining` 最大的那个（260 行的 `>` 分支）。
4. cooling **过期后重新可选**：现有用例（accounts.test.mjs:138-155）只测了冷却期内跳过；需一条把 `coolingUntil` 推到过去（或 fake timer）后 `choose()` 重新选回该号。
5. `noteRefusal` 的 `other`/undefined-kind 分支：返回 `undefined`、不写 cooling、不触发远程读。
6. `noteRefusal('auth')` 走重读分支（现在只测了 credits，157-177）。
7. `noteRefusal` rate-limit 且 `retryAfterMs` 非法（0/NaN/负数）→ 落 60s 默认。
8. **one-shot 路径的接线**：`lib/index.js:375-386` 的 classify→noteRefusal/refresh 完全没有测试（live.test.mjs 的 F1-F15 都不覆盖 provider 路径）；至少加一条：result.is_error 且 error 为真实 credits 原文时 `noteRefusal` 被以 `kind:'credits'` 调用。
9. **live 路径的接线**：`lib/live.js:356-364` 同样无测试——`amp_stop` 收到 credits 错误时诊断含 `failure=credits` 且 noteRefusal 被调。
10. #3 场景（27 轮后额度死亡）的真实报错原文，一旦拿到，补 `classifyAmpError` 断言，锁定中途死亡的归类。

---

## 8. 与设计文档一致性

**已确认兑现**

- `REVIEW-design.md:62`（§2.6）"$1 只排序不闸门" → `ledger.js:27-37` 注释与 `accounts.js:254-273` fallback 实现，且有测试（accounts.test.mjs:90-103）。✔
- `REVIEW-design.md:64-65`（§2.6）"安全自动改派需合取条件，否则不自动改派" → 代码确实**不做任何自动改派**（分类结果只记账与标注，`live.js:361-364`、`index.js:378-386`），没有过度兑现。✔
- `REVIEW-design.md:114/146` "classifier 未接完" → 本轮已接线（`live.js:359-364`、`index.js:375-386`），该缺口关闭。✔

**不一致（两处）**

1. `REVIEW-design.md:63`（§2.6）要求 `choose({mode, expectedCost?, taskClass?})` 至少做预算感知选号（由 #3 事故直接引出）；当前 `choose()` 仍是零参签名（accounts.js:195），**F26 的教训（启动够、跑不完）没有被这一轮改动吸收**——分类器只做事后记账，防不住"选了个只剩 $0.9 的号跑 medium"。这是本点最大的未兑现项。
2. `DESIGN.md:84` "不把账号暴露给模型" vs `live.js:521-522`、`index.js:398`、`live.js:675`（§5 已列）——代码的新归因策略没有回写文档。

**纯文风（≤2 条）**

- `lib/live.js:757`：`source: pool.source` 永远是 `undefined`（`createAccountPool` 返回对象没有 `source` 字段，accounts.js:155-356），JSON.stringify 会静默丢字段——删除或补上。
- `lib/index.js:378` 与 `lib/live.js:361-364` 对 `kind==='other'` 的处理不一致（index 跳过 noteRefusal 改走 refresh，live 照调 no-op）——行为无害，但两处宜统一为一处写清注释。

---

## 结论摘要

最关键三条：

1. **主目标成立**：分类→记账→下次选号的主回路已在两条路径接完，`choose()` 不再有"够派却抛错"的路径，也无空 token 泄漏。
2. **`describeFailure('auth')` 文案方向反了**（"retrying elsewhere is pointless"），会劝退一次本可换号挽救的失败，应改。
3. **两个 fail-open 的"立即 return"会让读不到余额的号垄断派发**（accounts.js:222-249），且 F26 的预算感知选号仍未实现。

**这个点能不能算改对了**：能——针对的三条实测证据都被机制正确消化且有测试锚定；但 auth 文案需改、垄断派发与预算选号留给下一轮。
