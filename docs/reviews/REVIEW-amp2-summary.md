# REVIEW-amp2-summary：第 8 轮（修复验证）Lead 汇总

> 方法：2 个 AMP（medium）子代理并行 + 1 次续跑；参考真源 = DSH 上游 `master c291e796`
> （`/tmp/dsh-harness-ref`）+ 已安装 `0.1.5-rc.2` 编译产物。
> 对象 = **第 7 轮修复后的构建**，且已确认**运行时=磁盘=安装副本**：
> `index.js fc0ba7f93be8`、`live.js ebea32961479`（`amp_accounts.source.hash` 与 `amp_run.source.hash` 实测）。
> 基线：`bash test/run.sh` 151/151；端到端 smoke 在新构建上通过（`amp_run(low)` → 轮末通知 → `amp_stop` → 单一终态 `completed`）。
> 产物：`docs/reviews/REVIEW-amp2-fixes.md`（fixverify，0 P0/2 P1/5 P2）、`REVIEW-amp2-runtime.md`（runtime2，0 P0/3 P1/3 P2）。

## 1. 判决

**第 7 轮的 16 条里有 3 条没有真正闭环**（#52 claim 回收、#59 dispose 停稳、#65 R10 判别测试），
本轮另有 7 条新发现；合并后 **0 P0 / 3 P1 / 7 P2**，**全部已修**（`CHANGELOG.md` 第 14 批，测试 151 → **164**）。

最有价值的三条，都来自"修复本身要能被对抗验证"：

1. **`finish()` 的 claim 释放不在真 `finally` 里**——我第 7 轮把 release 写在 try 中段，结算早期抛错（reader 抛）
   就跳过它：账号被占 30 分钟，记录也没 finalize。两位评审**独立**命中（fixverify F1、runtime2 发现 3）。
2. **`dispose()` 从"撒谎"变成"可能永久挂住"**——第 7 轮移除了吞错，但没给 `waitForExit()` 边界；
   没有 signal 时它等到范围为空，而幸存后代持有继承描述符可以让它永远非空（fixverify F2）。
3. **我补的 R10 回归测试是空壳**——把 `await Promise.allSettled` 改回 `void` 仍然全绿；两条独立变异都判它无效。

## 2. 合并清单与处置

| # | 级别 | 发现 | 处置 / 依据 |
|---|---|---|---|
| 1 | P1 | live `finish()`：release + finalize 不在 finally，结算抛错即漏 | 三段化 + 真 finally（释放 → finished → 重算 → markSettled）；`AMP-G1` |
| 2 | P1 | one-shot `dispose()`：`waitForExit()` 无界 → 永久挂住 | `AbortSignal.timeout(graceMs)`；`false` 即抛 UNPROVEN；`AMP-G2` |
| 3 | P1 | claim 按账号 ref 而非按 run：并发时互相释放占用 | run-scoped 租约 token（`release(ref, token)`，记账方法只释放自己的）；`AMP-G3/G3b/G3c` |
| 4 | P2 | `alive:false` 与 `quiescenceUnproven` 自相矛盾 | `alive` 三态（`null` = 未知）+ `statusOf` 明示；`AMP-G6` |
| 5 | P2 | `limit:0 = all` 在 tool/web/client 三层都反转成 12 | 三层都传显式 0；`AMP-G4`（含 client 静态契约） |
| 6 | P2 | `amp_runs` 同毫秒退化成字典序，"newest" 不成立 | `(epoch, mtime, key)` + `listDetailed()`；`AMP-G7` ×2 |
| 7 | P2 | 空 prompt 会 claim/spawn 一个无意义 run | 两条路径都在选号前拒绝；`AMP-G5` ×2 |
| 8 | P2 | `run()` 抛错只 `terminate()`，不关 artifact/fd | 启动有界等待 + finalize(`finished:false`) + markSettled + 清 session |
| 9 | P2 | 宿主完全无 settings 时 client 仍建议"重启" | 文案改为陈述事实 |
| 10 | P2 | R10 回归测试不判别 | 手动 settlement gate；变异为红 |

## 3. Lead 独立复核（不只是采信报告）

- **源码核对**：`waitForExit(signal?)` 的 `false` 语义（`subprocess/src/types.ts:185-191`）、
  `inflight` 的单条目 Map（`accounts.js`）、空 prompt 无守卫、`limit:0` 三层规范化——逐条确认。
- **亲自复现/实测**：`limit:0` 只返回 12 行（我自己的调用踩到）；
  `amp_runs` 在**真实混合目录**（22 个旧 key + 3 个新 key）下顺序正确；
  端到端 smoke 走通新构建；`deploy.sh --check` in-sync 且哈希与运行时逐条一致。
- **反向验证**：13 条新测试跑在第 7 轮构建上**全红**；`AMP-R10` 另用 `void` 变异验证为红。
- 两条 review run 被上游 credits 掐断（各烧 ~$4 后跌破 $1 门槛），**`resumable=true` + artifact 续跑路径实战可用**：
  报告落盘完整、续跑后收尾成功。

## 4. 未能验证（下一轮）

- 真实宿主 teardown × sweeper × jobs cancel 的**三向交错**（runtime2 已给出可构造的验伪方法：手动 waitForExit barrier，
  断言只发生一次 finalize/release/markSettled，且 `terminate()` 同步触发 cancel 的重入窗口不产生双结算）。
- 真实 OS 层面"持有继承描述符的幸存后代"（F2 由契约与 fake handle 证明，未做系统级复现）。
- 没有真实浏览器验证 client 文案/只读降级（静态可达分支）。
