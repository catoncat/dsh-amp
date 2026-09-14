/**
 * dsh-amp live sessions — a steerable Amp run.
 *
 * Why this is NOT a `ctx.subagents` provider: `SubagentRun.result` settles exactly
 * once, and Amp's `--stream-json-input` mode emits no per-turn `result` — verified
 * directly, the only `result` arrives when stdin closes. A steerable run is a
 * conversation with an explicit ending, which the one-shot seam contract cannot
 * express. The seam path stays as-is for fire-and-forget delegation; this module
 * adds the one you can talk to while it works.
 *
 * The verbs mirror the harness's own, because inventing new semantics here would
 * just teach the model a second dialect:
 *
 *   `amp_run`          ≈ spawning a child you can keep talking to
 *   `amp_send_message` ≈ `send_message`: steer at the nearest step boundary while
 *                        the child is busy, a normal turn while it is idle
 *   `amp_stop`         ≈ `interrupt_agent`, WITH ONE HONEST DIFFERENCE — Amp has
 *                        no turn-level cancel (verified: SIGINT ends the process
 *                        and Amp reports `User cancelled (SIGINT/SIGTERM)`), so
 *                        stopping ends the run. The thread survives unarchived,
 *                        so continuing means a new run on that thread, not more
 *                        messages to this one.
 *
 * `amp_send_message` also returns everything the child produced since the previous
 * read, so watching progress costs no extra tool schema.
 *
 * Access is fenced by the calling agent's session id: one session cannot steer or
 * stop another session's run.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createArtifactStore } from './artifact.js'
import { classifyAmpError, describeFailure, isNoWorkFailure } from './outcome.js'
import { describePackageDrift, describeSource } from './source.js'

const PREFIX = 'dsh-amp'
const STDOUT_MAX_BYTES = 8 * 1024 * 1024
const STDOUT_SPILL_BYTES = 32 * 1024 * 1024
const STDERR_MAX_BYTES = 512 * 1024
const DEFAULT_IDLE_TIMEOUT_MS = 20 * 60 * 1000
const SWEEP_INTERVAL_MS = 30_000
const STOP_GRACE_MS = 20_000
/** A line that never terminates still cannot be buffered without bound. */
const PENDING_MAX_CHARS = 1024 * 1024
const DIGEST_MAX_CHARS = 1200
/**
 * How much raw stream one `job_output` read may return.
 *
 * This cursor is separate from the protocol cursor on purpose: `readFrom(offset)` is
 * non-consuming, so two independent cursors over the same reader cannot steal from each
 * other — the theft the design review warned about came from SHARING one cursor.
 */
// Local clipping counts code units; the jobs registry counts UTF-8 bytes. One value was being passed
// as both, so a CJK digest could exceed the registry's cap by ~3x and have its own lossy note cut off.
// Same byte budget the one-shot path enforces. The live path writes prompts straight into the child's
// stdin pipe, so without this a >1MiB prompt is delivered unbounded — and if Amp or the pipe has a
// cap, it arrives truncated, which is the one failure mode this guard exists to refuse.
const MAX_PROMPT_BYTES = 1024 * 1024
const DELIVERY_MAX_CHARS = 8000
const DELIVERY_MAX_BYTES = 32 * 1024

/**
 * The copy of THIS file the host actually loaded. The profile installs the plugin as a
 * real copy of a `file:` dependency, so a restart can silently keep serving an older
 * build; every run therefore reports the path and hash that served it.
 */
const SOURCE = describeSource(import.meta.url)
/**
 * U6: the same view plus deploy drift, computed once per process. "Edited the source,
 * restarted, nothing changed" stops being a silent failure the moment every response says
 * whether the running build still matches the tree it came from.
 */
const DRIFT = describePackageDrift(SOURCE.file)
const SOURCE_VIEW = {
	...SOURCE,
	drift: DRIFT.status,
	driftChanged: DRIFT.changed.length === 0 ? undefined : DRIFT.changed,
	driftAdded: DRIFT.added.length === 0 ? undefined : DRIFT.added,
}

/** The only thing this plugin ever hides is the account token it injects. */
function sanitize(value) {
	if (typeof value !== 'string') return ''
	return value.replace(/sgamp_[A-Za-z0-9_-]+/gu, 'sgamp_<redacted>')
}

function clip(value, limit) {
	const text = typeof value === 'string' ? value : ''
	return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Small owned scalars only — never the live message objects. */
function digest(messages) {
	const rows = []
	for (const m of messages) {
		if (m === null || typeof m !== 'object') continue
		const row = { type: String(m.type) }
		if (typeof m.subtype === 'string') row.subtype = m.subtype
		if (m.type === 'assistant' && m.message !== undefined && Array.isArray(m.message.content)) {
			const parts = []
			for (const block of m.message.content) {
				if (block === null || typeof block !== 'object') continue
				if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
				else if (block.type === 'tool_use') parts.push(`[tool ${String(block.name)}]`)
				else if (block.type === 'thinking') parts.push('[thinking]')
			}
			row.text = clip(sanitize(parts.join('\n')), DIGEST_MAX_CHARS)
			if (typeof m.message.stop_reason === 'string') row.stopReason = m.message.stop_reason
		}
		if (m.type === 'user' && m.message !== undefined && Array.isArray(m.message.content)) {
			const parts = []
			for (const block of m.message.content) {
				if (block === null || typeof block !== 'object') continue
				if (block.type === 'tool_result') parts.push(block.is_error === true ? '[tool result ERROR]' : '[tool result]')
				else if (block.type === 'text' && typeof block.text === 'string') parts.push(clip(sanitize(block.text), 400))
			}
			row.text = parts.join(' ')
		}
		if (m.type === 'result') {
			row.isError = m.is_error === true
			if (typeof m.result === 'string') row.result = clip(sanitize(m.result), 4000)
			if (typeof m.error === 'string') row.error = clip(sanitize(m.error), 600)
			if (typeof m.num_turns === 'number') row.numTurns = m.num_turns
		}
		if (m.type === 'system' && typeof m.subtype === 'string' && m.subtype !== 'init') {
			row.error = clip(sanitize(String(m.error || '')), 600)
		}
		rows.push(row)
	}
	return rows
}

function parseLines(text) {
	const messages = []
	const unparsed = []
	for (const raw of String(text ?? '').split('\n')) {
		const line = raw.trim()
		if (line === '') continue
		if (line[0] !== '{') {
			unparsed.push(clip(line, 160))
			continue
		}
		try {
			messages.push(JSON.parse(line))
		} catch {
			unparsed.push(clip(line, 160))
		}
	}
	return { messages, unparsed }
}

/**
 * Split complete lines off one delta read.
 *
 * A read can land mid-line. Parsing the tail now loses it, and parsing the
 * continuation later loses it again — the two halves fail as unparsed separately
 * and can never be rejoined. So the tail is HELD until the rest arrives.
 */
function splitCompleteLines(text) {
	const end = text.lastIndexOf('\n')
	if (end === -1) return { complete: '', pending: text }
	return { complete: text.slice(0, end + 1), pending: text.slice(end + 1) }
}

function userLine(text, steer) {
	const payload = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: text }] } }
	if (steer === true) payload.steer = true
	return JSON.stringify(payload) + '\n'
}

/**
 * One read that can return nothing is indistinguishable from a dead child, so a
 * read waits for something to happen before it answers. A caller that wants a
 * snapshot asks for `wait_ms: 0`; the default is bounded well under Amp's own
 * cold start, and the reply always carries liveness facts either way.
 */
function boundedWait(requested, fallback) {
	const value = typeof requested === 'number' && Number.isFinite(requested) ? requested : fallback
	if (value <= 0) return 0
	return Math.min(60_000, Math.floor(value))
}

export function registerLiveTools(ctx, resolved) {
	const tools = ctx.get('tools')
	if (tools === undefined) {
		// Fail loud instead of registering nothing. A silent early return here is
		// exactly the "row mounted but contributed nothing" failure mode: the mount
		// would still pass, and the three tools would simply never appear.
		throw new Error(`${PREFIX}: ctx.tools is unavailable, so the live-session tools cannot be registered`)
	}

	const sessions = new Map()
	/**
	 * Append-only raw stream + stage checkpoints, one directory per run.
	 *
	 * This exists because of a measured disaster: a medium run did 27 turns of real work,
	 * ran out of credit mid-flight, and left NOTHING behind. An artifact makes partial work
	 * outlive most endings — including the one where the mechanism itself died. Best-effort, not
	 * absolute: a failed write degrades to `durability=partial`, and retention only deletes runs
	 * whose checkpoint says they finished.
	 */
	const artifacts = createArtifactStore({ logger: ctx.logger })
	const timer = ctx.get('timer')
	// Without the sweeper, nobody observes `end_turn` for a run nobody polls — its turn-end notice
	// never fires — and the idle reaper cannot close a run nobody collects. (A child that EXITS still
	// settles its job through the exit watcher above, so terminal notices survive.) That is a real
	// degradation, and silence about it was the reviewer's one remaining high-severity finding.
	const sweeperActive = timer !== undefined && typeof timer.interval === 'function'
	if (sweeperActive !== true) {
		ctx.logger?.warn?.(
			`${PREFIX}: no timer service — turn-end notices and the idle reaper are DISABLED; every run must be ` +
				'read or stopped explicitly. Mount @deepseek-ai/dsh-timer to restore them.',
		)
	}
	let seq = 0

	const teardownAll = async () => {
		// Every teardown goes through the ONE settlement path, and the disposer AWAITS what it starts:
		// returning early meant the final read, the checkpoint fsync and the close could still be in
		// flight while the host shut down, so an artifact could be left unreadable. Cordis awaits an
		// async disposer, and the platform's own jobs plugin joins its settlements the same way.
		const settling = []
		for (const session of sessions.values()) {
			try {
				settling.push(finish(session, true))
			} catch {
				/* a disposer must never throw */
			}
		}
		await Promise.allSettled(settling)
	}
	ctx.effect(() => teardownAll, `${PREFIX}: dispose live Amp sessions`)

	// Health-aware selection, shared with the providers through the host row's
	// service so both paths pick accounts the same way. Falls back to the first
	// configured ref when this row is composed without the host row.
	const chooseAccount = async (mode) => {
		const pool = ctx.get('ampAccounts')
		// U3: hand the MODE down, so the pool applies the right floor instead of one flat gate.
		if (pool !== undefined && typeof pool.choose === 'function') return await pool.choose({ mode })
		const ref = resolved.accountRefs[0]
		const credential = await ctx.credentials.resolve(ref)
		const token = credential === undefined || typeof credential.value !== 'string' ? '' : credential.value
		if (token.trim() === '') {
			throw new Error(
				`${PREFIX}: credential ref "${ref}" is not configured (or is empty). Refusing to start Amp ` +
					"rather than let the CLI fall back to this machine's `amp login` account.",
			)
		}
		return { ref, token, detail: 'balance not checked', state: 'unchecked' }
	}

	/** Read only bytes produced since the previous read; never re-reads. */
	const readNew = (session) => {
		const reader = session.handle.collected?.stdout
		if (reader === undefined || reader === null) return ''
						const read = reader.readFrom(session.offset)
						session.offset = read.nextOffset
						if (read.lossy === true) session.lossy = true
						if (typeof read.spillPath === 'string') session.spillPath = read.spillPath
						return read.text
	}

	const readStderrNew = (session) => {
		const reader = session.handle.collected?.stderr
		if (reader === undefined || reader === null) return ''
		const read = reader.readFrom(session.stderrOffset)
		session.stderrOffset = read.nextOffset
		return read.text
	}

	/** Fold parsed messages into the session's own facts. */
	const foldMessages = (session, messages) => {
		for (const m of messages) {
			if (m === null || typeof m !== 'object') continue
			if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') session.threadId = m.session_id
			// Amp reports a system-level failure on its OWN channel, and the one-shot path has
			// always classified it (`foldStream` -> `systemError`). Dropping it here made the two
			// paths disagree about the same upstream error: live runs got `failure=null`, never
			// fed `noteRefusal`, and could pick the same throttled account again.
			if (m.type === 'system' && m.subtype !== 'init' && typeof m.error === 'string' && m.error !== '') session.systemError = m.error
			if (m.type === 'assistant' && m.message !== undefined && Array.isArray(m.message.content)) {
				// Counted, not inferred from text: an assistant message carrying only tool_use
				// still means the child did work, and "did any work happen" is what decides
				// whether a failure may be retried on another account.
				session.assistantMessages += 1
				const parts = []
				for (const block of m.message.content) {
					if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
						parts.push(block.text)
					}
				}
				if (parts.length > 0) {
					session.lastText = parts.join('\n')
					// The most substantive turn is kept too: a later one-line follow-up must not erase the
					// summary a woken agent relies on (measured: a test "OK" hid a whole report).
					if (session.lastText.length > (session.summaryText ?? '').length) {
						session.summaryText = session.lastText
					}
				}
				if (m.message.stop_reason === 'end_turn') session.turnEnded = true
			}
			if (m.type === 'result') {
				// Seeing the terminal result is NOT settlement. Settlement is the async
				// procedure that ends the child, finalizes the record, releases the account and
				// resolves the job — it lives in `finish()`. Marking the session finished HERE
				// made the exit observer skip `finish()` (its guard saw "already finished"), so
				// `markSettled` never ran and the DSH job stayed `running` forever. The two
				// facts are kept apart now: `resultReceived` is what the stream said, `finished`
				// is what this plugin has PROVEN by completing settlement.
				session.result = m
				session.resultReceived = true
			}
		}
	}

	/** Fold new bytes into the session and return the newly observed messages. */
	const absorb = (session) => {
		const text = readNew(session)
		// Persist the raw bytes BEFORE parsing: the artifact is the truth even if parsing,
		// settlement, or the host itself dies on this very delta.
		if (text !== '' && session.artifact !== undefined) {
			// Redacted on the way in. The artifact is a durable file a human may read or hand to
			// someone else, and the plugin's single redaction rule (the injected token literal)
			// must not stop at the transcript boundary.
			noteArtifactWrite(session, artifacts.append(session.artifact, sanitize(text)), 'stream')
		}
		const stderr = readStderrNew(session)
		if (stderr !== '') {
			session.stderrTail = clip(sanitize(stderr), 800)
			// stderr is part of the truth too. It is appended with a `#` marker so the protocol
			// stream stays parseable while nothing the child said is silently dropped.
			if (session.artifact !== undefined) noteArtifactWrite(session, artifacts.append(session.artifact, `# stderr: ${sanitize(stderr)}\n`), 'stderr')
			session.lastActivityAt = Date.now()
		}
		if (text === '') return []
		session.lastActivityAt = Date.now()
		const buffered = session.pending + text
		const split = splitCompleteLines(buffered)
		if (split.pending.length > PENDING_MAX_CHARS) {
			// A line that never terminates cannot be held forever: count it and move on.
			session.unparsed += 1
			session.pending = ''
		} else {
			session.pending = split.pending
		}
		if (split.complete === '') return []
		const parsed = parseLines(split.complete)
		if (parsed.unparsed.length > 0) session.unparsed += parsed.unparsed.length
		const transition = () =>
			`${String(session.threadId)}:${String(session.turnEnded)}:${String(session.finished)}:${String(session.resultReceived)}:${String(session.systemError)}`
		const before = transition()
		const wasTurnEnded = session.turnEnded === true
		foldMessages(session, parsed.messages)
		if (session.turnEnded === true && wasTurnEnded !== true) notifyTurnEnd(session)
		if (session.turnEnded === true && session.turnEndedAt === undefined) session.turnEndedAt = Date.now()
		if (session.turnEnded !== true) session.turnEndedAt = undefined
		// A transition worth surviving a crash: the thread became known, the turn ended, a
		// terminal result arrived, or a system-level error named the failure. Writing only on
		// transitions keeps the cost near zero.
		if (transition() !== before) saveCheckpoint(session)
		return digest(parsed.messages)
	}

	/**
	 * Parse the unterminated tail left by the last read. Amp's final line need not end
	 * with a newline, and dropping that line drops the `result` the run settles on.
	 */
	const flushPending = (session) => {
		const tail = session.pending
		session.pending = ''
		if (tail.trim() === '') return []
		const parsed = parseLines(tail)
		if (parsed.unparsed.length > 0) session.unparsed += parsed.unparsed.length
		foldMessages(session, parsed.messages)
		return digest(parsed.messages)
	}

	/**
	 * The facts a rescuer needs after a crash. Built in ONE place because the module's
	 * `finalize(handle, outcome)` REPLACES the checkpoint with `outcome` — passing only the
	 * ending facts there silently drops the run identity, so the artifact stopped saying
	 * which run it belonged to.
	 */
	const checkpointFacts = (session, extra) => ({
		runId: session.id,
		mode: session.mode,
		account: session.accountRef ?? null,
		threadId: session.threadId ?? null,
		turnEnded: session.turnEnded === true,
		// The protocol saw its terminal result. NOT the same fact as `finished`, which only
		// `finish()` writes: a rescue reading this must not conclude the run was settled.
		resultReceived: session.resultReceived === true,
		writes: session.writes,
		bytesSeen: session.offset,
		lastText: clip(sanitize(session.lastText), 2000),
			summaryText: clip(sanitize(session.summaryText), 2000),
		failure: session.failure ?? null,
		// The projected terminal status, so retention can distinguish a finished success from a
		// finished failure that no classifier named (non-zero exit, partial artifact, and so on).
		status: session.outcome?.status ?? null,
		// Honesty about what the artifact may be missing: a lossy read means bytes slid out of
		// the in-memory window before anyone observed them, and the checkpoint must say so.
		lossy: session.lossy === true,
		deliveryLossy: session.deliveryLossy === true,
		spillPath: session.spillPath ?? null,
		...(extra ?? {}),
	})

	/**
	 * Tell the owning agent that this run finished a turn and is still open.
	 *
	 * This is the signal the whole A1 effort exists for: the delegating agent must never poll to
	 * discover that a child handed control back. It fires on `end_turn`, NOT on settlement, so the
	 * run stays alive and can still be steered — settlement is a different event with different
	 * wording.
	 *
	 * The wake budget is the HOST's, mirrored exactly rather than reinvented: `tool-jobs` counts
	 * frames per exact Agent in a `WeakMap`, refills when that agent consumes a human message, and
	 * once the budget is spent it still DELIVERS — as `inject`, which rides the next step instead
	 * of opening one. A per-run counter (the previous shape) bounded nothing across runs: N runs
	 * meant 3N automatic turns, and the 4th notice of one run was dropped outright rather than
	 * injected, so progress could vanish silently.
	 */
	const MAX_CONSECUTIVE_WAKES = 3
	const spentWakes = new WeakMap()
	// Refill on the same event the platform uses: the agent CLAIMED a message that came from a
	// human. A notice this plugin queued must not refill the budget it just spent.
	if (typeof ctx.on === 'function') {
		ctx.on('agent/inbox/claimed', (payload) => {
			const agent = payload?.agent
			if (agent === undefined || agent === null) return
			if (payload?.message?.source?.kind === 'user') spentWakes.delete(agent)
		})
	}
	const notifyTurnEnd = (session) => {
		const agent = session.agent
		if (agent === undefined || agent === null) return
		if (session.settling === true || session.settlePromise !== undefined) return
		const failure = session.failure
		// Reuse the classifier's own predicate: only a kind that provably did no work is safe to
		// retry. `other` (an unknown/compaction failure) is explicitly not, so the old
		// `failure !== undefined` test contradicted `describeFailure('other')` and
		// `isNoWorkFailure`.
		const noWork = failure !== undefined && isNoWorkFailure(failure.kind) && session.assistantMessages === 0 && session.quiescenceUnproven !== true
		const lastTurn = clip(sanitize(session.lastText).replace(/\s+/gu, ' '), 300)
		const summary = clip(sanitize(session.summaryText).replace(/\s+/gu, ' '), 400)
		const text =
			`Amp run ${session.id} finished its turn and is waiting for you. ` +
			`mode=${session.mode} account=${String(session.accountRef)} ` +
			(session.threadId === undefined ? `thread=unknown ` : `thread=${session.threadId} `) +
			(failure === undefined ? `` : `failure=${failure.kind} `) +
			(noWork ? `retryable=true(no work was performed) ` : ``) +
			(session.artifactPath === undefined ? `` : `artifact=${session.artifactPath} `) +
			(lastTurn === '' ? `` : `lastTurn="${lastTurn}" `) +
			// Only when it adds information: the longest turn is often the one that did the work.
			(summary === '' || summary === lastTurn ? `` : `summary="${summary}" `) +
			`state=waiting. Next: amp_send_message (steer/read) or amp_stop.`
		let message
		try {
			message = createUserMessage({
				content: [{ type: 'text', text }],
				source: { kind: 'plugin', plugin: 'dsh-amp', form: 'notice', summary: `${session.id} turn ended` },
			})
		} catch {
			return
		}
		try {
			const spent = spentWakes.get(agent) ?? 0
			if (agent.status === 'idle' && spent < MAX_CONSECUTIVE_WAKES && typeof agent.followup === 'function') {
				spentWakes.set(agent, spent + 1)
				agent.followup(message)
			} else if (typeof agent.inject === 'function') {
				// Budget spent (or the owner is busy): the notice is still delivered, it simply
				// does not open a turn of its own.
				agent.inject(message)
			}
		} catch {
			/* a notice must never break the run it describes */
		}
	}

	/**
	 * THE terminal outcome. Computed exactly once at settlement, after every fact is in: process
	 * outcome, failure classification, artifact finalize result, quiescence, settlement error.
	 * Every consumer (job snapshot, amp_stop) PROJECTS this — none re-derives it, which is what
	 * let the same run be reported as completed by one surface and failed by another.
	 */
	const terminalOutcome = (session) => {
		const killed = session.killedByCancel === true
		const completed =
			killed !== true &&
			session.failure === undefined &&
			session.settleError === undefined &&
			session.result !== undefined &&
			session.result.is_error !== true &&
			session.exitCode === 0
		// A run can be genuinely complete while its RECORD is not. Keeping those orthogonal is what
		// stops us promising "the work is on disk" about a file that stopped being written.
		const durability =
			session.artifactError === undefined && session.artifactWriteError === undefined ? 'complete' : 'partial'
		const processStatus = killed ? 'killed' : completed ? 'completed' : 'failed'
		// The jobs status is a closed enum, so degradation has no status of its own. A run whose
		// durable record is partial, or whose managed process range is not proven stopped, is
		// projected as failed: a consumer reading only `status` must not hear "clean success"
		// about a run we cannot fully account for. The process facts ride along untouched.
		const degraded = processStatus === 'completed' && (durability === 'partial' || session.quiescenceUnproven === true)
		return {
			status: degraded ? 'failed' : processStatus,
			processStatus,
			durability,
			runId: session.id,
			mode: session.mode,
			accountRef: session.accountRef ?? null,
			threadId: session.threadId ?? null,
			exitCode: session.exitCode ?? null,
			failure: session.failure ?? null,
			quiescenceUnproven: session.quiescenceUnproven === true,
			artifactPath: session.artifactPath,
			artifactError: session.artifactError,
			artifactWriteError: session.artifactWriteError,
			settleError: session.settleError,
			assistantMessages: session.assistantMessages,
			turnEnded: session.turnEnded === true,
			writes: session.writes,
		}
	}

	/**
	 * A durable record that silently STOPS recording is worse than no record: the rescuer reads a
	 * complete-looking file that is missing the last — usually most interesting — part of the run.
	 * The first failure is kept and reported; bookkeeping never fails the run itself.
	 */
	const noteArtifactWrite = (session, result, what) => {
		if (result === undefined || result.ok === true) return
		if (session.artifactWriteError === undefined) session.artifactWriteError = `${what}: ${String(result.error)}`
	}

	const saveCheckpoint = (session, extra) => {
		if (session.artifact === undefined) return
		noteArtifactWrite(session, artifacts.checkpoint(session.artifact, checkpointFacts(session, extra)), 'checkpoint')
	}

	const requireSession = (caller, runId) => {
		// Fail CLOSED. `amp_run` already refuses a missing calling agent, and the
		// platform's own job fence treats a no-agent caller as never matching an owner;
		// skipping the check here let an agent-less caller reach ANY session's run.
		if (caller === undefined || String(caller.id) === '') {
			throw new Error(`${PREFIX}: a live Amp run can only be reached from the agent that started it`)
		}
		const session = sessions.get(String(runId))
		if (session === undefined) {
			throw new Error(`${PREFIX}: unknown run "${String(runId)}". Known runs: ${[...sessions.keys()].join(', ') || '(none)'}`)
		}
		if (session.owner !== undefined && session.owner !== String(caller.id)) {
			throw new Error(`${PREFIX}: run "${String(runId)}" belongs to another session and cannot be steered or stopped from here.`)
		}
		return session
	}

	const statusOf = (session) => {
		if (session.settling) return 'finishing'
		if (session.finished && session.quiescenceUnproven === true) {
			// Settlement completed, but the managed range was NOT proven empty. Calling this plain
			// "finished" let the read surface imply a process death the plugin never proved.
			return 'finished (quiescence unproven — the process may still be alive)'
		}
		if (session.finished) return 'finished'
		// The protocol's terminal message is in, but settlement has not completed. Saying
		// "finished" here would claim a fact this plugin has not proven — and that word is what
		// the exit observer used to skip settlement on.
		if (session.resultReceived === true) return 'result received (collect with amp_stop)'
		if (session.exited === true) return 'exited (collect with amp_stop)'
		return session.turnEnded ? 'idle (turn ended, run still open)' : 'running'
	}

	/** A bounded wait signal, or `undefined` on a runtime that lacks the helper. */
	const settleSignal = (ms) =>
		typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined

	/**
	 * Close stdin (or kill) and wait for the managed range to actually go quiet, bounded.
	 *
	 * The returned promise IS the settlement. A second `amp_stop` awaits this same one
	 * instead of racing it and reporting `completed` with empty output while the first
	 * call was still collecting; a kill arriving mid-settle is still honoured.
	 */
	const finish = (session, kill) => {
		if (session.settlePromise !== undefined) {
			if (kill === true) {
				// A kill arriving mid-settle is still a kill, and the OUTCOME must say so: the
				// first settlement was started gracefully, so without this the run the caller
				// terminated reports `failed` (or `completed`, if the dying child happened to
				// emit a success result) instead of `killed`. Recorded BEFORE terminating.
				if (session.exited !== true) session.killedByCancel = true
				try {
					session.handle.terminate()
				} catch {
					/* already gone */
				}
			}
			return session.settlePromise
		}
		session.settling = true
		session.settlePromise = (async () => {
			// Phase 1 — teardown. Contained: whatever this cannot prove is recorded as unproven
			// quiescence, never allowed to skip finalization.
			try {
				if (kill === true) {
					// Only a kill that actually ended a RUNNING child is reported as `killed`. A
					// cancel arriving after a natural ending must not rewrite that ending.
					if (session.exited !== true) session.killedByCancel = true
					session.handle.terminate()
				} else session.handle.stdin.end()
			} catch {
				/* already gone */
			}
			try {
				let quiet = await session.handle.waitForExit(settleSignal(STOP_GRACE_MS))
				// `waitForExit` proves the managed range is empty; it says nothing about the exit
				// CODE. Without this the status whitelist could see `exitCode === undefined` and
				// report a gracefully finished run as failed — a race, not a judgement.
				if (session.exitCode === undefined) {
					try {
						// Bounded at 500ms: the two signals come from the same process exit, so the
						// real gap is sub-millisecond. A long bound would tax every settlement whose
						// exit code never arrives at all.
						const outcome = await Promise.race([
							session.handle.done,
							new Promise((resolve) => setTimeout(() => resolve(undefined), 500)),
						])
						if (outcome !== undefined && outcome !== null && outcome.exitCode !== undefined) {
							session.exitCode = outcome.exitCode
						}
					} catch (error) {
						session.exitError = sanitize(String(error?.message ?? error))
					}
				}
				if (quiet !== true) {
					// The grace bound expired while the managed range was still non-empty.
					// Terminate, then re-wait once. An unproven quiescence is REPORTED, never
					// presented as a clean stop — that is what made `amp_stop` hang forever.
					try {
						session.handle.terminate()
					} catch {
						/* gone */
					}
					quiet = await session.handle.waitForExit(settleSignal(STOP_GRACE_MS))
				}
				if (quiet === true) session.quiescenceProven = true
				else session.quiescenceUnproven = true
			} catch {
				// The provider can no longer observe its managed range: nothing to prove.
				session.quiescenceUnproven = true
			}
			// Phase 2 — the last bytes and the failure verdict. Each step is CONTAINED: a throw in
			// one of them must not skip the next, and must not skip phase 3 (the reviewer's
			// reproduction had a throwing reader leave the claim held and the record unfinalized).
			try {
				absorb(session)
				flushPending(session)
			} catch (error) {
				session.settleError = sanitize(String(error?.message ?? error))
			}
			try {
				// Fold the failure back into the pool so the NEXT dispatch is better informed. This
				// is what keeps the delegating agent out of the credit business: a throttle is
				// remembered for its own window, and a credit refusal forces this ONE account's
				// balance to be re-read instead of trusting a stale number.
				// `systemError` is the same input the one-shot path classifies: a system-level
				// failure arrives on its own channel and must reach the classifier too, or the two
				// paths answer differently about one upstream error.
				const errorText =
					session.result !== undefined && typeof session.result.error === 'string'
						? session.result.error
						: (session.systemError ?? session.exitError ?? '')
				if (errorText !== '') session.failure = classifyAmpError(errorText)
				if (session.failure !== undefined && session.refusalNoted !== true) {
					session.refusalNoted = true
					try {
						void ctx.get('ampAccounts')?.noteRefusal?.(session.accountRef, session.failure, session.claimToken)?.catch?.(() => {})
					} catch {
						/* accounting is best-effort; a run must never fail because of it */
					}
				}
				// A clean run clears any refusal streak: an account that just worked is trusted again,
				// so a single bad minute cannot retire it for the life of the process.
				const clean = session.failure === undefined && session.result !== undefined && session.result.is_error !== true
				if (clean && session.successNoted !== true) {
					session.successNoted = true
					try {
						const pool = ctx.get('ampAccounts')
						pool?.noteSuccess?.(session.accountRef, session.claimToken)
						// A live run spends credit exactly like a one-shot one, and the ledger's staleness
						// window is ten minutes: without this read the NEXT dispatch inside that window is
						// chosen on a number that predates this run. One account, one read, after the fact.
						void pool?.refresh?.(session.accountRef, session.claimToken)?.catch?.(() => {})
					} catch {
						/* accounting is best-effort */
					}
				}
			} catch (error) {
				session.settleError = session.settleError ?? sanitize(String(error?.message ?? error))
			}
			try {
				// A5: final checkpoint. Done AFTER the failure is known so the last checkpoint names how
				// the run ended. The one terminal outcome is computed FIRST so the record carries the
				// same `status` every other consumer projects — retention needs it to spot failures no
				// classifier named.
				session.outcome = terminalOutcome(session)
				if (session.artifact !== undefined) {
					const finalized = artifacts.finalize(
						session.artifact,
						checkpointFacts(session, {
							finished: true,
							exitCode: session.exitCode ?? null,
							quiescenceUnproven: session.quiescenceUnproven === true,
							settleError: session.settleError,
						}),
					)
					if (finalized.ok === true) session.artifactPath = finalized.artifactPath
					else session.artifactError = finalized.error
				}
			} catch (error) {
				// The runtime outcome is recomputed below, so a finalize failure is still visible to
				// consumers even though the file it would have written cannot carry it.
				session.settleError = session.settleError ?? sanitize(String(error?.message ?? error))
				session.artifactError = session.artifactError ?? sanitize(String(error?.message ?? error))
			}
		})().catch((error) => {
			// A settlement must never REJECT: `amp_stop` and the job both await it, and a
			// rejection would surface as a raw tool error instead of a diagnostic the caller
			// can act on. Recorded on the session, reported in the stop diagnostic.
			session.settleError = sanitize(String(error?.message ?? error))
		}).finally(() => {
			// THE GUARANTEED CLEANUP. Everything here must run on every ending — a settlement that
			// threw in any phase above must not hold the account for the 30-minute TTL, and must not
			// leave the job's `done` pending (a pending `done` keeps the job `running` forever and
			// makes the owning agent's disposal wait on it).
			try {
				// Token-scoped: in the fail-open case another live run holds this same ref, and a
				// tokenless release would drop ITS claim instead of mine.
				ctx.get('ampAccounts')?.release?.(session.accountRef, session.claimToken)
			} catch {
				/* a claim is a preference; failing to drop it must not fail settlement */
			}
			session.finished = true
			if (session.closedAt === undefined) session.closedAt = Date.now()
			session.settling = false
			// Recomputed UNCONDITIONALLY: the projection made before finalize cannot know whether
			// the finalize itself failed, and that fact changes `durability` → `status`.
			session.outcome = terminalOutcome(session)
			if (typeof session.markSettled === 'function') session.markSettled()
		})
		return session.settlePromise
	}

	// ---- start ----
	ctx.effect(
		() =>
			tools.register(
				defineTool({
					name: 'amp_run',
					description:
						'Start a steerable Amp run and return IMMEDIATELY with a run handle: the child keeps working while you do. ' +
						'Use `amp_send_message` to steer it mid-run or to read what it has produced so far, and `amp_stop` to end the run ' +
						'and collect its full output. When the child finishes a turn you are NOTIFIED and the run STAYS OPEN: it keeps ' +
						'accepting `amp_send_message` turns, so there is nothing to poll. It ends when you `amp_stop` it, when the child ' +
						'exits, or when the idle reaper closes it (default 20 minutes). Requires the host jobs row: without a job slot the ' +
						'run is refused rather than started untracked. ' +
						(sweeperActive === true
							? ''
							: 'WARNING: this host has no timer service, so you will NOT be told when a turn ends and ' +
								'nothing will reap an abandoned run — read it or stop it yourself. ') +
						'Amp works in this session\'s working directory and does NOT see this conversation, ' +
						'so give it a complete standalone prompt. For plain fire-and-forget delegation prefer `subagent_amp_*`.',
					parameters: {
						prompt: { type: 'string', required: true, description: 'The complete, self-contained task for the Amp child.' },
						mode: {
							type: 'string',
							enum: [...resolved.modes],
							description: `Amp agent mode (${resolved.modes.join(' | ')}).`,
						},
					},
					output: {
						schema: { type: 'string' },
						render(_args, value) {
							return [{ type: 'text', text: String(value) }]
						},
					},
					async execute(args, exec) {
						if (exec.agent === undefined) throw new Error(`${PREFIX}: amp_run requires a calling agent`)
						// Checked BEFORE selection: a prompt we will refuse must not consume an account claim.
						const promptBytes = Buffer.byteLength(String(args.prompt), 'utf8')
						if (promptBytes > MAX_PROMPT_BYTES) {
							throw new Error(
								`${PREFIX}: the prompt is ${String(promptBytes)} bytes but this path can deliver at most ` +
									`${String(MAX_PROMPT_BYTES)}; refusing rather than sending a truncated instruction — split the task, ` +
									'or point the child at a file it can read.',
							)
						}
						// The mode is resolved BEFORE selection now: it decides the floor the chosen
						// account must clear, so picking first and asking second would be backwards.
						const requested = typeof args.mode === 'string' && resolved.modes.includes(args.mode) ? args.mode : resolved.modes[0]
						// An empty instruction is not a task. The schema makes `prompt` required but an
						// empty string satisfies it; without this the pool claims an account, the child
						// starts, builds a thread, and answers `No valid messages found in stdin`.
						if (String(args.prompt).trim() === '') {
							throw new Error(
								`${PREFIX}: amp_run needs a non-empty prompt; an empty instruction would start a paid run with nothing to do.`,
							)
						}
						// A settings namespace this row could not register means a page edit would
						// never reach this run. Refuse rather than dispatch a configuration nobody
						// can see or change.
						const settingsError = ctx.get('ampAccounts')?.settingsError
						if (settingsError !== undefined) throw new Error(`${PREFIX}: ${settingsError}`)
						// `jobs` is REQUIRED, and now checked BEFORE selection AND before any spawn.
						//
						// The jobs contract is explicit that a preflight rejection "leaves no job id or
						// execution resource", so the child must be created inside `run()` — the callback
						// the registry invokes only after preflight passes. Creating it earlier (the
						// previous shape) left an abandoned Amp process and server-side thread behind
						// every refused slot, and the account claim behind it too.
						const jobs = ctx.get('jobs')
						if (typeof jobs?.start !== 'function') {
							throw new Error(
								`${PREFIX}: this host provides no jobs service, so a delegated run could not be ` +
									'cancelled, awaited or reported to its owner. Mount the host jobs row (dsh-tool-jobs), ' +
									'or use the one-shot subagent path instead.',
							)
						}
						const sessionsApi = ctx.get('sessions')
						const parent = sessionsApi?.get?.(exec.agent.id)
						const parentCwd = typeof parent?.header?.cwd === 'string' ? parent.header.cwd : undefined
						const cwd = parentCwd ?? resolved.configuredCwd ?? process.cwd()

						const account = await chooseAccount(requested)
						const token = account.token
						/** Hand the claim back on any path that never publishes a run. Idempotent. */
						const releaseClaim = () => {
							try {
								// Token-scoped: in the fail-open case another live run can hold this same
								// ref, and a tokenless release would drop ITS claim instead of mine.
								ctx.get('ampAccounts')?.release?.(account.ref, account.claimToken)
							} catch {
								/* a claim is a preference; failing to drop it must not fail the caller */
							}
						}
						// The run is live and will release its own claim at settlement; anything that
						// throws before then must release it here.
						let published = false
						try {
							const env = { AMP_API_KEY: token }
							const executable = await ctx.subprocess.resolveExecutable(resolved.ampBin, env)

							seq += 1
							const runId = `${PREFIX}-run-${seq}`
							const argv = [
								executable,
								'--execute',
								'--stream-json',
								'--stream-json-input',
								'--mode',
								requested,
								'--visibility',
								resolved.visibility,
								'--no-color',
								// `--ide` is on by default and attaches the open editor's file and
								// selection to every message; that leaks unrelated context in.
								'--no-ide',
							]
							if (resolved.keepThreads) argv.push('--no-archive-after-execute')

							let handle
							let session
							let jobId
							/** Whether the registry actually invoked `run()`. */
							let runInvoked = false
							try {
								jobId = jobs.start({
									kind: 'amp-live',
									label: `${requested}: ${clip(String(args.prompt).replace(/\s+/gu, ' '), 80)}`,
									outputLimitBytes: DELIVERY_MAX_BYTES,
									owner: exec.agent,
									// EVERY execution resource is created here, after preflight: a throw
									// leaves nothing registered, so this closure cleans up after itself.
									run: () => {
										runInvoked = true
										try {
											handle = ctx.subprocess.spawn({
												argv,
												cwd,
												stdio: {
													stdin: 'pipe',
													stdout: { maxBytes: STDOUT_MAX_BYTES, spill: { maxBytes: STDOUT_SPILL_BYTES } },
													stderr: { maxBytes: STDERR_MAX_BYTES },
												},
												graceMs: resolved.graceMs,
												env,
											})
											session = {
												id: runId,
												owner: String(exec.agent.id),
												// A1: the LIVE agent to wake when this run hands control back to it.
												agent: exec.agent,
												mode: requested,
												accountRef: account.ref,
							/** The lease this run owns; releasing with it cannot free another run's claim. */
							claimToken: account.claimToken,
												artifact: undefined,
												artifactPath: undefined,
												artifactError: undefined,
												artifactWriteError: undefined,
												cwd,
												handle,
												offset: 0,
												// A1: the second cursor, owned exclusively by the job's readOutput().
												deliveryOffset: 0,
												deliveryLossy: false,
												/** How many assistant messages were seen; 0 means the child never got to work. */
												assistantMessages: 0,
												jobId: undefined,
												cancelRequested: false,
												killedByCancel: false,
												settled: undefined,
												markSettled: undefined,
												stderrOffset: 0,
												threadId: undefined,
												lastText: '',
												result: undefined,
												// The protocol's terminal result was seen — NOT settlement. `finished` is
												// written only by finish(), and the two must never be conflated (see
												// foldMessages).
												resultReceived: false,
												systemError: undefined,
												turnEnded: false,
												turnEndedAt: undefined,
												finished: false,
												settling: false,
												settlePromise: undefined,
												closedAt: undefined,
												pending: '',
												exited: false,
												exitCode: undefined,
												exitError: undefined,
												quiescenceUnproven: false,
							/** `waitForExit()` PROVED the managed range empty (vs merely unproven). */
							quiescenceProven: false,
												stdinError: undefined,
												lossy: false,
												spillPath: undefined,
												unparsed: 0,
												writes: 0,
												stderrTail: '',
												startedAt: Date.now(),
												lastActivityAt: Date.now(),
											}
											sessions.set(runId, session)
											// The job's `done` must resolve on EVERY ending, including one nobody asked
											// for. `finish` is the single settlement point, so it resolves this once.
											let markSettled
											session.settled = new Promise((resolve) => {
												markSettled = resolve
											})
											session.markSettled = () => markSettled()
											// A5: the run's own record. Opened before anything else can fail, so even a
											// crash one second later leaves a readable artifact directory behind — and the
											// prompt is appended too, so the artifact shows what it was asked to do.
											// The artifact key must survive a restart: `runId` restarts at run-1 in every
											// new process, AND two hosts sharing one DSH_HOME can be in the same
											// millisecond, so neither a per-process counter nor a timestamp is an
											// identity. pid + uuid makes the key unique across processes and replays.
											const artifactKey = `${runId}-${String(Date.now())}-${String(process.pid)}-${randomUUID().slice(0, 8)}`
											session.artifactKey = artifactKey
											session.artifact = artifacts.open(artifactKey, {
												mode: requested,
												account: account.ref,
												cwd,
												startedAt: session.startedAt,
											})
											if (session.artifact.ok === false) {
												session.artifactError = session.artifact.error
												session.artifact = undefined
											} else {
												// Recorded at OPEN time, not at finalize: the outcome is projected before the
												// artifact is finalized (so the checkpoint can carry its status), and a verdict
												// that needs the path must not depend on a later step.
												session.artifactPath = session.artifact.streamPath
												noteArtifactWrite(session, artifacts.append(session.artifact, userLine(String(args.prompt), false)), 'prompt')
												saveCheckpoint(session, { startedAt: session.startedAt, cwd })
											}
											// Record the dispatch so the ledger knows this account is in use; the
											// confirmation read happens after the run, not before it.
											try {
												ctx.get('ampAccounts')?.noteDispatch?.(account.ref)
											} catch {
												/* the ledger is best-effort; a run must not fail because of it */
											}
											// Observe the REAL process outcome. Without this, a child that dies on its
											// own keeps answering `alive: true` until something else happens to read it.
											// The guard is the SETTLEMENT, never a protocol flag: `resultReceived` says
											// only that the stream ended, and treating it as "already settled" is what
											// left `markSettled` uncalled and the DSH job running forever.
											const onExit = () => {
												if (session.settlePromise === undefined && session.settling !== true) void finish(session, false)
											}
											void handle.done
												.then((outcome) => {
													session.exited = true
													session.exitCode = outcome === undefined ? undefined : outcome.exitCode
													onExit()
												})
												.catch((error) => {
													session.exited = true
													session.exitError = sanitize(String(error?.message ?? error))
													onExit()
												})
											// A write to a dead child surfaces as an ASYNC 'error' on the pipe, and an
											// unhandled one takes the host process down. Record it instead, so that
											// `delivered: true` can never be a claim the pipe did not honour.
											try {
												handle.stdin?.on?.('error', (error) => {
													session.stdinError = sanitize(String(error?.message ?? error))
												})
											} catch {
												/* the stream does not support listeners */
											}
											// ---- A1: make this run a first-class background job ----
											//
											// Why: measured today, the delegating agent spent 25 active reads/waits just to
											// learn what its children were doing, because nothing woke it. A registered job
											// settles into `owner.followup(...)`, which opens the caller's next turn by
											// itself. It also inherits the platform's per-owner admission limit and its
											// session-id fence, which the plugin's own fence could only imitate.
											//
											// Two independent cursors, never one shared: `offset` (protocol, advanced only
											// by absorb) and `deliveryOffset` (advanced only by readOutput). `readFrom` is
											// non-consuming, so both can read the whole stream without stealing from each
											// other — the design review's "double cursor" requirement, satisfied literally.
											const cancel = () => {
												session.cancelRequested = true
												void finish(session, true)
											}
											const done = session.settled.then(() => {
												const o = session.outcome ?? terminalOutcome(session)
												// A run that exited non-zero, or reported an error result, is NOT
												// "completed" just because nobody classified its prose as a failure.
												// `completed` is a WHITELIST. The old shape asked "is it a known failure?" and
												// answered `completed` by default, so an externally SIGKILLed child (exitCode
												// null, no result, no prose) was reported as a success.
												// A clean exit is not enough: the one-shot path already requires a real success
												// result, and a run that exited 0 without one has nothing to show for itself.

												// Kind-specific facts the notice renders. The woken agent gets: what ran,
												// on whose money, which thread to point at, how it ended, whether the
												// failure is worth retrying, the last thing the child said, the artifact
												// path, and what it can do next — without reading anything first.
												const lastSay = clip(sanitize(session.lastText).replace(/\s+/gu, ' '), 160)
												return {
													status: o.status,
													detail: [
														`run=${session.id}`,
														`mode=${session.mode}`,
														session.accountRef === undefined ? undefined : `account=${session.accountRef}`,
														session.threadId === undefined ? 'thread=unknown' : `thread=${session.threadId}`,
														session.failure === undefined ? undefined : `failure=${session.failure.kind}`,
														// U2/U3: "no work happened" is the fact that makes a retry safe, and it is
														// the one fact a woken agent cannot infer from the status alone — so the
														// notice also says which retry is safe.
														o.status === 'failed' &&
														isNoWorkFailure(o.failure?.kind) &&
														o.assistantMessages === 0 &&
														// A possibly-alive orphan makes "retry now" the wrong move as well.
														o.quiescenceUnproven !== true
															? 'retryable=true(no work was performed; the pool recorded this refusal, so a new amp_run picks differently)'
															: undefined,
														lastSay === '' ? undefined : `lastTurn="${lastSay}"`,
														// The third verdict. A run that DID work and then died (an upstream crash, a
														// failed compaction) must not be called retryable — that would redo the work —
														// but it is not lost either: the artifact holds it. Say so, and say where.
														o.status === 'failed' && o.assistantMessages > 0 && o.artifactPath !== undefined && o.durability === 'complete' && o.quiescenceUnproven !== true
															? `resumable=true(work is on disk; start a new run that reads ${session.artifactPath} and continues)`
															: undefined,
														session.artifactPath === undefined ? undefined : `artifact=${session.artifactPath}`,
														o.durability === 'partial' ? 'durability=partial(the durable record is incomplete)' : undefined,
												o.quiescenceUnproven === true ? 'quiescence=unproven(an orphan process may still be alive; amp_stop can confirm)' : undefined,
												o.status !== o.processStatus ? `degraded=reported-as-${o.status}(processStatus=${o.processStatus})` : undefined,
														o.artifactWriteError === undefined
															? undefined
															: `artifact=INCOMPLETE(${sanitize(o.artifactWriteError)}) — do not trust this record as the whole run`,
														// U7: the next move, stated where the woken agent is looking.

														// A settlement that threw is recorded AFTER this snapshot is built, so the
														// notice cannot carry it; it points at the surface that always can.
														'if the run looks empty, amp_stop reports any settlement error',
														// A terminal run cannot be steered — suggesting it here contradicted the reject in
														// amp_send_message and invited a pointless call.
														// With quiescence unproven, a second run is exactly what the withheld
														// `retryable`/`resumable` verdicts were protecting against.
														o.quiescenceUnproven === true
															? 'state=terminal next="first establish what happened to the previous process (it may still be alive), then decide; do NOT start a new run yet"'
															: 'state=terminal next="read the artifact, or start a new amp_run"',
													]
														.filter((part) => part !== undefined)
														.join(' '),
												}
											})
											const readOutput = () => {
												const reader = session.handle?.collected?.stdout
												if (reader === undefined || reader === null) return ''
												const read = reader.readFrom(session.deliveryOffset)
												session.deliveryOffset = read.nextOffset
												if (read.lossy === true) session.deliveryLossy = true
												const text = sanitize(read.text)
												if (text === '') return ''
												const clipped = clip(text, DELIVERY_MAX_CHARS)
												if (session.deliveryLossy !== true) return clipped
												// Never claim completeness that cannot be proven: a lossy read means bytes
												// were gone before anyone observed them, so the artifact cannot hold them
												// either — it holds everything observed, and nothing more.
												return `${clipped}\n[older bytes slid out of the in-memory window before they were observed; the artifact holds everything observed, and nothing more]`
											}
											return { cancel, done, readOutput }
										} catch (error) {
											// The registry registers NOTHING when run() throws, and the jobs contract says the producer
											// then cleans up whatever it partially started: the process ladder, the artifact handle, and
											// anything waiting on settlement.
												try {
													handle?.terminate?.()
												} catch {
													/* already gone */
												}
												// `run()` must return its hooks SYNCHRONOUSLY, so the bounded wait can only be STARTED here;
												// the termination ladder owns the rest.
												try {
													void handle?.waitForExit?.(settleSignal(STOP_GRACE_MS))
												} catch {
													/* an unobservable range is terminated as far as we can tell */
												}
												if (session !== undefined && session.artifact !== undefined) {
													// Close the handle we opened, so a failed start leaks neither an fd nor a blank-looking
													// rescue directory. `finished:false` keeps it out of retention's deletable set.
													try {
														artifacts.finalize(session.artifact, {
															...checkpointFacts(session),
															finished: false,
															status: 'failed',
															error: sanitize(String(error?.message ?? error)),
														})
													} catch {
														/* the record is best-effort; the throw below is the real answer */
													}
												}
												if (session !== undefined) {
													try {
														session.markSettled?.()
													} catch {
														/* nothing was handed out that could be waiting on it */
													}
												}
												sessions.delete(runId)
												throw error
										}
									},
								})
							} catch (error) {
								// `run()` did not run, so this is a PREFLIGHT refusal: no process, no
								// thread, no artifact — only the claim, which the `finally` below hands
								// back. Saying so is the honest version of the old "the child has been
								// stopped": there was never a child. When `run()` DID run, its own error
								// is the accurate one (its cleanup already happened) and is re-thrown
								// unchanged rather than relabelled as a refusal.
								if (runInvoked) throw error
								throw new Error(
									`${PREFIX}: the host refused a background-job slot for this run ` +
										`(${sanitize(String(error?.message ?? error))}); no process was started, so there is ` +
										'nothing to stop, and the account claim was handed back.',
								)
							}
							// `run()` ran synchronously inside `start()`, so the session exists by now —
							// and it is PUBLISHED: from here the settlement path owns the claim.
							published = true
							session.jobId = jobId

							// Delivery happens only AFTER admission, and only through the handle the
							// registry's run() created.
							try {
								handle.stdin.write(userLine(String(args.prompt), false))
								session.writes += 1
							} catch (error) {
								sessions.delete(runId)
								await finish(session, true)
								throw new Error(`${PREFIX}: could not deliver the prompt to Amp: ${sanitize(String(error?.message ?? error))}`)
							}
							return JSON.stringify(
							{
								run: runId,
								jobId: session.jobId,
								...(sweeperActive === true
									? {}
									: {
											warning:
												'no timer service: this run will NOT notify you when a turn ends, and nothing will reap it ' +
												'if you forget it — read it or amp_stop it explicitly',
										}),
								mode: requested,
								account: account.ref,
								balance: account.detail,
								cwd,
								artifact: session.artifactError === undefined ? session.artifact?.streamPath : 'unavailable (' + session.artifactError + ')',
								source: SOURCE_VIEW,
								status: 'running',
								note: 'Use amp_send_message to steer or to read progress, amp_stop to end the run and collect the output.',
							},
							null,
							2,
						)
						} finally {
							// A published run owns its claim until settlement (finish() releases it).
							// Every failure before publication — a missing jobs service, a refused
							// slot, a failed executable resolution, a refused prompt block — hands the
							// claim back here, so a refusal never pushes the next dispatch off a
							// healthy account for the 30-minute TTL.
							if (!published) releaseClaim()
						}
					},
				}),
			),
		`${PREFIX}: register amp_run`,
	)

	// ---- steer / read ----
	ctx.effect(
		() =>
			tools.register(
				defineTool({
					name: 'amp_send_message',
					description:
						'Send one more message to a running Amp child, and receive everything it has produced since the previous read. ' +
						'While the child is busy the message is handled at its nearest interruption point (steering); while it is idle it ' +
						'starts another turn. Omit `message` to only watch progress — the call waits up to `wait_ms` for something to happen ' +
						'and always reports liveness, so an empty answer is never ambiguous. The run stays open until `amp_stop`.',
					parameters: {
						run: { type: 'string', required: true, description: 'Run handle returned by amp_run.' },
						message: { type: 'string', description: 'Message to deliver. Omit to just read progress.' },
						steer: {
							type: 'boolean',
							description: 'true = interrupt at the nearest step boundary. Default false = a normal next turn.',
						},
						wait_ms: {
							type: 'number',
							description:
								'How long to wait for something to happen before answering (default 8000, max 60000). Use 0 for an instant snapshot.',
						},
					},
					output: {
						schema: { type: 'string' },
						render(_args, value) {
							return [{ type: 'text', text: String(value) }]
						},
					},
					async execute(args, exec) {
						const session = requireSession(exec.agent, args.run)
						const delivered = typeof args.message === 'string' && args.message !== ''
						if (delivered) {
							const bytes = Buffer.byteLength(args.message, 'utf8')
							if (bytes > MAX_PROMPT_BYTES) {
								throw new Error(
									`${PREFIX}: that message is ${String(bytes)} bytes but this path can deliver at most ` +
										`${String(MAX_PROMPT_BYTES)}; refusing rather than delivering a truncated instruction.`,
								)
							}
						}
						if (delivered) {
							if (session.finished || session.settling || session.exited === true || session.resultReceived === true) {
								throw new Error(
									`${PREFIX}: run "${session.id}" has ended. Amp has no way to reopen a live run; start a new amp_run ` +
										`pointing at thread ${session.threadId ?? '(unknown)'} to continue the work.`,
								)
							}
							try {
								session.handle.stdin.write(userLine(String(args.message), args.steer === true))
							} catch (error) {
								// Never report `delivered: true` for a write that threw.
								throw new Error(
									`${PREFIX}: could not deliver the message to run "${session.id}": ${sanitize(String(error?.message ?? error))}`,
								)
							}
							session.writes += 1
							session.turnEnded = false
							session.turnEndedAt = undefined
						}
						const fresh = absorb(session)
						const waitMs = boundedWait(args.wait_ms, 8000)
						const deadline = Date.now() + waitMs
						let observed = fresh
						while (
							observed.length === 0 &&
							session.finished !== true &&
							session.settling !== true &&
							session.exited !== true &&
							session.resultReceived !== true &&
							Date.now() < deadline &&
							timer !== undefined &&
							typeof timer.timeout === 'function'
						) {
							await timer.timeout(Math.min(250, Math.max(1, deadline - Date.now())))
							observed = absorb(session)
						}
						const idleMs = Date.now() - session.lastActivityAt
						return JSON.stringify(
							{
								run: session.id,
								status: statusOf(session),
								threadId: session.threadId ?? null,
								// Liveness facts, always. `alive` now comes from the REAL process
								// outcome, not from whether a protocol message happened to parse.
								// Three states, never a guess: `false` only when the process exited or the
								// managed range was PROVEN empty; `null` when settlement finished but
								// quiescence was unproven (an orphan may still be alive); `true` otherwise.
								alive:
									session.exited === true || session.quiescenceProven === true
										? false
										: session.quiescenceUnproven === true
											? null
											: true,
								elapsedMs: Date.now() - session.startedAt,
								idleMs,
								bytesSeen: session.offset,
								waitedMs: Math.min(waitMs, Math.max(0, Date.now() - (deadline - waitMs))),
								delivered: delivered,
								steer: delivered ? args.steer === true : null,
								lossy: session.lossy,
								unparsedLines: session.unparsed,
								stderr: session.stderrTail || undefined,
								stdinError: session.stdinError || undefined,
								exitCode: session.exitCode,
								newMessages: observed,
								hint:
									observed.length > 0 || session.finished === true || session.resultReceived === true
										? undefined
										: session.exited === true
											? 'the child process has exited; call amp_stop to collect everything it produced.'
											: `no output yet ${String(idleMs)}ms after the last event; the process is alive. Amp's cold start is normally around 10s — call again with a larger wait_ms to keep waiting.`,
							},
							null,
							2,
						)
					},
				}),
			),
		`${PREFIX}: register amp_send_message`,
	)

	// ---- stop / collect ----
	ctx.effect(
		() =>
			tools.register(
				defineTool({
					name: 'amp_stop',
					description:
						'End a live Amp run and return everything it produced. By default stdin is closed so Amp finishes its turn and reports ' +
						'a clean result; `kill: true` terminates it instead. NOTE: unlike `interrupt_agent`, Amp has no way to stop only the ' +
						'current turn and keep the child alive — ending the run ends the child. The thread stays unarchived for audit, but ' +
						'a later run does NOT resume it (non-interactive thread continuation is unavailable), so continue from the artifact: ' +
						'read the recorded stream and start a new run with what it needs.',
					parameters: {
						run: { type: 'string', required: true, description: 'Run handle returned by amp_run.' },
						kill: { type: 'boolean', description: 'true = terminate the process instead of letting it finish cleanly.' },
					},
					output: {
						schema: { type: 'string' },
						render(_args, value) {
							return [{ type: 'text', text: String(value) }]
						},
					},
					async execute(args, exec) {
						const session = requireSession(exec.agent, args.run)
						await finish(session, args.kill === true)
						const result = session.result
						const failed = result !== undefined && result.is_error === true
						const body =
							result !== undefined && typeof result.result === 'string' && result.result !== ''
								? sanitize(result.result)
								: session.lastText
						const diagnostic = [
							`mode=${session.mode}`,
							// Attribution first: an unattributed failure banner is noise for both the
							// agent and the user, so every terminal report names the account it used.
							session.accountRef === undefined ? undefined : `account=${session.accountRef}`,
							`writes=${String(session.writes)}`,
							session.threadId === undefined ? 'thread=unknown' : `thread=${session.threadId}`,
							result === undefined ? 'no result message' : `subtype=${String(result.subtype)}`,
							result !== undefined && typeof result.num_turns === 'number' ? `numTurns=${String(result.num_turns)}` : undefined,
							failed && typeof result.error === 'string' ? `error=${sanitize(result.error)}` : undefined,
							session.failure === undefined
								? undefined
								: describeFailure(session.failure.kind, session.failure.retryAfterMs),
							// Name the spill file or admit the gap — never promise recovery without a path.
							session.lossy
								? session.spillPath === undefined
									? 'stdout=TRUNCATED(early bytes are NOT recoverable)'
									: `stdout=TRUNCATED(full stream at ${session.spillPath})`
								: undefined,
							session.quiescenceUnproven === true
								? 'quiescence=UNPROVEN(the managed range never reported empty; an orphan may survive)'
								: undefined,
							session.exited === true && session.exitCode !== undefined ? `exitCode=${String(session.exitCode)}` : undefined,
							session.exitError === undefined ? undefined : `exitError=${session.exitError}`,
							session.stdinError === undefined ? undefined : `stdinError=${session.stdinError}`,
							session.settleError === undefined ? undefined : `settleError=${session.settleError}`,
							session.unparsed === 0 ? undefined : `unparsedLines=${String(session.unparsed)}`,
							session.artifactPath === undefined ? undefined : `artifact=${session.artifactPath}`,
							session.artifactError === undefined ? undefined : `artifactError=${session.artifactError}`,
							session.stderrTail === '' ? undefined : `stderr=${session.stderrTail}`,
						]
							.filter((part) => part !== undefined)
							.join(' ')
						sessions.delete(session.id)
						return JSON.stringify(
							{
								run: session.id,
								// Projected from the ONE outcome: a killed run is `aborted` because it was killed,
								// not because this particular call happened to pass kill:true.
								stopReason:
									(session.outcome ?? terminalOutcome(session)).status === 'completed'
										? 'completed'
										: (session.outcome ?? terminalOutcome(session)).status === 'killed'
											? 'aborted'
											: 'error',
								diagnostic,
								output: body,
								artifact: session.artifactPath,
								artifactError: session.artifactError,
								artifactWriteError: session.artifactWriteError,
							},
							null,
							2,
						)
					},
				}),
			),
		`${PREFIX}: register amp_stop`,
	)

	// ---- accounts / balances ----
	ctx.effect(
		() =>
			tools.register(
				defineTool({
					name: 'amp_accounts',
					description:
						'List the configured Amp accounts with their balances. By default this reads the LOCAL ledger: no network, no credits, instant. ' +
						'Pass refresh:true to re-probe with `amp usage` — still no credits and no agent, but one round trip per account. ' +
						'An account whose balance is spent is skipped when a run is dispatched, so this is also how to see why a run landed where it did, ' +
						'and how to notice that every account is about to run dry.',
					parameters: {
						refresh: { type: 'boolean', description: 'true = ignore the reading cache and re-probe now.' },
						preview: {
							type: 'boolean',
							description:
								'true = also report which account a run of each mode WOULD take, and why (the pool decides; this never claims the account). Costs no network by itself.',
						},
						limit: {
							type: 'number',
							description:
								'How many accounts to list, in configuration order (default 12; 0 = all). The ledger path is instant; with refresh:true each shown account costs one `amp usage` round trip (~3.4s measured), so refreshing every account is slow — ask for the slice you need.',
						},
					},
					output: {
						schema: { type: 'string' },
						render(_args, value) {
							return [{ type: 'text', text: String(value) }]
						},
					},
					async execute(args) {
						const pool = ctx.get('ampAccounts')
						if (pool === undefined || typeof pool.list !== 'function') {
							throw new Error(
								`${PREFIX}: the ampAccounts service is not mounted, so balances cannot be read. The host row (dsh-amp) provides it.`,
							)
						}
						const limit =
							typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit >= 0 ? Math.floor(args.limit) : 12
						// Ledger-first: this reads local records only, so it is instant. The
						// `refresh` flag is the one path that spends an `amp usage` round trip
						// per shown account.
						// `limit` is passed ALWAYS, including 0: `pool.list` reads an explicit 0 as
						// "every account", while an absent field means its 12-row default. Omitting a
						// caller's 0 therefore turned the documented "0 = all" into "0 = 12".
						const reading = await pool.list({ limit, refresh: args.refresh === true })
						// Opt-in preview: "why did my run land on that account" is the question this tool
						// kept being asked to answer by hand. It calls the pool's SELECTION, never
						// `choose()`, so asking never claims the account it reports on.
						let next
						if (args.preview === true && typeof pool.preview === 'function') {
							next = {}
							for (const mode of resolved.modes) {
								try {
									// `probe: false`: a preview answers from the ledger, so it really costs no network.
									const picked = await pool.preview({ mode, probe: false })
									if (picked !== undefined && picked !== null) {
										next[mode] = {
											ref: picked.ref,
											state: picked.state,
											remaining: picked.remaining,
											detail: picked.detail,
										}
									}
								} catch (error) {
									next[mode] = { error: sanitize(String(error?.message ?? error)) }
								}
							}
						}
						return JSON.stringify(
							{
								accountsTotal: reading.total,
								accountsShown: reading.shown,
								source: pool.source,
								note:
									reading.shown < reading.total
										? `showing the first ${String(reading.shown)} of ${String(reading.total)}; pass a larger limit, or 0 for all`
										: undefined,
								accounts: reading.rows,
								// Which account each mode WOULD use, and the pool's own reason. Not a claim.
								next,
							},
							null,
							2,
						)
					},
				}),
			),
		`${PREFIX}: register amp_accounts`,
	)

	// ---- rescue: what did previous runs leave behind? ----
	//
	// The artifact only earns its keep if someone can FIND it. After a crash, a restart, or a
	// killed run, the session map starts empty and the run id is gone — so the disk is the only
	// witness, and this is the one tool that reads it. No agent is started, nothing is spent.
	ctx.effect(
		() =>
			tools.register(
				defineTool({
					name: 'amp_runs',
					description:
						'List Amp runs that left an artifact on disk, newest first, each with its last checkpoint and file paths. ' +
						'Use it after a crash, a restart, or a killed run to recover work: the artifact is the append-only record and ' +
						'is a best-effort durable record: it survives most endings and reports `durability=partial` when it cannot. Starts no agent and spends nothing.',
					parameters: {
						limit: { type: 'number', description: 'How many runs to show (default 5, newest first; 0 = all).' },
					},
					output: {
						schema: { type: 'string' },
						render(_args, value) {
							return [{ type: 'text', text: String(value) }]
						},
					},
					async execute(args) {
						// Every artifact key carries the epoch it was opened at, with a pid and a uuid
						// after it so two hosts cannot collide on one key. The epoch is therefore
						// FOUND, not assumed to be the last segment: reading the trailing field
						// returned the uuid slice, which is not a number, and every ordering decision
						// silently collapsed to 0 — `limit: 1` then picked an arbitrary run.
						const epochOf = (id) => {
							const match = /(?:^|-)(\d{13})(?:-|$)/u.exec(String(id))
							return match === null ? 0 : Number(match[1])
						}
						/**
						 * Newest first, DETERMINISTICALLY. The epoch alone cannot order two hosts that
						 * opened a run in the same millisecond (the key carries pid+uuid for uniqueness,
						 * not for time), so the recorded start time is the primary fact, the directory
						 * mtime the secondary, and the key the final tie-break. Without this, `limit: 1`
						 * returned whatever the lexical sort happened to leave last.
						 */
						const mtimeOf = (id) => stats.get(id) ?? 0
						const detailed = typeof artifacts.listDetailed === 'function' ? artifacts.listDetailed() : undefined
						const stats = new Map(
							Array.isArray(detailed) ? detailed.map((row) => [row.name, row.mtimeMs]) : [],
						)
						const listed = Array.isArray(detailed) ? detailed.map((row) => row.name) : artifacts.list()
						if (Array.isArray(listed) !== true) {
							// Spreading a failure object threw a secondary TypeError and buried the cause.
							// The store's own error is what the rescuer needs; the runs are still on disk.
							throw new Error(
								`${PREFIX}: the run index could not be listed — ${String(listed?.error ?? 'unknown error')}`,
							)
						}
						const ordered = [...listed].sort(
							(a, b) => epochOf(a) - epochOf(b) || mtimeOf(a) - mtimeOf(b) || String(a).localeCompare(String(b)),
						)
						const limit =
							typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit >= 0 ? Math.floor(args.limit) : 5
						const shown = limit === 0 ? ordered : ordered.slice(-limit)
						// Which runs does THIS process still own? Anything else on disk was left by a
						// previous process, and a live run cannot outlive its host. What the predicate
						// PROVES is narrower than that story: "not live in THIS process, and its checkpoint
						// does not say finished". A second host sharing this DSH_HOME would match it too,
						// so treat it as a rescue hint rather than proof of who ended the run.
						const liveKeys = new Set()
						for (const session of sessions.values()) {
							if (typeof session.artifactKey === 'string') liveKeys.add(session.artifactKey)
						}
						const runs = shown.reverse().map((id) => {
							const raw = artifacts.readCheckpoint(id)
							// A corrupt or unreadable checkpoint is NOT "ok", and it does NOT prove the run was
							// interrupted: it is UNKNOWN. Reporting either as fact hides the cause from the
							// person recovering the work.
							const broken = raw !== undefined && raw.ok === false
							const checkpoint = broken ? undefined : raw
							const paths = artifacts.pathOf(id)
							const live = liveKeys.has(String(id))
							const interrupted = live !== true && broken !== true && checkpoint?.finished !== true
							// "no checkpoint yet" and "the checkpoint cannot be read" are different facts.
							// Reporting both as absence would hide a corrupt file from whoever is recovering.
							const checkState = broken
								? 'unreadable'
								: checkpoint !== undefined
									? 'ok'
									: paths.ok === false || existsSync(paths.checkpointPath) === false
										? 'missing'
										: 'unreadable'
							return {
								runId: String(id),
								checkpoint: checkState,
								// The store reports only the underlying error detail, so name the operation here:
								// "Unexpected token" alone does not tell a rescuer which file to look at.
								checkpointError: broken ? `read checkpoint failed: ${String(raw.error)}` : undefined,
								liveInThisProcess: live,
								interrupted: interrupted ? true : undefined,
								// Enough for a human or a fresh agent to pick the work up without asking
								// anyone: the raw stream, the checkpoint, and the thread it belongs to.
								resumeHint: broken
									? 'the checkpoint cannot be read, so whether this run ended is UNKNOWN; read the stream itself before deciding'
									: interrupted
										? 'the host ended while this ran; read the artifact, then start a new run for the remaining work'
										: undefined,
								terminated: checkpoint === undefined ? undefined : checkpoint.finished === true,
								mode: checkpoint?.mode,
								account: checkpoint?.account,
								threadId: checkpoint?.threadId,
								failure: checkpoint?.failure ?? undefined,
								lossy: checkpoint?.lossy === true ? true : undefined,
								artifactPath: paths.ok === false ? undefined : paths.streamPath,
								lastText: typeof checkpoint?.lastText === 'string' ? clip(checkpoint.lastText, 200) : undefined,
							}
						})
						return JSON.stringify({ root: artifacts.root, total: ordered.length, shown: runs.length, runs }, null, 2)
					},
				}),
			),
		`${PREFIX}: register amp_runs`,
	)

	// ---- leak guard: close runs nobody comes back for ----
	if (timer !== undefined && typeof timer.interval === 'function') {
		ctx.effect(
			() =>
				timer.interval(() => {
					// Read PER TICK, not once at mount: a local copy meant the settings page offered an
					// idle-timeout field that silently did nothing (the reviewer caught the doc claiming
					// otherwise). `resolved` is mutated in place by the settings subscription.
					const idleTimeoutMs =
						typeof resolved.liveIdleTimeoutMs === 'number' && resolved.liveIdleTimeoutMs > 0
							? resolved.liveIdleTimeoutMs
							: DEFAULT_IDLE_TIMEOUT_MS
					const now = Date.now()
					for (const [id, session] of sessions) {
						if (session.settling) continue
						// The sweeper is ALSO the background observer the settlement policy needs. Without
						// this, `end_turn` is only noticed when somebody happens to read the stream, so a
						// run nobody polls never looks finished and never gets closed — the notification
						// then waits for a reader that, by definition, is not coming.
						if (session.finished !== true) absorb(session)
						if (session.finished) {
							// A collected run stays answerable for `amp_stop` for one idle
							// window, then is released: otherwise every finished run leaks
							// its handle and transcript for the life of the process.
							if (session.closedAt !== undefined && now - session.closedAt >= idleTimeoutMs) {
								sessions.delete(id)
								ctx.logger?.info?.(`${PREFIX}: released collected live run ${id}`)
							}
							continue
						}
						if (now - session.lastActivityAt < idleTimeoutMs) continue
						ctx.logger?.info?.(`${PREFIX}: closing idle live run ${session.id} after ${String(idleTimeoutMs)}ms`)
						void finish(session, false)
					}
				}, SWEEP_INTERVAL_MS),
			`${PREFIX}: live-session idle sweep`,
		)
	}

	ctx.logger?.info?.(`${PREFIX}: live-session tools registered (amp_run, amp_send_message, amp_stop)`)
}
