import {
	closeSync,
	chmodSync,
	existsSync,
	fsyncSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	rmSync,
	writeSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const WRITE_CHUNK_BYTES = 64 * 1024

function defaultRoot() {
	const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
	return join(home, 'state', 'dsh-amp', 'runs')
}

// runId 同时成为目录名，因此只接受单个可移植文件名，避免调用者借路径语法逃出 root。
function validRunId(runId) {
	return typeof runId === 'string' && runId !== '.' && runId !== '..' && /^[A-Za-z0-9._-]+$/.test(runId)
}

function errorText(error) {
	return String(error?.message ?? error)
}

// 告警器属于诊断旁路；即使第三方 logger 自己失效，也不能反过来击穿持久化调用方。
function warn(logger, message) {
	try {
		logger?.warn?.(message)
	} catch {
		/* diagnostics must remain best-effort */
	}
}

/**
 * Retention for the run root.
 *
 * Safety first, then disk: a run may only be auto-deleted when its checkpoint is READABLE and says
 * `finished: true`. Anything else — missing, corrupt, or explicitly unfinished — is exactly what a
 * rescuer is looking for (a crashed host leaves those behind), so it is never the thing we delete.
 * Among the deletable set we keep every run modified within `keepDays`, and the newest `keepCount`
 * of each outcome (failures and successes have separate budgets, so neither starves the other).
 * `open()` calls this at most once per PRUNE_INTERVAL_MS. A deletion that fails returns the reason
 * instead of throwing, and a failed listing uses the store's failure shape.
 */
export function pruneRuns(runRoot, options = {}) {
	// Clamped, not trusted: NaN or a negative window would silently invert the policy.
	const keepDays =
		typeof options.keepDays === 'number' && Number.isFinite(options.keepDays) && options.keepDays >= 0
			? Math.floor(options.keepDays)
			: 7
	const keepCount =
		typeof options.keepCount === 'number' && Number.isFinite(options.keepCount) && options.keepCount >= 0
			? Math.floor(options.keepCount)
			: 50
	const at = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now()
	let entries
	try {
		entries = readdirSync(runRoot, { withFileTypes: true })
	} catch (error) {
		// A root that does not exist yet is not a failure: there is simply nothing to prune, and
		// warning about it here would put noise on every first run of a fresh install.
		if (error?.code === 'ENOENT') return { ok: true, removed: [], kept: 0, protectedCount: 0 }
		return { ok: false, error: `list runs for prune: ${errorText(error)}` }
	}
	const runs = []
	for (const entry of entries) {
		if (entry.isDirectory() !== true) continue
		const dir = join(runRoot, entry.name)
		try {
			runs.push({ name: entry.name, dir, mtimeMs: statSync(dir).mtimeMs, ...readRunRecord(dir) })
		} catch {
			/* a directory that vanished mid-scan is not our problem */
		}
	}
	// Protected runs never enter the candidate set at all: age and count cannot touch them.
	const protectedCount = runs.filter((run) => run.finished !== true).length
	// Among the deletable ones, failures and successes get their OWN `keepCount` budget rather than
	// competing for one. A single shared budget had a bad edge: enough old failures would evict every
	// out-of-window success, however recent. Separate budgets bound the total at 2x keepCount and let
	// neither group starve the other, while `keepDays` remains a hard floor for both.
	const deletable = runs.filter((run) => run.finished === true)
	const groups = [deletable.filter((run) => run.failed === true), deletable.filter((run) => run.failed !== true)]
	const cutoff = at - keepDays * 24 * 60 * 60 * 1000
	const removed = []
	for (const group of groups) {
		group.sort((a, b) => b.mtimeMs - a.mtimeMs)
		for (let index = 0; index < group.length; index += 1) {
			const run = group[index]
			if (index < keepCount || run.mtimeMs >= cutoff) continue
			try {
				rmSync(run.dir, { recursive: true, force: true })
				removed.push(run.name)
			} catch (error) {
				return { ok: false, error: `prune ${run.name}: ${errorText(error)}` }
			}
		}
	}
	return { ok: true, removed, kept: runs.length - removed.length, protectedCount }
}

/**
 * What this run's checkpoint proves: `finished` only when it is readable AND says so (everything
 * else — missing, corrupt, `finished: false` — is the run rescue depends on), and `failed` when the
 * record itself says a failure was classified. Retention keeps failures longer than successes.
 */
function readRunRecord(dir) {
	try {
		const raw = JSON.parse(readFileSync(join(dir, 'checkpoint.json'), 'utf8'))
		if (raw === null || typeof raw !== 'object') return { finished: false, failed: false }
		// Prefer the projected terminal status: it is the same single outcome every other surface
		// reports, so a failure nobody classified is still kept longer. `failure` is the fallback.
		const failed =
			typeof raw.status === 'string' ? raw.status !== 'completed' : raw.failure !== null && raw.failure !== undefined
		return { finished: raw.finished === true, failed }
	} catch {
		return { finished: false, failed: false }
	}
}

// 独立的持久化边界让子代理即使被强制终止，也能保留已经产出的工作。
export function createArtifactStore(options = {}) {
	const root = typeof options.root === 'string' ? options.root : defaultRoot()
	// One scan per hour bounds growth without making every run pay for it.
	const PRUNE_INTERVAL_MS = 60 * 60 * 1000
	let lastPruneAt = 0
	const logger = options.logger
	const now = typeof options.now === 'function' ? options.now : Date.now

	const failure = (operation, error) => {
		const detail = errorText(error)
		warn(logger, `dsh-amp: artifact ${operation} failed: ${detail}`)
		// 统一失败形状让生命周期代码可以降级为 partial，而不是用异常遗漏收尾。
		return { ok: false, error: detail }
	}

	const pathsFor = (runId) => {
		if (!validRunId(runId)) return failure('runId validation', `invalid runId: ${String(runId)}`)
		const dir = join(root, runId)
		// 所有路径只从已消毒的单段 runId 派生，不能指向 root 之外。
		return { dir, streamPath: join(dir, 'stream.log'), checkpointPath: join(dir, 'checkpoint.json') }
	}

	return {
		// 暴露实际根目录是为了让上层能把可恢复位置放进失败结果，而无需复制默认路径规则。
		root,

		// 集中计算公开路径可以防止调用方各自拼接出不一致或未经校验的位置。
		pathOf(runId) {
			return pathsFor(runId)
		},

		// 目录名就是稳定索引，因此无需额外清单文件，也不会引入清单与磁盘状态漂移。
		list() {
			try {
				if (!existsSync(root)) return []
				// 只列目录可以避免临时文件或人工说明被误当成可恢复 run。
				return readdirSync(root, { withFileTypes: true })
					.filter((entry) => entry.isDirectory() && validRunId(entry.name))
					.map((entry) => entry.name)
					.sort()
			} catch (error) {
				return failure('list', error)
			}
		},

		/**
		 * The same listing with each directory's mtime.
		 *
		 * A caller that must ORDER runs cannot use the name alone: the key carries the epoch of the
		 * millisecond it was opened in, but not the order of two runs opened inside it (pid and uuid
		 * are deliberately random). The mtime is the tie-break that makes "newest first" deterministic.
		 */
		listDetailed() {
			try {
				if (!existsSync(root)) return []
				return readdirSync(root, { withFileTypes: true })
					.filter((entry) => entry.isDirectory() && validRunId(entry.name))
					.map((entry) => {
						const dir = join(root, entry.name)
						let mtimeMs
						try {
							mtimeMs = statSync(dir).mtimeMs
						} catch {
							// A directory that vanished between listing and stat keeps a 0 mtime: it still
							// appears (so a caller can explain it) but sorts oldest.
							mtimeMs = 0
						}
						return { name: entry.name, dir, mtimeMs }
					})
					.sort((a, b) => a.name.localeCompare(b.name))
			} catch (error) {
				return failure('list', error)
			}
		},

		// 缺省与损坏必须区分：前者可正常开始，后者返回失败以免静默丢掉恢复事实。
		readCheckpoint(runId) {
			const paths = pathsFor(runId)
			if (paths.ok === false) return paths
			try {
				if (!existsSync(paths.checkpointPath)) return undefined
				return JSON.parse(readFileSync(paths.checkpointPath, 'utf8'))
			} catch (error) {
				return failure(`read checkpoint for ${runId}`, error)
			}
		},

		// handle 持有追加描述符和累计字节数，使热路径无需反复打开文件或扫描内容。
		open(runId, meta) {
			if (now() - lastPruneAt > PRUNE_INTERVAL_MS) {
				lastPruneAt = now()
				const pruned = pruneRuns(root, { ...(options.retention === undefined ? {} : options.retention), logger })
				// A silent prune failure is a slow disk leak nobody can see; say it once per attempt.
				if (pruned.ok !== true) warn(logger, `dsh-amp: run retention could not prune: ${String(pruned.error)}`)
			}
			const paths = pathsFor(runId)
			if (paths.ok === false) return paths
			let fd
			try {
				mkdirSync(paths.dir, { recursive: true })
				// O_APPEND 由内核保证每次 write 从当前文件尾开始，重启后续写不会覆盖已有成果。
				fd = openSync(paths.streamPath, 'a', 0o600)
				chmodSync(paths.streamPath, 0o600)
				return {
					runId,
					meta,
					...paths,
					fd,
					bytes: fstatSync(fd).size,
					openedAt: now(),
					closed: false,
					finalResult: undefined,
				}
			} catch (error) {
				if (fd !== undefined) {
					try {
						closeSync(fd)
					} catch {
						/* preserve the original open error */
					}
				}
				return failure(`open ${runId}`, error)
			}
		},

		// 返回本次实际写入量，让上层在部分写失败时能准确记录已持久化边界。
		append(handle, text) {
			let written = 0
			try {
				if (handle === null || typeof handle !== 'object' || handle.closed === true || typeof handle.fd !== 'number') {
					throw new Error('artifact handle is not open')
				}
				const content = Buffer.from(String(text))
				// 有界分块避免一次超大字符串把单次系统调用或平台写入上限当成可靠性前提。
				while (written < content.length) {
					const length = Math.min(WRITE_CHUNK_BYTES, content.length - written)
					const count = writeSync(handle.fd, content, written, length)
					if (count <= 0) throw new Error('append made no progress')
					written += count
					handle.bytes += count
				}
				// append-only 流保留未经消费游标裁剪的完整事实，恢复时才能重建真实进度。
				return { ok: true, bytes: written }
			} catch (error) {
				const failed = failure(`append ${handle?.runId ?? '<unknown>'}`, error)
				return { ...failed, bytes: written }
			}
		},

		// checkpoint 与原始流分离，允许频繁替换小型恢复事实而不改写已落盘的大流。
		checkpoint(handle, facts) {
			if (handle === null || typeof handle !== 'object' || typeof handle.checkpointPath !== 'string') {
				return failure('checkpoint', 'invalid artifact handle')
			}
			let tmp
			let fd
			try {
				tmp = `${handle.checkpointPath}.tmp-${process.pid}-${randomUUID()}`
				const body = Buffer.from(`${JSON.stringify(facts, null, 2)}\n`)
				fd = openSync(tmp, 'wx', 0o600)
				let offset = 0
				while (offset < body.length) {
					const count = writeSync(fd, body, offset, body.length - offset)
					if (count <= 0) throw new Error('checkpoint write made no progress')
					offset += count
				}
				fsyncSync(fd)
				closeSync(fd)
				fd = undefined
				chmodSync(tmp, 0o600)
				// 同目录 rename 是原子替换，读者只会看到完整旧版或完整新版，而不会消费半截 JSON。
				renameSync(tmp, handle.checkpointPath)
				return { ok: true, checkpointPath: handle.checkpointPath }
			} catch (error) {
				if (fd !== undefined) {
					try {
						closeSync(fd)
					} catch {
						/* cleanup remains best-effort */
					}
				}
				if (tmp !== undefined) {
					try {
						rmSync(tmp, { force: true })
					} catch {
						/* the primary error is more useful than temp cleanup failure */
					}
				}
				return failure(`checkpoint ${handle.runId ?? '<unknown>'}`, error)
			}
		},

		// 显式且幂等的释放便于正常完成、取消和 host dispose 共享同一清理步骤。
		close(handle) {
			try {
				if (handle === null || typeof handle !== 'object') throw new Error('invalid artifact handle')
				if (handle.closed === true) return { ok: true }
				if (typeof handle.fd !== 'number') throw new Error('artifact handle has no file descriptor')
				closeSync(handle.fd)
				handle.closed = true
				// close 幂等让多条终结路径可以安全汇聚，不必争夺唯一调用者。
				return { ok: true }
			} catch (error) {
				return failure(`close ${handle?.runId ?? '<unknown>'}`, error)
			}
		},

		// finalize 把 flush、最终恢复事实和释放合成一个幂等终点，避免生命周期提前宣告完成。
		finalize(handle, outcome) {
			if (handle?.finalResult !== undefined) return handle.finalResult
			let result
			try {
				if (handle === null || typeof handle !== 'object' || handle.closed === true || typeof handle.fd !== 'number') {
					throw new Error('artifact handle is not open')
				}
				fsyncSync(handle.fd)
				const checkpointResult = this.checkpoint(handle, outcome)
				const closeResult = this.close(handle)
				if (checkpointResult.ok === false) result = checkpointResult
				else if (closeResult.ok === false) result = closeResult
				else {
					result = {
						ok: true,
						artifactPath: handle.streamPath,
						checkpointPath: handle.checkpointPath,
						bytes: handle.bytes,
					}
				}
			} catch (error) {
				result = failure(`finalize ${handle?.runId ?? '<unknown>'}`, error)
				if (handle !== null && typeof handle === 'object' && handle.closed !== true) this.close(handle)
			}
			// 缓存首次终结结果避免重复 checkpoint 或重复关闭，使 success/failure 两条路径都可安全重入。
			if (handle !== null && typeof handle === 'object') handle.finalResult = result
			return result
		},
	}
}
