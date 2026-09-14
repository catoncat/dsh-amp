/**
 * dsh-amp — the local Amp CLI as an out-of-process subagent provider.
 *
 * One provider instance per Amp mode (`amp-low` … `amp-ultra`), matching the
 * product-provider convention the shipped preset already uses for codex and
 * claude-code: a host-plane provider row plus a separate agent-plane
 * `dsh-tool-subagent` row naming it. A preset exposes `subagent_amp_high`, and
 * the model picks the mode by picking the tool.
 *
 * Why the CLI and not `@ampcode/sdk`: the SDK is a thin wrapper that spawns the
 * CLI with `--execute --stream-json`, so speaking that protocol directly over
 * `ctx.subprocess` gives the same behaviour plus the seam's own guarantees —
 * ambient credentials are scrubbed before our explicit `AMP_API_KEY` merge, and
 * the managed process range is torn down to real quiescence.
 *
 * The account token always comes from a DSH credential ref. It is NEVER read
 * from the ambient environment, because with no `AMP_API_KEY` in the child
 * environment the Amp CLI does not fail — it silently authenticates as whatever
 * account this machine ran `amp login` for. A pool entry that fails to resolve
 * would otherwise run the task on the wrong account with no error at all, so a
 * missing token rejects `start()` before anything is spawned.
 *
 * Scope: single account, honest failures, no failover. Rotation, health state
 * and checkpoint handoff are deliberately not implemented here.
 */
import {
	NO_START_CAPABILITIES,
	resolveChildCwd,
	settleRunResult,
	subprocessRunHandle,
	validateConfiguredCwd,
} from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { createAccountPool } from './accounts.js'
import { createLedger, defaultLedgerPath } from './ledger.js'
import { classifyAmpError, describeFailure } from './outcome.js'
import { describePackageDrift, describeSource } from './source.js'
import { registerAccountRoutes } from './web.js'

export const name = 'dsh-amp'
export const inject = ['subagents', 'subprocess', 'credentials']

const PREFIX = 'dsh-amp'
const ACCOUNT_SERVICE = 'ampAccounts'
/** Resolved-config subscription for the agent-plane row (see the provider below). */
export const SETTINGS_SERVICE = 'ampSettings'
/**
 * The copy actually loaded, not the one on disk that was edited. The profile installs
 * this bundle as a real copy of a `file:` dependency; without this, a restart silently
 * keeps serving the previous build. Surfaced through `amp_accounts`, which is free.
 */
const MODULE_FILES = ['./accounts.js', './artifact.js', './client.js', './ledger.js', './outcome.js', './source.js', './web.js']
export const SOURCE = {
	...describeSource(import.meta.url),
	// Per-file hashes of the modules THIS process loaded. One entry hash cannot prove that a
	// change to accounts.js is live — a gap that already cost a wrong "it is deployed" claim.
	modules: Object.fromEntries(MODULE_FILES.map((rel) => [rel.slice(2), describeSource(new URL(rel, import.meta.url).href).hash])),
}
const BUILTIN_MODES = ['low', 'medium', 'high', 'ultra']
const DEFAULT_ACCOUNT_REF = 'AMP_API_KEY_1'
const DEFAULT_AMP_BIN = 'amp'

/**
 * The user-writable surface. The credentials service cannot enumerate its refs —
 * it documents that "the reference half has no enumeration because configuration
 * surfaces learn which references exist from settings schemas" — so this schema is
 * the only place the account list can come from. Putting it here is also what makes
 * the pool configurable from the settings UI instead of by editing YAML.
 */
export const SETTINGS_NAMESPACE = 'dsh-amp'
export const DshAmpSettingsSchema = z.object({
	accountRefs: z.array(z.string()).default([DEFAULT_ACCOUNT_REF]),
	modes: z.array(z.string()).default([...BUILTIN_MODES]),
	ampBin: z.string().default(DEFAULT_AMP_BIN),
	visibility: z.string().default('private'),
	keepThreads: z.boolean().default(true),
	liveIdleTimeoutMs: z.number().default(20 * 60 * 1000),
})

/** A bounded wait signal, or `undefined` on a runtime that lacks the helper. */
function settleSignal(ms) {
	return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined
}

const STDIN_MAX_BYTES = 1024 * 1024
const STDOUT_MAX_BYTES = 4 * 1024 * 1024
const STDOUT_SPILL_BYTES = 16 * 1024 * 1024
const STDERR_MAX_BYTES = 256 * 1024
const DIAGNOSTIC_MAX_CHARS = 600

/** Replace anything token-shaped before text can reach a transcript or a log. */
function sanitize(value) {
	if (typeof value !== 'string') return ''
	return value.replace(/sgamp_[A-Za-z0-9_-]+/gu, 'sgamp_<redacted>')
}

function truncate(value, limit) {
	const text = sanitize(value)
	return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Parse Amp's `--stream-json` output: one JSON object per line. */
function parseStreamJson(text) {
	const messages = []
	const unparsed = []
	for (const raw of String(text ?? '').split('\n')) {
		const line = raw.trim()
		if (line === '') continue
		if (line[0] !== '{') {
			unparsed.push(line.slice(0, 160))
			continue
		}
		try {
			messages.push(JSON.parse(line))
		} catch {
			unparsed.push(line.slice(0, 160))
		}
	}
	return { messages, unparsed }
}

/**
 * Fold the stream into the three facts the provider needs: the thread id, the
 * final assistant text, and — when the run failed — a safe diagnostic.
 *
 * Amp reports failure on two independent channels, and a classifier that knows
 * only one of them will miss real failures:
 *   * `type: 'result'` with `is_error: true` for agent-level failures
 *     (`error_during_execution`, `error_max_turns`);
 *   * a non-zero process exit with the CLI's own message on stderr, which
 *     `handle.done` reports as an exit code rather than as a result message.
 */
function foldStream(messages, unparsed) {
	let threadId
	let agentMode
	let finalText = ''
	let result
	let systemError
	for (const message of messages) {
		if (message === null || typeof message !== 'object') continue
		if (message.type === 'system' && message.subtype === 'init') {
			if (typeof message.session_id === 'string') threadId = message.session_id
			if (typeof message.agent_mode === 'string') agentMode = message.agent_mode
		}
		if (message.type === 'system' && message.subtype !== 'init' && typeof message.error === 'string') {
			systemError = message.error
		}
		if (message.type === 'assistant' && message.message !== undefined && Array.isArray(message.message.content)) {
			// Concatenate this message's own text blocks, then keep the message only
			// when it actually carried text. Overwriting per block would leave the
			// last BLOCK of the last message rather than the last message with content.
			const parts = []
			for (const block of message.message.content) {
				if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
					parts.push(block.text)
				}
			}
			if (parts.length > 0) finalText = parts.join('\n')
		}
		if (message.type === 'result') result = message
	}
	return { threadId, agentMode, finalText, result, systemError, unparsed }
}

function collect(handle, stream) {
	const reader = handle.collected?.[stream]
	if (reader === undefined) return { text: '', lossy: false, spillPath: undefined }
	const read = reader.readFrom(0)
	// `lossy` means the in-memory tail dropped bytes that the spill file still
	// holds. Ignoring it parses an incomplete stream as if it were complete.
	return { text: read.text, lossy: read.lossy === true, spillPath: read.spillPath }
}

/** The delegating parent session's workspace, or undefined when unavailable. */
function parentWorkspaceCwd(ctx, parentId) {
	const sessions = ctx.get('sessions')
	if (sessions === undefined || typeof sessions.get !== 'function') return undefined
	const session = sessions.get(parentId)
	const header = session?.header
	if (header === undefined || header === null) return undefined
	return typeof header.cwd === 'string' ? header.cwd : undefined
}

function blocksToText(blocks) {
	if (!Array.isArray(blocks)) return ''
	const parts = []
	for (const block of blocks) {
		if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
			parts.push(block.text)
		}
	}
	return parts.join('\n')
}

export function resolveConfig(config) {
	const source = config ?? {}
	// `accountRefs` is the pool. `accountRef` and the built-in default remain
	// accepted so an existing composition keeps working unchanged.
	const listed = Array.isArray(source.accountRefs) ? source.accountRefs.filter((value) => typeof value === 'string' && value !== '') : []
	const single = typeof source.accountRef === 'string' && source.accountRef !== '' ? [source.accountRef] : []
	const accountRefs = listed.length > 0 ? listed : single.length > 0 ? single : [DEFAULT_ACCOUNT_REF]
	const accountRef = accountRefs[0]
	const ampBin = typeof source.ampBin === 'string' && source.ampBin !== '' ? source.ampBin : DEFAULT_AMP_BIN
	const modes = Array.isArray(source.modes) && source.modes.length > 0 ? source.modes.map(String) : BUILTIN_MODES
	return {
		accountRef,
		accountRefs,
		ampBin,
		modes,
		// Validated once at load, exactly as the out-of-process contract asks.
		configuredCwd: validateConfiguredCwd(PREFIX, typeof source.cwd === 'string' ? source.cwd : undefined),
		visibility: typeof source.visibility === 'string' ? source.visibility : 'private',
		keepThreads: source.keepThreads !== false,
		// Idle bound for a live session nobody comes back for. The sweeper closes
		// such a run so a forgotten child cannot hold a process until restart.
		liveIdleTimeoutMs:
			typeof source.liveIdleTimeoutMs === 'number' && Number.isFinite(source.liveIdleTimeoutMs) && source.liveIdleTimeoutMs > 0
				? source.liveIdleTimeoutMs
				: undefined,
		// The seam bounds a teardown/shutdown wait, so zero, negative, or NaN would
		// skip or wedge it rather than apply a fast timeout.
		graceMs:
			typeof source.graceMs === 'number' && Number.isFinite(source.graceMs) && source.graceMs > 0 ? source.graceMs : 10_000,
	}
}

/**
 * Choose the account for one run.
 *
 * With the pool service present, selection is health-aware: every configured ref
 * is resolved and its balance read from `amp usage` (cached for a minute), and an
 * exhausted account is skipped. Without the service — or when a caller composes
 * this row alone — the first configured ref is used and an empty token still
 * refuses the run, because an unset `AMP_API_KEY` makes the Amp CLI silently
 * authenticate as whatever account this machine ran `amp login` for.
 */
async function chooseAccount(ctx, resolved, mode) {
	const pool = ctx.get(ACCOUNT_SERVICE)
	if (pool !== undefined && typeof pool.choose === 'function') return await pool.choose({ mode })

	const ref = resolved.accountRefs[0]
	const credential = await ctx.credentials.resolve(ref)
	const token = credential === undefined || typeof credential.value !== 'string' ? '' : credential.value
	if (token.trim() === '') {
		throw new Error(
			`${PREFIX}: credential ref "${ref}" is not configured (or is empty), so this run cannot start. ` +
				'Refusing to run rather than let the Amp CLI fall back to this machine\'s `amp login` account.',
		)
	}
	return { ref, token, detail: 'balance not checked', state: 'unchecked' }
}

function createProvider(ctx, getResolved, mode, counter, settingsState) {
	return {
		name: `amp-${mode}`,
		// Another process cannot honour a parent-enforced start feature, so the
		// service rejects such a request before delegating instead of accepting
		// and ignoring it.
		capabilities: NO_START_CAPABILITIES,
		// Conversation seeding, NOT workspace sharing: this field answers only
		// whether the child's conversation is seeded with the parent's completed
		// turns, and the seam documents that it "says nothing about tool,
		// service, scope, or authority inheritance".
		//
		// Amp is a separate agent that reads the same working directory and has
		// no access to this harness's conversation log, so it is a FRESH child.
		// It must be false: true selects the fork wording, which tells the model
		// the child already knows the discussion and invites a prompt like
		// "continue that refactor we discussed" — which Amp cannot resolve.
		inheritsParentContext: false,

		async start(request) {
			// Re-read configuration per start, so a settings edit (a new account, a
			// changed visibility) reaches the next run without a restart.
			const resolved = getResolved()

			// A namespace this row could not register means the settings page is editing
			// something this row does not read. Dispatching anyway would run one configuration
			// while the page shows another, so refuse until the composition is fixed.
			if (settingsState.error !== undefined) throw new Error(`${PREFIX}: ${settingsState.error}`)

			// Every check that needs no account runs BEFORE selection: a prompt we are going to
			// refuse must not consume an account claim. The claim is taken by `chooseAccount`
			// below and released by `releaseClaim` on any path that never publishes a run.
			// Amp accepts text on stdin only. Silently dropping an image or file block
			// would run a task that is missing its input, so reject instead.
			for (const block of request.prompt) {
				if (block !== null && typeof block === 'object' && block.type !== 'text') {
					throw new Error(
						`${PREFIX}: mode "${mode}" cannot forward a "${String(block.type)}" prompt block — Amp takes text only. ` +
							'Inline the content as text, or put the file where the child can read it and name the path.',
					)
				}
			}

			const prompt = blocksToText(request.prompt)
			// An empty instruction is not a task, and the seam's request type allows an empty prompt
			// array: without this the provider would claim an account, spawn, and record a dispatch
			// for a run that can only answer "No valid messages found in stdin".
			if (prompt.trim() === '') {
				throw new Error(
					`${PREFIX}: mode "${mode}" needs a non-empty prompt; refusing rather than starting a run with nothing to do.`,
				)
			}
			// A truncated prompt does not fail — it produces a plausible run based on half an
			// instruction, which is the worst kind of wrong. Refuse loudly instead (F9).
			// Bytes, not UTF-16 code units: the limit is named for bytes and the child receives UTF-8, so
			// measuring `.length` let a Chinese or emoji prompt pass the guard and arrive truncated.
			const promptBytes = Buffer.byteLength(prompt, 'utf8')
			if (promptBytes > STDIN_MAX_BYTES) {
				throw new Error(
					`the prompt is ${String(promptBytes)} bytes but this path can only deliver ${String(STDIN_MAX_BYTES)}; ` +
						'refusing rather than truncating, because a half instruction produces a confident, wrong run — ' +
						'split the task, or point the child at a file it should read',
				)
			}
			const childCwd = resolveChildCwd(PREFIX, resolved.configuredCwd, parentWorkspaceCwd(ctx, request.parent.id))

			// A per-process counter is NOT unique: this provider is re-created on every mount
			// (HMR, reload), and a run published by the previous instance outlives it — the seam
			// only stops NEW starts, it does not revoke a returned run. Two live runs of one
			// parent would then share an id. `randomUUID` is what the shipped out-of-process
			// providers use, and it is unique in the parent namespace by construction.
			counter.next += 1
			const runId = `${PREFIX}-${mode}-${randomUUID()}`

			// Account selection also runs per start. The pool reads each account's
			// balance first — `amp usage` is free and needs no agent run — so an
			// exhausted account is skipped rather than discovered afterwards by
			// parsing an error message.
			const account = await chooseAccount(ctx, resolved, mode)
			const token = account.token
			const pool = ctx.get(ACCOUNT_SERVICE)
			/**
			 * Hand the in-flight claim back. A claim is taken before a run exists, so every
			 * path that fails between the claim and the run's publication must release it;
			 * otherwise a refusal that never started a child still pushes the next dispatch
			 * off a healthy account for the whole TTL. Idempotent, and best-effort by design.
			 */
			const releaseClaim = () => {
				try {
					// The token is what makes this MY lease: in the fail-open case another live run can
					// hold the same ref, and a tokenless release would drop its claim instead.
					pool?.release?.(account.ref, account.claimToken)
				} catch {
					/* a claim is a preference; failing to drop it must not fail the caller */
				}
			}

			// Snapshot the provider exposes when cancellation or failure wins.
			const snapshot = { output: [], diagnostic: undefined, threadId: undefined, exitCode: undefined }
			const state = { cancelled: false, handle: undefined }
			const onAbort = () => {
				state.cancelled = true
				try {
					state.handle?.terminate()
				} catch {
					/* the range may already be gone */
				}
			}
			// settleRunResult and subprocessRunHandle only REMOVE this listener; their
			// implementations never add it, so registering it is the provider's job.
			// Without this line the process is still killed through the spawn spec's
			// own signal, but `cancelled()` never becomes true and the run is
			// reported as `error` instead of `aborted`.
			request.signal.addEventListener('abort', onAbort)

			try {
				const executable = await ctx.subprocess.resolveExecutable(resolved.ampBin, { AMP_API_KEY: token }, request.signal)

			const argv = [
				executable,
				'--execute',
				'--stream-json',
				'--mode',
				mode,
				'--visibility',
				resolved.visibility,
				'--no-color',
				// `--ide` is ON by default and makes the CLI attach the open editor's
				// file and text selection to every message. That leaks unrelated
				// context into a delegated task and breaks the fresh-child contract.
				'--no-ide',
			]
			// Keep the thread addressable for a later handoff or audit; without
			// this the CLI archives the thread when the run ends.
			if (resolved.keepThreads) argv.push('--no-archive-after-execute')

			const runOnce = async () => {
				// The prompt travels on stdin rather than argv: argv is visible to
				// any local process listing.
				state.handle = ctx.subprocess.spawn({
					argv,
					cwd: childCwd,
					stdio: {
						stdin: { data: prompt.slice(0, STDIN_MAX_BYTES) },
						stdout: { maxBytes: STDOUT_MAX_BYTES, spill: { maxBytes: STDOUT_SPILL_BYTES } },
						stderr: { maxBytes: STDERR_MAX_BYTES },
					},
					graceMs: resolved.graceMs,
					signal: request.signal,
					// dsh-subprocess scrubs credential-shaped ambient names and merges
					// this after the scrub, so exactly one account token reaches the
					// child and nothing else does.
					env: { AMP_API_KEY: token },
				})
				// The dispatch is recorded only once the process EXISTS: a refusal that
				// never spawned anything must not be counted as a run in the ledger.
				try {
					ctx.get(ACCOUNT_SERVICE)?.noteDispatch?.(account.ref)
				} catch {
					/* the ledger is best-effort; a run must not fail because of it */
				}

				const outcome = await state.handle.done
				const stdout = collect(state.handle, 'stdout')
				const stderr = collect(state.handle, 'stderr')
				const parsed = parseStreamJson(stdout.text)
				const folded = foldStream(parsed.messages, parsed.unparsed)
				// Exit code 0 is NOT success by itself: a run can exit cleanly while
				// emitting no result message at all, or while reporting a system-level
				// error. Require a real success result and no system error.
				const failed =
					outcome.exitCode !== 0 ||
					folded.result === undefined ||
					folded.result.is_error === true ||
					folded.systemError !== undefined

				snapshot.threadId = folded.threadId
				snapshot.exitCode = outcome.exitCode

				// What went wrong decides what the pool RECORDS. This is how the delegating agent
				// stays out of the credit business: a throttle is remembered for its own window,
				// and a credit refusal forces this ONE account's balance to be re-read.
				const errorText =
					folded.result !== undefined && typeof folded.result.error === 'string'
						? folded.result.error
						: (folded.systemError ?? '')
				const failure = errorText === '' ? undefined : classifyAmpError(errorText)
				try {
					const poolRef = ctx.get(ACCOUNT_SERVICE)
					if (failure !== undefined && failure.kind !== 'other' && typeof poolRef?.noteRefusal === 'function') {
						void poolRef.noteRefusal(account.ref, failure, account.claimToken).catch?.(() => {})
					} else if (typeof poolRef?.refresh === 'function') {
						// One remote confirmation for the account that just ran, fired without being
						// awaited: ~3.4s is unobservable here and must never delay the caller.
						void poolRef.refresh(account.ref, account.claimToken).catch(() => {})
					}
				} catch {
					/* accounting is best-effort */
				}

				if (!failed) {
					const text = typeof folded.result.result === 'string' ? folded.result.result : folded.finalText
					snapshot.output = [{ type: 'text', text: sanitize(text) }]
					snapshot.diagnostic = folded.threadId === undefined ? undefined : `Amp thread ${folded.threadId}`
					return { output: snapshot.output, stopReason: 'completed' }
				}

				const detail = [
					`mode=${mode}`,
					`account=${account.ref}`,
					account.detail === undefined ? undefined : `(${account.detail})`,
					`exitCode=${String(outcome.exitCode)}`,
					folded.threadId === undefined ? 'thread=unknown' : `thread=${folded.threadId}`,
					folded.result === undefined ? 'no result message' : undefined,
					folded.result?.subtype === undefined ? undefined : `subtype=${String(folded.result.subtype)}`,
					// Every piece that can carry process output is BOUNDED and SANITIZED here.
					// `truncate` redacts token-shaped literals, and the failure block below
					// embeds this same `detail`, so an unsanitized piece reaches the model.
					typeof folded.result?.error === 'string' ? `error=${truncate(folded.result.error, 600)}` : undefined,
					failure === undefined ? undefined : describeFailure(failure.kind, failure.retryAfterMs),
					folded.systemError === undefined ? undefined : `system=${truncate(folded.systemError, 600)}`,
					folded.unparsed.length === 0 ? undefined : `unparsedLines=${String(folded.unparsed.length)}`,
					// Claiming a spill file exists without naming it is worse than admitting the gap: the
					// caller cannot recover bytes it cannot find.
					stdout.lossy === true
						? stdout.spillPath === undefined
							? 'stdout=TRUNCATED(early bytes are NOT recoverable; raise the stdout budget or split the task)'
							: `stdout=TRUNCATED(full stream at ${stdout.spillPath})`
						: undefined,
					stderr.text.trim() === '' ? undefined : `stderr=${truncate(stderr.text.trim(), 2000)}`,
				]
					.filter((part) => part !== undefined)
					.join(' ')

				// Preserve what the child actually produced. Overwriting `output` with
				// the diagnostic alone discards the work entirely, which is the failure
				// mode that makes a delegated run worthless.
				const blocks = []
				if (folded.finalText.trim() !== '') {
					// Efficiency over redaction: the delegating agent needs what the child
					// actually produced in order to decide the next move, so the partial
					// output is passed through nearly whole. The only thing stripped
					// anywhere in this file is the account token literal, and that is for
					// efficiency rather than hygiene: leaking a live credential forces a
					// rotation, which costs far more than the characters it saves.
					blocks.push({
						type: 'text',
						text: `Partial output from Amp before the run failed:\n${truncate(folded.finalText, 20_000)}`,
					})
				}
				blocks.push({
					type: 'text',
					text:
						`Amp run failed. ${truncate(detail, 4000)}\n` +
						(folded.threadId === undefined
							? 'No Amp thread id was observed, so the full transcript may not be recoverable for this run.'
							: `The full transcript is in Amp thread ${folded.threadId} (kept unarchived); read it before retrying so the work is not repeated.`),
				})
				snapshot.output = blocks
				snapshot.diagnostic = truncate(detail, DIAGNOSTIC_MAX_CHARS)
				return { output: blocks, diagnostic: snapshot.diagnostic, stopReason: 'error' }
			}

			/**
			 * The seam contract's attempt: the account is in flight only until the run
			 * ENDS. Every ending — a success, a classified failure, or a throw the seam
			 * flattens to `error` — releases the claim here, so an unclassified failure
			 * cannot hold a healthy account for the 30-minute TTL.
			 */
			const attempt = async () => {
				try {
					return await runOnce()
				} finally {
					releaseClaim()
				}
			}

			return subprocessRunHandle({
				id: runId,
				result: settleRunResult({
					attempt,
					collectOutput: () => snapshot.output,
					collectDiagnostic: () => snapshot.diagnostic,
					cancelled: () => state.cancelled,
					signal: request.signal,
					onAbort,
					// Without this sink a thrown attempt collapses to
					// { output: [], stopReason: 'error' } with no cause at all.
					onError: (error) => {
						snapshot.diagnostic = truncate(`${PREFIX}: ${error.message}`, DIAGNOSTIC_MAX_CHARS)
					},
				}),
				signal: request.signal,
				onAbort,
				requestCancel: () => {
					state.cancelled = true
				},
				teardown: async () => {
					const handle = state.handle
					if (handle === undefined) return
					try {
						handle.terminate()
					} catch {
						/* already terminated */
					}
					// The seam contract is "awaits the backend's teardown to actual exit", and
					// `waitForExit()` only returns when it can PROVE the managed range is empty.
					// Swallowing its rejection would make `dispose()` resolve while an orphan may
					// still be alive; calling it WITHOUT a bound is the other half of the same bug —
					// a descendant holding an inherited descriptor keeps the range non-empty, and
					// `dispose()` would then never resolve at all. The bound is the same grace the
					// spawn spec uses for termination, and the seam reports an expired bound as
					// `false`: unproven quiescence, which is what the caller must hear.
					const quiet = await handle.waitForExit(settleSignal(resolved.graceMs))
					if (quiet !== true) {
						throw new Error(
							`${PREFIX}: the child's process range could not be confirmed empty within ${String(resolved.graceMs)}ms; ` +
								'quiescence is UNPROVEN, so treat an orphan as possibly still alive',
						)
					}
				},
			})
			} catch (error) {
				// Nothing was published: no run handle exists, so no caller can dispose it, and
				// the seam requires the provider to clean every unpublished resource itself.
				releaseClaim()
				// `settleRunResult` removes this listener on every path it reaches; this path
				// does not reach it, and leaving the listener attached to the request signal
				// leaks one closure per refused start.
				request.signal.removeEventListener('abort', onAbort)
				throw error
			}
		},
	}
}

export function apply(ctx, config) {
	const compositionConfig = config ?? {}
	// Mutable so a settings edit takes effect on the next run without a restart.
	const holder = { value: resolveConfig(compositionConfig) }
	/**
	 * Set when the settings namespace could NOT be registered. Every dispatch surface reads it
	 * and refuses, because the alternative is running one configuration while the page that
	 * was supposed to own it edits another.
	 */
	const settingsState = { error: undefined }
	/**
	 * The authoritative reader for every dispatch. Replaced by a scope-backed reader once the
	 * settings namespace is registered; until then the composition value is the only truth.
	 */
	let currentResolved = () => holder.value
	// The ledger answers selection; `amp usage` is demoted to confirming the one
	// account a run just used. See lib/ledger.js for why that split matters.
	const ledger = createLedger(defaultLedgerPath(), ctx.logger)
	const pool = createAccountPool(ctx, () => currentResolved(), ledger)
	// The account surface is the free one, so it is where "which build answered this"
	// belongs: open the settings view or call amp_accounts and the hash is right there.
	const drift = describePackageDrift(SOURCE.file)
	pool.source = {
		...SOURCE,
		drift: drift.status,
		driftChanged: drift.changed.length === 0 ? undefined : drift.changed,
		driftAdded: drift.added.length === 0 ? undefined : drift.added,
	}
	ctx.effect(() => ctx.provide(ACCOUNT_SERVICE, pool), `${PREFIX}: provide the ${ACCOUNT_SERVICE} service`)

	// The browser half reads balances from here; it cannot use the settings RPC, which
	// speaks only the settings document.
	registerAccountRoutes(ctx, pool)

	// The settings namespace is the user-writable layer over this row's config:
	// schema defaults, then `base` (the composition config), then the user's edits.
	// It is registered HERE, on the host-plane row, so the agent-plane live-tools
	// row reads the same resolved value instead of keeping its own copy — a
	// namespace may only be registered once.
	ctx.inject(['settings'], (settingsCtx) => {
		let scope
		try {
			scope = settingsCtx.settings.register(SETTINGS_NAMESPACE, DshAmpSettingsSchema, { base: compositionConfig })
		} catch (error) {
			// FAIL LOUD, and stop dispatching. Swallowing this left two live truths: the
			// settings page kept rendering and saving the `dsh-amp` namespace (the client half
			// writes it unconditionally), while this row dispatched from the composition value
			// the page had never reached. A warning in a log nobody reads is not a disclosure.
			const detail =
				`the "${SETTINGS_NAMESPACE}" settings namespace could not be registered ` +
				`(${String(error?.message ?? error)}); refusing to dispatch, because a page edit would not reach the ` +
				'configuration a run actually uses. Fix the namespace conflict (or the stored section the schema rejected).'
			settingsState.error = detail
			pool.settingsError = detail
			ctx.logger?.error?.(`${PREFIX}: ${detail}`)
			return
		}
		settingsState.error = undefined
		pool.settingsError = undefined
		holder.value = resolveConfig({ ...compositionConfig, ...scope.get() })
		/**
		 * The AUTHORITATIVE value, read from the scope itself.
		 *
		 * `scope.get()` is the committed snapshot; `watch()` is explicitly an asynchronous
		 * observer, so a value mirrored in a callback is stale for the whole window between a
		 * commit and the callback running. Reading the scope per operation removes that window
		 * instead of narrowing it.
		 */
		const authoritative = () => {
			try {
				return resolveConfig({ ...compositionConfig, ...scope.get() })
			} catch {
				return holder.value
			}
		}
		currentResolved = authoritative
		// The agent-plane row cannot register the namespace again, and `settings.get()` hands back a
		// VALUE, not a scope — so the scope owner is the one that must expose the subscription.
		// Without it the live tools keep whatever config existed when they mounted.
		settingsCtx.effect(
			() =>
				settingsCtx.provide(SETTINGS_SERVICE, {
					current: authoritative,
					// The delivered `next` is the committed value; reading the mirror instead would
					// re-introduce the ordering dependency this service exists to remove.
					subscribe: (listener) =>
						scope.watch((next) => {
							const resolvedNext = resolveConfig({ ...compositionConfig, ...next })
							holder.value = resolvedNext
							listener(resolvedNext)
						}),
				}),
			`${PREFIX}: provide the resolved-config subscription`,
		)
		settingsCtx.effect(
			() =>
				scope.watch((next) => {
					holder.value = resolveConfig({ ...compositionConfig, ...next })
					ctx.logger?.info?.(
						`${PREFIX}: settings changed — accounts [${holder.value.accountRefs.join(', ')}], visibility ${holder.value.visibility}`,
					)
				}),
			`${PREFIX}: settings watcher`,
		)
	})

	const counter = { next: 0 }

	// The mode list is fixed at mount: each mode is one registered provider, and
	// re-registering on a settings change would need a remount. Changing modes
	// therefore takes a restart; changing accounts does not.
	for (const mode of holder.value.modes) {
		ctx.effect(
			() => ctx.subagents.registerProvider(createProvider(ctx, () => currentResolved(), mode, counter, settingsState)),
			`${PREFIX}: register the amp-${mode} subagent provider`,
		)
	}

	// The steerable path is deliberately NOT a subagent provider: `SubagentRun`
	// settles once, and Amp emits no per-turn `result` in stream-json-input mode.
	// It is registered from its own AGENT-plane row (`dsh-amp/live`) instead, so
	// its tools stay scoped to the preset that grants them. See lib/live.js.

	ctx.logger?.info?.(
		`${PREFIX}: registered ${holder.value.modes.map((mode) => `amp-${mode}`).join(', ')} from "${holder.value.ampBin}" ` +
			`using accounts [${holder.value.accountRefs.join(', ')}] (visibility ${holder.value.visibility}, ` +
			`keepThreads ${String(holder.value.keepThreads)}) [source ${SOURCE.hash} ${SOURCE.file}]`,
	)
}
