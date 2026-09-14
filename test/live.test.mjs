/**
 * dsh-amp live-tool behavioural tests.
 *
 * These drive the REAL registered tools (amp_run / amp_send_message / amp_stop)
 * through `registerLiveTools`, with a fake ctx and a fake subprocess handle. What is
 * faked is the DSH seam, not the plugin: every assertion below exercises plugin code.
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// Artifacts must never land in the real state dir while a test is running.
process.env.DSH_HOME = process.env.DSH_HOME ?? '/tmp/dsh-amp-live-test-home'

const { registerLiveTools } = await import('../lib/live.js')
const { createArtifactStore } = await import('../lib/artifact.js')

class FakeStdin {
	constructor() {
		this.writes = []
		this.ended = false
		this.listeners = new Map()
		this.errorOnWrite = null
	}
	write(chunk) {
		if (this.errorOnWrite !== null) throw this.errorOnWrite
		this.writes.push(chunk)
		return true
	}
	end() {
		this.ended = true
	}
	on(event, fn) {
		if (!this.listeners.has(event)) this.listeners.set(event, [])
		this.listeners.get(event).push(fn)
		return this
	}
}

function byteReader() {
	let text = ''
	return {
		push(chunk) {
			text += chunk
		},
		readFrom(offset) {
			return { text: text.slice(offset), nextOffset: text.length, lossy: false }
		},
	}
}

function makeHandle() {
	const stdout = byteReader()
	const stderr = byteReader()
	const stdin = new FakeStdin()
	let settle
	const done = new Promise((resolve) => {
		settle = resolve
	})
	const handle = {
		stdin,
		stdout,
		stderr,
		done,
		collected: { stdout, stderr },
		terminated: false,
		waitCalls: 0,
		waitBehavior: null,
		settleFromChild: (value) => settle(value),
		// The real ordering: the managed range empties BEFORE `done` reports the exit code.
		settleFromChildSoon: (value, ms) => setTimeout(() => settle(value), ms),
		waitForExit() {
			handle.waitCalls += 1
			if (handle.waitBehavior !== null) return handle.waitBehavior()
			return Promise.resolve(true)
		},
		terminate() {
			handle.terminated = true
		},
	}
	return handle
}

function makeCtx(handle, options = {}) {
	const tools = new Map()
	const registered = []
	/**
	 * Stand-in for `ctx.jobs`. It emulates the two contractual facts this plugin depends on:
	 * `start()` calls `run()` once and returns an id, and the hooks it receives are the only
	 * channel through which the platform can cancel, read, or await the job.
	 */
	const sweeps = []
	const warnings = []
	const spawns = []
	const events = []
	const disposers = []
	const jobs = {
		specs: [],
		hooks: undefined,
		failAdmission: options.failAdmission === true,
		start(spec) {
			if (this.failAdmission === true) throw new Error('per-owner job limit reached')
			this.specs.push(spec)
			// Faithful to the registry: preflight first, and only then `run()`, which is where
			// the producer creates its execution resources.
			this.hooks = spec.run()
			return `amp-live-${this.specs.length}`
		},
	}
	const ctx = {
		logger: { info() {}, warn: (message) => warnings.push(message), error: (message) => warnings.push(message) },
		// Returns the disposer's own return value so a test can await settlement, which the
		// real scope does and the previous fake silently dropped.
		effect(fn) {
			const dispose = fn()
			const disposer = () => {
				try {
					return dispose?.()
				} catch {
					return undefined
				}
			}
			disposers.push(disposer)
			return disposer
		},
		on(event, fn) {
			events.push({ event, fn })
		},
		get(name) {
			if (name === 'tools') {
				return {
					register(tool) {
						registered.push(tool)
						tools.set(tool.name, tool)
						return () => {}
					},
				}
			}
			if (name === 'timer') {
				// `noTimer` models a host without the timer service: no observer, no reaper.
				if (options.noTimer === true) return undefined
				return {
					timeout: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
					// Captured so a test can RUN the sweep instead of waiting for a real interval.
					interval: (fn) => {
						sweeps.push(fn)
						return () => {}
					},
				}
			}
			if (name === 'ampAccounts') return options.pool
			if (name === 'jobs') return options.noJobs === true ? undefined : jobs
			return undefined
		},
		credentials: { async resolve() { return { value: 'sgamp_TESTTOKEN' } } },
		subprocess: {
			async resolveExecutable(bin) { return bin },
			spawn(spec) {
				spawns.push(spec)
				return handle
			},
		},
	}
	registerLiveTools(ctx, {
		modes: ['low', 'medium'],
		ampBin: 'amp',
		visibility: 'private',
		keepThreads: true,
		graceMs: 1000,
		accountRefs: ['AMP_API_KEY_1'],
		liveIdleTimeoutMs: options.idleTimeoutMs ?? 60_000,
		configuredCwd: '/tmp',
	})
	/** Deliver a host event (e.g. `agent/inbox/claimed`) to every registered listener. */
	const emit = (event, payload) => {
		for (const entry of events) if (entry.event === event) entry.fn(payload)
	}
	return { tools, registered, jobs, sweeps, warnings, spawns, emit, disposers, effects: events }
}

const CALLER = { agent: { id: 'A1' } }
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve))

async function start(ctxTools, agent = CALLER) {
	return JSON.parse(await ctxTools.get('amp_run').execute({ prompt: 'do the thing', mode: 'low' }, agent))
}

test('F1: a JSON line split across two reads is not lost', async () => {
	const handle = makeHandle()
	const { tools } = makeCtx(handle)
	const run = await start(tools)

	// The child writes the init line plus HALF of the assistant line.
	handle.stdout.push('{"type":"system","subtype":"init","session_id":"T-1"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"HELLO')
	const first = JSON.parse(await tools.get('amp_send_message').execute({ run: run.run, wait_ms: 0 }, CALLER))
	assert.equal(first.newMessages.length, 1, 'only the complete init line is observed')
	assert.equal(first.newMessages[0].type, 'system')

	handle.stdout.push(' WORLD"}],"stop_reason":"end_turn"}}\n')
	const second = JSON.parse(await tools.get('amp_send_message').execute({ run: run.run, wait_ms: 0 }, CALLER))
	assert.equal(second.newMessages.length, 1, 'the split line is observed exactly once')
	assert.equal(second.newMessages[0].type, 'assistant')
	assert.match(second.newMessages[0].text, /HELLO WORLD/)
	assert.equal(second.unparsedLines, 0, 'nothing was thrown away as unparsed')
	assert.equal(second.status, 'idle (turn ended, run still open)')
	assert.ok(second.bytesSeen > 0)
})

test('F4: two concurrent amp_stop calls await ONE settlement', async () => {
	const handle = makeHandle()
	handle.waitBehavior = () => new Promise((resolve) => setTimeout(() => resolve(true), 50))
	const { tools } = makeCtx(handle)
	const run = await start(tools)
	handle.stdout.push(
		'{"type":"assistant","message":{"content":[{"type":"text","text":"DONE"}],"stop_reason":"end_turn"}}\n' +
			'{"type":"result","subtype":"success","result":"DONE","num_turns":2,"is_error":false}\n',
	)
	handle.settleFromChild({ exitCode: 0 })

	const [a, b] = await Promise.all([
		tools.get('amp_stop').execute({ run: run.run }, CALLER),
		tools.get('amp_stop').execute({ run: run.run }, CALLER),
	])
	assert.equal(JSON.parse(a).output, 'DONE')
	assert.equal(JSON.parse(b).output, 'DONE', 'the loser of the race must not report empty output')
	assert.equal(JSON.parse(b).stopReason, 'completed')
	assert.equal(handle.waitCalls, 1, 'both calls shared one bounded wait')
})

test('F14: unprovable quiescence is reported, and stop still returns', async () => {
	const handle = makeHandle()
	handle.waitBehavior = () => Promise.resolve(false) // the managed range never reports empty
	const { tools } = makeCtx(handle)
	const run = await start(tools)
	handle.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"working"}],"stop_reason":"end_turn"}}\n')

	const started = Date.now()
	const result = JSON.parse(await tools.get('amp_stop').execute({ run: run.run }, CALLER))
	assert.ok(Date.now() - started < 2000, 'stop must not hang')
	assert.match(result.diagnostic, /quiescence=UNPROVEN/)
	assert.equal(handle.terminated, true, 'a failed grace wait escalates to terminate')
	assert.equal(handle.waitCalls, 2, 'one grace wait, then one bounded re-wait')
})

test('F15: a child that exits on its own stops claiming to be alive', async () => {
	const handle = makeHandle()
	const { tools } = makeCtx(handle)
	const run = await start(tools)

	const before = JSON.parse(await tools.get('amp_send_message').execute({ run: run.run, wait_ms: 0 }, CALLER))
	assert.equal(before.alive, true)

	handle.settleFromChild({ exitCode: 17 })
	await flushMicrotasks()
	await flushMicrotasks()

	const after = JSON.parse(await tools.get('amp_send_message').execute({ run: run.run, wait_ms: 0 }, CALLER))
	assert.equal(after.alive, false)
	assert.equal(after.status, 'finished')
	assert.equal(after.exitCode, 17)
})

test('F5: a throwing stdin write is a failure, never `delivered: true`', async () => {
	const handle = makeHandle()
	const { tools } = makeCtx(handle)
	const run = await start(tools)
	handle.stdin.errorOnWrite = new Error('EPIPE: broken pipe')

	await assert.rejects(
		() => tools.get('amp_send_message').execute({ run: run.run, message: 'more', wait_ms: 0 }, CALLER),
		/could not deliver the message/,
	)
})

test('F6: a caller with no agent is refused (fail closed)', async () => {
	const handle = makeHandle()
	const { tools } = makeCtx(handle)
	const run = await start(tools)

	await assert.rejects(() => tools.get('amp_send_message').execute({ run: run.run, wait_ms: 0 }, {}), /only be reached from the agent/)
	await assert.rejects(() => tools.get('amp_stop').execute({ run: run.run }, {}), /only be reached from the agent/)
})

test('F1b: a final result line without a trailing newline still settles', async () => {
	const handle = makeHandle()
	const { tools } = makeCtx(handle)
	const run = await start(tools)
	handle.stdout.push('{"type":"result","subtype":"success","result":"TAIL_OK","is_error":false}') // no newline
	handle.settleFromChild({ exitCode: 0 })

	const result = JSON.parse(await tools.get('amp_stop').execute({ run: run.run }, CALLER))
	assert.equal(result.output, 'TAIL_OK')
	assert.equal(result.stopReason, 'completed')
})

test('A5: a run leaves an artifact that survives any ending', async () => {
	const handle = makeHandle()
	const { tools } = makeCtx(handle)
	const run = await start(tools)
	assert.equal(typeof run.artifact, 'string', 'amp_run names the artifact before anything else can fail')
	assert.ok(run.artifact.endsWith('stream.log'))
	// The key carries a timestamp, a pid and a uuid: run ids restart at run-1 in every process
	// AND two hosts can share one DSH_HOME in the same millisecond, so neither a counter nor a
	// timestamp is an identity. A collision makes one host prune a directory another is
	// still writing into.
	assert.match(run.artifact, /dsh-amp-run-1-\d+-\d+-[0-9a-f]{8}\/stream\.log$/)
	assert.match(run.source.drift, /^(in-sync|STALE|unknown)$/u, 'U6: a response says whether the running build is current')

	handle.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"WORKED"}],"stop_reason":"end_turn"}}\n')
	const stopped = JSON.parse(await tools.get('amp_stop').execute({ run: run.run }, CALLER))
	assert.equal(stopped.artifact, run.artifact)

	const text = readFileSync(stopped.artifact, 'utf8')
	assert.match(text, /do the thing/, 'the artifact records what the child was asked to do')
	assert.match(text, /WORKED/, 'and everything the child produced')

	const checkpoint = JSON.parse(readFileSync(stopped.artifact.replace('stream.log', 'checkpoint.json'), 'utf8'))
	assert.equal(checkpoint.finished, true, 'the last checkpoint says how the run ended')
	assert.equal(checkpoint.runId, run.run)
	assert.ok(existsSync(stopped.artifact))
})

test('A1: a live run registers as a background job owned by the caller', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	assert.equal(run.jobId, 'amp-live-1', 'amp_run reports the job the platform will notify on')
	assert.equal(jobs.specs.length, 1)
	const spec = jobs.specs[0]
	assert.equal(spec.kind, 'amp-live')
	assert.equal(spec.owner, CALLER.agent, 'the owning agent is exactly who gets woken')
	assert.match(spec.label, /^low: do the thing/)
	assert.equal(typeof jobs.hooks.cancel, 'function')
	assert.ok(jobs.hooks.done instanceof Promise)
})

test('A1: job_output and amp_send_message read independent cursors (no theft)', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	handle.stdout.push('{"type":"system","subtype":"init","session_id":"T-1"}\n')

	const delivered = jobs.hooks.readOutput()
	assert.match(delivered, /"subtype":"init"/, 'the job cursor sees the raw stream')
	assert.equal(jobs.hooks.readOutput(), '', 'and only once — its own cursor advanced')

	// The protocol cursor must be untouched, or the two entry points would steal from each other.
	const read = JSON.parse(await tools.get('amp_send_message').execute({ run: run.run, wait_ms: 0 }, CALLER))
	assert.equal(read.newMessages.length, 1, 'amp_send_message still sees everything since ITS last read')
	assert.equal(read.newMessages[0].subtype, 'init')
})

test('A1: done resolves on a normal ending and names the artifact', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	handle.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"ALL DONE"}],"stop_reason":"end_turn"}}\n')
	handle.stdout.push('{"type":"result","subtype":"success","result":"DONE","is_error":false}\n')
	handle.settleFromChild({ exitCode: 0 })
	await tools.get('amp_stop').execute({ run: run.run }, CALLER)

	const outcome = await jobs.hooks.done
	assert.equal(outcome.status, 'completed')
	assert.match(outcome.detail, /thread=/)
	assert.match(outcome.detail, /artifact=/, 'the notice carries what a rescuer needs')
	assert.match(outcome.detail, /lastTurn="/, 'and what the child last said')
	assert.match(outcome.detail, /next="/, 'and what the woken agent can do next')
})

test('U2: the notice says when a failure performed no work, so a retry is safe', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	// The verbatim refusal this deployment produced on the real CLI.
	handle.stdout.push(
		'{"type":"result","subtype":"error_during_execution","is_error":true,"error":"You must have at least $1 in available credits to start this request."}\n',
	)
	handle.settleFromChild({ exitCode: 0 })
	await tools.get('amp_stop').execute({ run: run.run }, CALLER)

	const outcome = await jobs.hooks.done
	assert.equal(outcome.status, 'failed')
	assert.match(outcome.detail, /failure=credits/)
	assert.match(outcome.detail, /retryable=true\(no work was performed; the pool recorded this refusal, so a new amp_run picks differently\)/)
})

test('U2: a failure after real work is NOT advertised as retryable', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	handle.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"I started editing files"}],"stop_reason":"tool_use"}}\n')
	handle.stdout.push('{"type":"result","subtype":"error_during_execution","is_error":true,"error":"Rate limit exceeded. Please try again in 57 seconds."}\n')
	handle.settleFromChild({ exitCode: 0 })
	await tools.get('amp_stop').execute({ run: run.run }, CALLER)

	const outcome = await jobs.hooks.done
	assert.equal(outcome.status, 'failed')
	assert.equal(outcome.detail.includes('retryable=true'), false, 're-running a half-done job is not safe')
})

test('A1: cancelling through the job kills the run and settles as killed', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	await start(tools)
	jobs.hooks.cancel()
	const outcome = await jobs.hooks.done
	assert.equal(outcome.status, 'killed')
	assert.equal(handle.terminated, true)
})

test('a refused job slot starts NOTHING and hands the account claim back', async () => {
	const handle = makeHandle()
	const released = []
	const pool = {
		async choose() {
			return { ref: 'A', token: 'sgamp_TESTTOKEN', detail: 'test pool' }
		},
		release(ref) {
			released.push(ref)
			return true
		},
	}
	const { tools, spawns } = makeCtx(handle, { failAdmission: true, pool })
	await assert.rejects(() => start(tools), /refused a background-job slot/)
	// The jobs contract: "Any preflight rejection leaves no job id or execution resource".
	assert.equal(spawns.length, 0, 'a refused slot must not leave a process behind')
	assert.equal(handle.terminated, false, 'there is nothing to terminate')
	assert.deepEqual(released, ['A'], 'and the claim taken for a run that never existed is handed back')
})

test('A1: a host with no jobs service is refused, not handed an untracked paid run', async () => {
	const handle = makeHandle()
	const written = []
	handle.stdin.write = (data) => written.push(data)
	const { tools } = makeCtx(handle, { noJobs: true })
	// Without a job slot the owner cannot cancel, await or be told about this run — the jobs contract
	// forbids starting it, so the refusal happens BEFORE the spawn.
	await assert.rejects(() => start(tools), /provides no jobs service/)
	assert.deepEqual(written, [], 'and nothing was delivered to anything')
})

test('A1: a non-zero exit with no failure prose still settles as failed', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	// No result message, no classified error: only the process outcome says this run failed.
	handle.settleFromChild({ exitCode: 3 })
	await tools.get('amp_stop').execute({ run: run.run }, CALLER)
	const outcome = await jobs.hooks.done
	assert.equal(outcome.status, 'failed', '"nobody classified the prose" must not mean "completed"')
})

test('amp_runs: a finished run can be found and read back without asking it', async () => {
	const handle = makeHandle()
	const { tools } = makeCtx(handle)
	const run = await start(tools)
	handle.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"HALF DONE"}],"stop_reason":"end_turn"}}\n')
	await tools.get('amp_stop').execute({ run: run.run }, CALLER)

	const listing = JSON.parse(await tools.get('amp_runs').execute({ limit: 1 }, CALLER))
	assert.equal(listing.shown, 1, 'newest first, one row')
	const [newest] = listing.runs
	assert.equal(newest.runId.startsWith(run.run), true)
	assert.equal(newest.checkpoint, 'ok', 'a readable checkpoint is reported as such, not as "missing"')
	assert.equal(newest.terminated, true)
	assert.match(newest.artifactPath, /stream\.log$/)
	assert.match(newest.lastText, /HALF DONE/, 'the checkpoint is what a rescuer reads first')
	assert.equal(typeof listing.root, 'string')
})

test('A1: an externally killed child is never reported as success (review finding)', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	// SIGKILL: no result message, no error prose, exitCode null. The old mapping asked
	// "is it a known failure?" and answered `completed` by default.
	handle.settleFromChild({ exitCode: null })
	await tools.get('amp_stop').execute({ run: run.run }, CALLER)
	const outcome = await jobs.hooks.done
	assert.equal(outcome.status, 'failed')
})

test('A1: a cancel arriving after a natural ending does not rewrite the outcome', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	handle.stdout.push('{"type":"result","subtype":"success","result":"DONE","is_error":false}\n')
	handle.settleFromChild({ exitCode: 0 })
	await tools.get('amp_stop').execute({ run: run.run }, CALLER)

	const before = await jobs.hooks.done
	jobs.hooks.cancel()
	const after = await jobs.hooks.done
	assert.equal(before.status, 'completed')
	assert.equal(after.status, 'completed', 'the ending already happened; a late cancel cannot claim it')
})

test('sanity: the modes and tool set the plugin registers', async () => {
	const { tools } = makeCtx(makeHandle())
	assert.deepEqual([...tools.keys()], ['amp_run', 'amp_send_message', 'amp_stop', 'amp_accounts', 'amp_runs'])
	assert.deepEqual(tools.get('amp_run').parameters.properties.mode.enum, ['low', 'medium'])
})

test('source fingerprint: every surface names the build that served it', async () => {
	const handle = makeHandle()
	const pool = {
		source: { file: '/installed/lib/index.js', hash: 'abcdef123456' },
		list: async () => ({ total: 0, shown: 0, rows: [] }),
	}
	const { tools } = makeCtx(handle, { pool })

	const run = await start(tools)
	assert.match(run.source.file, /lib\/live\.js$/, 'a run reports the live row actually loaded')
	assert.match(run.source.hash, /^[0-9a-f]{12}$/)

	const accounts = JSON.parse(await tools.get('amp_accounts').execute({ limit: 1 }, CALLER))
	assert.deepEqual(accounts.source, pool.source, 'the free surface reports the host row actually loaded')
})

test('A1: a clean exit with no result is not success (review finding)', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	// Exit code 0 and nothing else: the one-shot path already treats this as a failure because a
	// run with no result has nothing to show for itself. The live path must agree.
	handle.settleFromChild({ exitCode: 0 })
	await tools.get('amp_stop').execute({ run: run.run }, CALLER)
	const outcome = await jobs.hooks.done
	assert.equal(outcome.status, 'failed')
})

test('F23: the sweeper observes the stream itself, and a finished turn NOTIFIES without closing the run', async () => {
	const handle = makeHandle()
	const inbox = []
	const agent = { id: 'A1', status: 'idle', followup: (m) => inbox.push(m), inject: (m) => inbox.push(m) }
	const { tools, sweeps } = makeCtx(handle)
	const run = JSON.parse(await tools.get('amp_run').execute({ prompt: 'do the thing', mode: 'low' }, { agent }))
	// The child answered and ended its turn — and NOBODY read the stream. Before the sweeper became
	// an observer, `end_turn` was never absorbed, so this notice could never fire without polling.
	handle.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}],"stop_reason":"end_turn"}}\n')
	for (const sweep of sweeps) sweep()
	await flushMicrotasks()

	assert.equal(inbox.length, 1, 'exactly one notice, and it did not need a reader')
	const text = inbox[0].content[0].text
	assert.match(text, /finished its turn and is waiting/, 'it says the run is WAITING, not finished')
	assert.match(text, new RegExp(run.run), 'and names which run')
	assert.equal(handle.stdin.ended, false, 'and it left the run OPEN so a follow-up is still possible')
})

test('A5: the artifact never stores the injected token literally', async () => {
	const handle = makeHandle()
	const { tools } = makeCtx(handle)
	const run = await start(tools)
	handle.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"key=sgamp_SECRETVALUE"}],"stop_reason":"end_turn"}}\n')
	const stopped = JSON.parse(await tools.get('amp_stop').execute({ run: run.run }, CALLER))
	const text = readFileSync(stopped.artifact, 'utf8')
	assert.equal(text.includes('sgamp_SECRETVALUE'), false, 'the durable file must not hold a live credential')
	assert.match(text, /sgamp_<redacted>/)
})


test('a run that worked and then died is resumable, never retryable', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	// The verbatim failure that killed today's comprehensive review after 23 turns.
	handle.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"wrote sections 2-6"}],"stop_reason":"tool_use"}}\n')
	handle.stdout.push('{"type":"result","subtype":"error_during_execution","is_error":true,"error":"Compaction failed. Try again."}\n')
	handle.settleFromChild({ exitCode: 0 })
	await tools.get('amp_stop').execute({ run: run.run }, CALLER)

	const outcome = await jobs.hooks.done
	assert.equal(outcome.status, 'failed')
	assert.equal(outcome.detail.includes('retryable=true'), false, 'retrying would redo 23 turns of work')
	assert.match(outcome.detail, /resumable=true\(work is on disk/)
	assert.match(outcome.detail, /stream\.log/, 'and the notice names where the work is')
})

test('a run that ran out of credits MID-WAY is resumable, even though `credits` is a no-work kind', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	// The exact failure that killed the notice-mechanism review: it wrote its skeleton first, then
	// ran out of credit. It must not claim retryable (that would redo the work) and it must not
	// come back with nothing at all — the artifact holds the skeleton.
	handle.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"报告骨架已先落盘"}],"stop_reason":"tool_use"}}\n')
	handle.stdout.push('{"type":"result","subtype":"error_during_execution","is_error":true,"error":"You must have at least $1 in available credits to start this request."}\n')
	handle.settleFromChild({ exitCode: 0 })
	await tools.get('amp_stop').execute({ run: run.run }, CALLER)

	const outcome = await jobs.hooks.done
	assert.equal(outcome.status, 'failed')
	assert.equal(outcome.detail.includes('retryable=true'), false, 'running it again would redo the work')
	assert.match(outcome.detail, /resumable=true\(work is on disk/, 'but the work is not lost, and the notice must say so')
	assert.match(outcome.detail, /stream\.log/)
})

test('the turn-end notice mirrors the HOST wake budget: 3 wakes per agent, then injects, never drops', async () => {
	const handle = makeHandle()
	const woke = []
	const injected = []
	const agent = { id: 'A1', status: 'idle', followup: (m) => woke.push(m), inject: (m) => injected.push(m) }
	const { tools, emit } = makeCtx(handle)
	const run = JSON.parse(await tools.get('amp_run').execute({ prompt: 'do the thing', mode: 'low' }, { agent }))
	for (let turn = 0; turn < 5; turn += 1) {
		handle.stdout.push(`{"type":"assistant","message":{"content":[{"type":"text","text":"turn ${turn}"}],"stop_reason":"end_turn"}}\n`)
		await tools.get('amp_send_message').execute({ run: run.run, wait_ms: 0 }, { agent })
		if (turn < 4) await tools.get('amp_send_message').execute({ run: run.run, message: 'keep going', wait_ms: 0 }, { agent })
	}
	// The host caps CONSECUTIVE wakes per exact Agent at 3 and still DELIVERS the rest, as
	// `inject`. A per-run counter (the old shape) bounded nothing across runs and dropped the
	// 4th notice instead of injecting it.
	assert.equal(woke.length, 3, 'three wakeups open turns; the rest must not')
	assert.equal(injected.length, 2, 'and the remaining notices are still delivered')
	assert.equal(woke.length + injected.length, 5, 'no turn-end notice is ever dropped')

	// A second run on the SAME agent shares that budget rather than getting a fresh three.
	const second = JSON.parse(await tools.get('amp_run').execute({ prompt: 'another', mode: 'low' }, { agent }))
	handle.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"turn 0"}],"stop_reason":"end_turn"}}\n')
	await tools.get('amp_send_message').execute({ run: second.run, wait_ms: 0 }, { agent })
	assert.equal(woke.length, 3, 'a second concurrent run cannot buy another three wakeups')

	// Human input refills the budget, exactly as the platform reporter does.
	emit('agent/inbox/claimed', { agent, message: { source: { kind: 'user' } } })
	await tools.get('amp_send_message').execute({ run: second.run, message: 'go again', wait_ms: 0 }, { agent })
	handle.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"turn 1"}],"stop_reason":"end_turn"}}\n')
	await tools.get('amp_send_message').execute({ run: second.run, wait_ms: 0 }, { agent })
	assert.equal(woke.length, 4, 'after the owner consumed human input, the next notice wakes again')
})

test('the terminal notice describes a terminal run, not one that can be steered', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	handle.stdout.push('{"type":"result","subtype":"success","result":"DONE","is_error":false}\n')
	handle.settleFromChild({ exitCode: 0 })
	await tools.get('amp_stop').execute({ run: run.run }, CALLER)

	const outcome = await jobs.hooks.done
	assert.match(outcome.detail, /state=terminal/)
	assert.equal(outcome.detail.includes('steer'), false, 'a settled run cannot be steered; suggesting it contradicted amp_send_message')
	assert.equal(outcome.detail.includes('resumable=true'), false, 'a completed run has nothing to resume')
	assert.match(outcome.detail, /read the artifact/)
})

test('both surfaces project ONE outcome: job status and amp_stop stopReason never disagree', async () => {
	const cases = [
		{
			name: 'a completed run',
			feed: (h) => {
				h.stdout.push('{"type":"result","subtype":"success","result":"DONE","is_error":false}\n')
				h.settleFromChild({ exitCode: 0 })
			},
			status: 'completed',
			stopReason: 'completed',
		},
		{
			name: 'a failed run (clean exit, no result)',
			feed: (h) => h.settleFromChild({ exitCode: 0 }),
			status: 'failed',
			stopReason: 'error',
		},
		{
			name: 'an externally killed run',
			feed: (h) => h.settleFromChild({ exitCode: null }),
			status: 'failed',
			stopReason: 'error',
		},
	]
	for (const c of cases) {
		const handle = makeHandle()
		const { tools, jobs } = makeCtx(handle)
		const run = await start(tools)
		c.feed(handle)
		const stopped = JSON.parse(await tools.get('amp_stop').execute({ run: run.run }, CALLER))
		const outcome = await jobs.hooks.done
		assert.equal(outcome.status, c.status, `${c.name}: job status`)
		assert.equal(stopped.stopReason, c.stopReason, `${c.name}: stopReason`)
	}
})

test('a kill through the job reports killed/aborted from the SAME outcome', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	// A live child, killed through the job's cancel hook — not through amp_stop.
	const stopped = await (async () => {
		jobs.hooks.cancel()
		return JSON.parse(await tools.get('amp_stop').execute({ run: run.run }, CALLER))
	})()
	const outcome = await jobs.hooks.done
	assert.equal(outcome.status, 'killed')
	assert.equal(stopped.stopReason, 'aborted', 'aborted because it WAS killed, not because this call passed kill:true')
})

test('a silently failing artifact write is REPORTED, not trusted (review high #2)', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	// Make the durable record impossible to extend. Deleting the directory is NOT enough — the
	// store recreates it — so make it unwritable instead.
	const dir = run.artifact.replace(/\/stream\.log$/u, '')
	chmodSync(dir, 0o500)
	try {
		// A state transition triggers saveCheckpoint, which now fails and must be noticed.
		handle.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"still working"}],"stop_reason":"end_turn"}}\n')
		await tools.get('amp_send_message').execute({ run: run.run, wait_ms: 0 }, CALLER)
		const stopped = JSON.parse(await tools.get('amp_stop').execute({ run: run.run }, CALLER))

		assert.match(stopped.diagnostic, /artifact=INCOMPLETE|artifactError/, 'the stop report says the record is incomplete')
		const outcome = await jobs.hooks.done
		assert.match(outcome.detail, /artifact=INCOMPLETE/, 'and so does the notice the woken agent reads')
		assert.match(outcome.detail, /do not trust this record/)
	} finally {
		chmodSync(dir, 0o700)
	}
})

test('a trivial follow-up turn cannot erase the summary a woken agent relies on', async () => {
	const handle = makeHandle()
	const inbox = []
	const agent = { id: 'A1', status: 'idle', followup: (m) => inbox.push(m), inject: (m) => inbox.push(m) }
	const { tools } = makeCtx(handle)
	const run = JSON.parse(await tools.get('amp_run').execute({ prompt: 'write the report', mode: 'low' }, { agent }))

	// A real turn with real content…
	handle.stdout.push(`{"type":"assistant","message":{"content":[{"type":"text","text":"报告已写完：三节，含证据与行号。"}],"stop_reason":"end_turn"}}\n`)
	await tools.get('amp_send_message').execute({ run: run.run, wait_ms: 0 }, { agent })
	// …then a one-word follow-up, exactly the test that hid it in real life.
	await tools.get('amp_send_message').execute({ run: run.run, message: 'reply OK only', wait_ms: 0 }, { agent })
	handle.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}],"stop_reason":"end_turn"}}\n')
	await tools.get('amp_send_message').execute({ run: run.run, wait_ms: 0 }, { agent })

	const last = inbox.at(-1).content[0].text
	assert.match(last, /lastTurn="OK"/, 'the final turn is reported honestly')
	assert.match(last, /summary="报告已写完/, 'and the substantive turn rides along, so the work is still visible')
})

test('terminal outcome: a partial durable record cannot be reported as clean success', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	// The process really did succeed…
	handle.stdout.push('{"type":"result","subtype":"success","result":"REPORT WRITTEN","is_error":false}\n')
	const dir = run.artifact.replace(/\/stream\.log$/u, '')
	chmodSync(dir, 0o500) // …but the record of it cannot be extended
	try {
		handle.settleFromChild({ exitCode: 0 })
		const stopped = JSON.parse(await tools.get('amp_stop').execute({ run: run.run }, CALLER))
		const outcome = await jobs.hooks.done

		assert.equal(outcome.status, 'failed', 'the jobs enum is closed, so degradation must be projected as failure')
		assert.match(outcome.detail, /durability=partial/, 'while saying exactly what degraded')
		assert.match(outcome.detail, /processStatus=completed/, 'and that the process itself did succeed')
		assert.equal(outcome.detail.includes('resumable=true'), false, 'never promise a resume on a record we know is partial')
		assert.equal(stopped.stopReason, 'error', 'both surfaces agree')
	} finally {
		chmodSync(dir, 0o700)
	}
})

test('terminal outcome: unproven quiescence cannot be a silent completed job', async () => {
	const handle = makeHandle()
	handle.waitBehavior = () => Promise.resolve(false) // the managed range never reports stopped
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	handle.stdout.push('{"type":"result","subtype":"success","result":"DONE","is_error":false}\n')
	handle.settleFromChild({ exitCode: 0 })

	const stopped = JSON.parse(await tools.get('amp_stop').execute({ run: run.run }, CALLER))
	const outcome = await jobs.hooks.done

	assert.equal(outcome.status, 'failed', 'an orphan may still be alive: that is not a clean completed job')
	assert.match(outcome.detail, /quiescence=unproven/, 'and the fact is projected, not hidden in another surface')
	assert.match(stopped.diagnostic, /quiescence=UNPROVEN/)
	assert.equal(stopped.stopReason, 'error', 'both surfaces agree')
})

test('amp_runs: a corrupt checkpoint is UNKNOWN, not "ok" and not proof of interruption', async () => {
	const handle = makeHandle()
	const { tools } = makeCtx(handle)
	const run = await start(tools)
	handle.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"PARTIAL WORK"}],"stop_reason":"end_turn"}}\n')
	await tools.get('amp_stop').execute({ run: run.run }, CALLER)

	// Damage the checkpoint the way a crash mid-write would.
	const checkpointPath = run.artifact.replace(/stream\.log$/u, 'checkpoint.json')
	writeFileSync(checkpointPath, '{ this is not json')

	const listing = JSON.parse(await tools.get('amp_runs').execute({ limit: 1 }, CALLER))
	const [row] = listing.runs
	assert.equal(row.checkpoint, 'unreadable', 'an unreadable checkpoint must never be reported as ok')
	assert.match(String(row.checkpointError), /checkpoint/i, 'the store error text survives to the rescuer')
	assert.equal(row.interrupted, undefined, 'interruption is UNKNOWN, not asserted, when the checkpoint cannot be read')
	assert.match(row.resumeHint, /UNKNOWN/, 'and the hint says what to do instead of guessing')
})

test('amp_runs: an unlistable run root reports the store error, not a secondary TypeError', async () => {
	const handle = makeHandle()
	const { tools } = makeCtx(handle)
	const listing = JSON.parse(await tools.get('amp_runs').execute({ limit: 1 }, CALLER))
	const root = listing.root
	chmodSync(root, 0o000)
	try {
		await assert.rejects(
			() => tools.get('amp_runs').execute({ limit: 1 }, CALLER),
			(error) => /could not be listed/.test(error.message) && error instanceof TypeError === false,
		)
	} finally {
		chmodSync(root, 0o700)
	}
})

test('resumable is withheld while quiescence is unproven', async () => {
	const handle = makeHandle()
	handle.waitBehavior = () => Promise.resolve(false)
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	handle.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"wrote the report"}],"stop_reason":"tool_use"}}\n')
	handle.stdout.push('{"type":"result","subtype":"success","result":"DONE","is_error":false}\n')
	handle.settleFromChild({ exitCode: 0 })
	await tools.get('amp_stop').execute({ run: run.run }, CALLER)

	const outcome = await jobs.hooks.done
	assert.equal(outcome.status, 'failed', 'a possible orphan is not a clean success')
	assert.match(outcome.detail, /quiescence=unproven/)
	assert.equal(
		outcome.detail.includes('resumable=true'),
		false,
		'never invite a follow-up run while a previous process may still be running',
	)
})

test('admission is decided BEFORE the prompt is delivered, and a refusal starts no process', async () => {
	const handle = makeHandle()
	const written = []
	handle.stdin.write = (data) => written.push(data)
	const { tools, spawns } = makeCtx(handle, { failAdmission: true })
	const before = new Set(JSON.parse(await tools.get('amp_runs').execute({ limit: 0 }, CALLER)).runs.map((row) => row.runId))
	await assert.rejects(
		() => tools.get('amp_run').execute({ prompt: 'do something expensive', mode: 'low' }, CALLER),
		(error) =>
			/refused a background-job slot/.test(error.message) &&
			/no process was started/.test(error.message) &&
			/claim was handed back/.test(error.message),
	)
	assert.deepEqual(written, [], 'the child must never receive work it has no job slot for')
	assert.equal(spawns.length, 0, 'preflight rejection happens before the process exists — the real contract')
	assert.equal(handle.terminated, false, 'and there is nothing to stop')

	// Nothing was created, so nothing lingers for a rescuer to trip over either.
	const after = JSON.parse(await tools.get('amp_runs').execute({ limit: 0 }, CALLER)).runs
	const added = after.filter((row) => before.has(row.runId) === false)
	assert.equal(added.length, 0, 'a refused dispatch leaves no artifact record')
})

test('retryable is withheld while quiescence is unproven', async () => {
	const handle = makeHandle()
	handle.waitBehavior = () => Promise.resolve(false)
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	// A refusal that did no work — the one case that normally earns retryable=true.
	handle.stdout.push('{"type":"result","subtype":"error_during_execution","is_error":true,"error":"Rate limit exceeded. Please try again in 57 seconds."}\n')
	handle.settleFromChild({ exitCode: 0 })
	await tools.get('amp_stop').execute({ run: run.run }, CALLER)

	const outcome = await jobs.hooks.done
	assert.equal(outcome.detail.includes('retryable=true'), false, 'a possible orphan makes "retry now" the wrong advice')
	assert.match(outcome.detail, /quiescence=unproven/)
})

test('amp_accounts {preview:true} reports which account each mode would take, with the pool reason', async () => {
	const handle = makeHandle()
	const pool = {
		source: { hash: 'abcdef123456', modules: {}, drift: 'in-sync' },
		list: async () => ({ total: 2, shown: 2, rows: [{ ref: 'A', usable: true }, { ref: 'B', usable: true }] }),
		preview: async (options) => ({ ref: options.mode === 'low' ? 'B' : 'A', state: 'ledger', remaining: 5, detail: 'x' }),
	}
	const { tools } = makeCtx(handle, { pool })
	const withoutPreview = JSON.parse(await tools.get('amp_accounts').execute({ limit: 2 }, CALLER))
	assert.equal(withoutPreview.next, undefined, 'selection work is opt-in, not a surprise cost')

	const withPreview = JSON.parse(await tools.get('amp_accounts').execute({ limit: 2, preview: true }, CALLER))
	assert.equal(withPreview.next.low.ref, 'B')
	assert.equal(withPreview.next.medium.ref, 'A', 'each mode is answered by the pool itself')
	assert.equal(withPreview.next.medium.state, 'ledger')
})

test('a refused slot cannot claim anything about a child, because none was started', async () => {
	const handle = makeHandle()
	handle.waitBehavior = () => Promise.resolve(false) // would matter only if a process existed
	const written = []
	const released = []
	handle.stdin.write = (data) => written.push(data)
	const pool = {
		async choose() {
			return { ref: 'A', token: 'sgamp_TESTTOKEN', detail: 'test pool' }
		},
		release(ref) {
			released.push(ref)
			return true
		},
	}
	const { tools, spawns } = makeCtx(handle, { failAdmission: true, pool })
	await assert.rejects(
		() => tools.get('amp_run').execute({ prompt: 'expensive', mode: 'low' }, CALLER),
		(error) =>
			/refused a background-job slot/.test(error.message) &&
			/no process was started/.test(error.message) &&
			/nothing to stop/.test(error.message) &&
			/could NOT be confirmed empty/.test(error.message) === false,
	)
	assert.deepEqual(written, [], 'still no work delivered')
	assert.equal(spawns.length, 0, 'and no process whose quiescence anyone would have to prove')
	assert.deepEqual(released, ['A'], 'the claim is released without any question of quiescence')
})

test('the checkpoint carries the projected status, so retention can spot an unclassified failure', async () => {
	const handle = makeHandle()
	const { tools } = makeCtx(handle)
	const run = await start(tools)
	// A failure no classifier names: the child exits non-zero without a structured result.
	handle.settleFromChild({ exitCode: 3 })
	await tools.get('amp_stop').execute({ run: run.run }, CALLER)

	const checkpointPath = run.artifact.replace(/stream\.log$/u, 'checkpoint.json')
	const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'))
	assert.equal(checkpoint.status, 'failed', 'the record says what every other surface says')
	assert.equal(checkpoint.finished, true)
})

test('the model-facing descriptions describe the plugin that exists', async () => {
	const handle = makeHandle()
	const { tools } = makeCtx(handle)
	const run = tools.get('amp_run').description
	// The idle-settle policy was removed; the description kept promising it. A model reading that
	// would wait for a notification that arrives as a TURN-END notice and then mis-plan the run.
	assert.equal(/closed automatically/i.test(run), false, 'no auto-close promise remains')
	assert.match(run, /STAYS OPEN/, 'it says the run stays open after a turn ends')
	assert.match(run, /notified/i, 'and that the turn end is a notification, not a poll')
	assert.match(run, /jobs/, 'and that a job slot is required')

	const stop = tools.get('amp_stop').description
	assert.equal(/stays unarchived, so continuing/i.test(stop), false, 'no thread-continuation promise remains')
	assert.match(stop, /does NOT resume it/, 'the stop description states the real continuation story')
})

test('the live path refuses an oversized prompt before it claims an account', async () => {
	const handle = makeHandle()
	const written = []
	handle.stdin.write = (data) => written.push(data)
	const { tools } = makeCtx(handle)
	const huge = 'x'.repeat(1024 * 1024 + 1)
	await assert.rejects(
		() => tools.get('amp_run').execute({ prompt: huge, mode: 'low' }, CALLER),
		/refusing rather than sending a truncated instruction/,
	)
	assert.deepEqual(written, [], 'nothing was delivered')
	// And an oversized steering message is refused too, on the same rule.
	const run = await start(tools)
	await assert.rejects(
		() => tools.get('amp_send_message').execute({ run: run.run, message: huge }, CALLER),
		/at most/,
	)
})

test('a host with no timer service is LOUD about losing notices and the reaper', async () => {
	const handle = makeHandle()
	const { tools, warnings } = makeCtx(handle, { noTimer: true })

	// 1) the operator sees it at mount, with the consequence, not a silent skip.
	assert.ok(
		warnings.some((message) => /no timer service/.test(message) && /DISABLED/.test(message)),
		'mounting without a timer must warn',
	)
	// 2) the model sees it in the description it plans delegation from…
	assert.match(tools.get('amp_run').description, /WARNING: this host has no timer service/)
	// 3) …and in every dispatch result, where it cannot be missed.
	const run = JSON.parse(await tools.get('amp_run').execute({ prompt: 'do the thing', mode: 'low' }, CALLER))
	assert.match(run.warning, /will NOT notify you when a turn ends/)
})

// ---------------------------------------------------------------------------
// AMP review round 7 — regressions for the fixes. Each test fails on the build
// that was reviewed.
// ---------------------------------------------------------------------------

test('AMP-R1: a terminal result absorbed BEFORE the exit still settles the job', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)

	// Any reader (a read, a sweep) can absorb the protocol's last line before `handle.done`
	// resolves. Treating that as "already finished" made the exit observer skip settlement, so
	// `markSettled` never ran: the DSH job stayed `running` forever and its terminal notice
	// never arrived. The status must also not claim a settlement that has not happened.
	handle.stdout.push('{"type":"result","subtype":"success","result":"DONE","is_error":false}\n')
	const read = JSON.parse(await tools.get('amp_send_message').execute({ run: run.run, wait_ms: 0 }, CALLER))
	assert.match(read.status, /result received/, 'the protocol result is not settlement')
	assert.equal(read.alive, true, 'the process has not exited yet, so it is still alive')

	handle.settleFromChild({ exitCode: 0 })
	const outcome = await jobs.hooks.done
	assert.equal(outcome.status, 'completed', 'the exit settles the job with nobody calling amp_stop')
	assert.match(outcome.detail, /state=terminal/)

	// And the terminal surface agrees with the job, from the one outcome.
	const stopped = JSON.parse(await tools.get('amp_stop').execute({ run: run.run }, CALLER))
	assert.equal(stopped.stopReason, 'completed')
})

test('AMP-C2: a refused job slot never claims an account either', async () => {
	const handle = makeHandle()
	const released = []
	const pool = {
		async choose() {
			return { ref: 'A', token: 'sgamp_TESTTOKEN', detail: 'test pool' }
		},
		release(ref) {
			released.push(ref)
			return true
		},
	}
	const { tools, spawns } = makeCtx(handle, { failAdmission: true, pool })
	await assert.rejects(() => start(tools), /refused a background-job slot/)
	assert.deepEqual(released, ['A'], 'the claim is handed back')
	assert.equal(spawns.length, 0, 'and nothing was spawned')
})

test('AMP-R3: a system-level error is classified on the live path too', async () => {
	const handle = makeHandle()
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)
	// The one-shot path always folded `system` errors into the classifier; the live path
	// dropped them, so the SAME upstream error produced `failure=null` here and a real kind
	// there — and the pool was never told to cool the account down.
	handle.stdout.push('{"type":"system","subtype":"error","error":"Rate limit exceeded. Please try again in 57 seconds."}\n')
	handle.settleFromChild({ exitCode: 0 })

	const stopped = JSON.parse(await tools.get('amp_stop').execute({ run: run.run }, CALLER))
	assert.match(stopped.diagnostic, /failure=rate-limit/, 'the live diagnostic names the kind')
	const outcome = await jobs.hooks.done
	assert.equal(outcome.status, 'failed')
	assert.match(outcome.detail, /failure=rate-limit/)
})

test('AMP-R1b: a kill arriving mid-settle is reported as killed, not failed', async () => {
	const handle = makeHandle()
	// The graceful settlement is already waiting when the kill arrives.
	handle.waitBehavior = () => new Promise((resolve) => setTimeout(() => resolve(true), 50))
	const { tools, jobs } = makeCtx(handle)
	const run = await start(tools)

	const graceful = tools.get('amp_stop').execute({ run: run.run }, CALLER)
	await flushMicrotasks()
	jobs.hooks.cancel()
	handle.settleFromChild({ exitCode: 0 })

	const stopped = JSON.parse(await graceful)
	assert.equal(stopped.stopReason, 'aborted', 'the caller killed it; the outcome must not say failed')
	const outcome = await jobs.hooks.done
	assert.equal(outcome.status, 'killed')
})

test('AMP-R10: the disposer does NOT resolve before settlement finishes', async () => {
	let openGate
	const gate = new Promise((resolve) => {
		openGate = resolve
	})
	const handle = makeHandle()
	// The managed range stays non-empty until the gate opens, so settlement cannot complete either.
	handle.waitBehavior = () => gate.then(() => true)
	const { tools, jobs, disposers } = makeCtx(handle)
	await start(tools)

	let disposersDone = false
	const all = Promise.all(disposers.map((dispose) => dispose())).then(() => {
		disposersDone = true
	})
	let jobDone = false
	void jobs.hooks.done.then(() => {
		jobDone = true
	})

	// The previous version of this test only asserted "everything finished within 1s", which an
	// implementation that drops the settlement (`void Promise.allSettled(...)`) satisfies too —
	// the reviewer proved that by mutation. The discriminating property is that NOTHING resolves
	// while the range is still open.
	await new Promise((resolve) => setTimeout(resolve, 30))
	assert.equal(disposersDone, false, 'the disposer must still be waiting on settlement')
	assert.equal(jobDone, false, 'and the job cannot settle before the range empties')
	assert.equal(handle.terminated, true, 'the child was asked to terminate')

	openGate()
	await all
	await jobs.hooks.done
	assert.equal(disposersDone, true)
	assert.equal(jobDone, true)
})


// ---------------------------------------------------------------------------
// AMP round 8 regressions.
// ---------------------------------------------------------------------------

test('AMP-G1: a settlement error still releases the account claim and finalizes the record', async () => {
	const handle = makeHandle()
	const released = []
	const pool = {
		async choose() {
			return { ref: 'A', token: 'sgamp_TESTTOKEN', claimToken: 'lease-A', detail: 'test pool' }
		},
		release(ref, token) {
			released.push([ref, token])
			return true
		},
	}
	const { tools, jobs } = makeCtx(handle, { pool })
	const run = await start(tools)
	handle.stdout.push('{"type":"assistant","message":{"content":[{"type":"text","text":"WORKED"}],"stop_reason":"end_turn"}}\n')
	// A reader that throws makes `absorb()` fail INSIDE settlement. The release and the finalize
	// used to sit after it, so the account stayed claimed for the TTL and the record was never
	// closed — the reviewer reproduced exactly this.
	const originalRead = handle.collected.stdout.readFrom
	handle.collected.stdout.readFrom = () => {
		throw new Error('reader exploded')
	}

	const stopped = JSON.parse(await tools.get('amp_stop').execute({ run: run.run }, CALLER))
	assert.equal(stopped.stopReason, 'error', 'settlement failure is reported, not hidden')
	assert.match(String(stopped.diagnostic ?? ''), /settleError=reader exploded/)
	assert.deepEqual(released, [['A', 'lease-A']], 'the lease is released on the throwing path too')
	const outcome = await jobs.hooks.done
	assert.equal(outcome.status, 'failed')
	// The artifact was still finalized (its checkpoint says so), even though the stream read failed.
	handle.collected.stdout.readFrom = originalRead
	const checkpoint = JSON.parse(readFileSync(run.artifact.replace(/stream\.log$/u, 'checkpoint.json'), 'utf8'))
	assert.equal(checkpoint.finished, true, 'the durable record was closed')
})

test('AMP-G3: a lease is released by its OWNER only — a shared account survives the other run', async () => {
	const handle = makeHandle()
	const first = makeHandle()
	let n = 0
	const ctxRuns = []
	const pool = {
		async choose() {
			n += 1
			return { ref: 'A', token: 'sgamp_TESTTOKEN', claimToken: `lease-${String(n)}`, detail: 'test pool' }
		},
		release(ref, token) {
			ctxRuns.push([ref, token])
			return true
		},
	}
	const { tools } = makeCtx(handle, { pool })
	const runA = await start(tools)
	const runB = JSON.parse(await tools.get('amp_run').execute({ prompt: 'second', mode: 'low' }, CALLER))
	assert.equal(runA.run === runB.run, false)
	// Run A ends and releases ITS lease.
	await tools.get('amp_stop').execute({ run: runA.run }, CALLER)
	assert.deepEqual(ctxRuns, [['A', 'lease-1']], 'only A\'s lease was released')
	// B is still alive, so a third dispatch must still see the account as claimed. The old
	// ref-keyed Map let A's release hand B's account to anyone.
	const readB = JSON.parse(await tools.get('amp_send_message').execute({ run: runB.run, wait_ms: 0 }, CALLER))
	assert.equal(typeof readB.status, 'string')
})

test('AMP-G4: amp_accounts limit:0 really means every account', async () => {
	const handle = makeHandle()
	const seen = []
	const pool = {
		async list(options) {
			seen.push(options)
			return { total: 3, shown: options.limit === 0 ? 3 : 12, rows: [] }
		},
		source: { file: '/tmp/lib/live.js', hash: 'x', modules: {} },
		preview: async () => undefined,
	}
	const { tools } = makeCtx(handle, { pool })
	await tools.get('amp_accounts').execute({ limit: 0 }, CALLER)
	assert.deepEqual(seen.at(-1), { limit: 0, refresh: false }, 'an explicit 0 is passed through, not dropped')
	await tools.get('amp_accounts').execute({ limit: 5, refresh: true }, CALLER)
	assert.deepEqual(seen.at(-1), { limit: 5, refresh: true })
})

test('AMP-G5: an empty prompt is refused before any account is claimed or any process starts', async () => {
	const handle = makeHandle()
	const released = []
	const pool = {
		async choose() {
			throw new Error('selection must not run for an empty prompt')
		},
		release(ref) {
			released.push(ref)
		},
	}
	const { tools, spawns } = makeCtx(handle, { pool })
	await assert.rejects(
		() => tools.get('amp_run').execute({ prompt: '   ', mode: 'low' }, CALLER),
		/needs a non-empty prompt/,
	)
	assert.equal(spawns.length, 0)
	assert.deepEqual(released, [])
})

test('AMP-G6: unproven quiescence is reported as UNKNOWN liveness, never as a dead process', async () => {
	const handle = makeHandle()
	handle.waitBehavior = () => Promise.resolve(false) // the managed range never reports empty
	const { tools, sweeps } = makeCtx(handle, { idleTimeoutMs: 1 })
	const run = await start(tools)
	await new Promise((resolve) => setTimeout(resolve, 5))
	sweeps[0]() // the idle observer closes the forgotten run
	// Settlement is asynchronous: it also waits (bounded) for an exit code that never arrives.
	await new Promise((resolve) => setTimeout(resolve, 700))
	const read = JSON.parse(await tools.get('amp_send_message').execute({ run: run.run, wait_ms: 0 }, CALLER))
	assert.equal(read.alive, null, 'settlement finished, but the process was never proven gone')
	assert.match(read.status, /quiescence unproven/)
})

test('AMP-G7: two runs in the same millisecond are still ordered newest-first', async () => {
	const handle = makeHandle()
	const { tools } = makeCtx(handle)
	const root = JSON.parse(await tools.get('amp_runs').execute({ limit: 1 }, CALLER)).root
	const older = 'dsh-amp-run-9-1700000000000'
	const newer = 'dsh-amp-run-1-1700000000000-222-aaaaaaaa'
	mkdirSync(join(root, older), { recursive: true })
	mkdirSync(join(root, newer), { recursive: true })
	// The epoch is identical; only the mtime says which came later. Lexical order would put the
	// `run-9` key first, which is exactly what the reviewed build returned as "newest".
	utimesSync(join(root, older), new Date(1_700_000_000_000), new Date(1_700_000_000_000))
	utimesSync(join(root, newer), new Date(1_700_000_010_000), new Date(1_700_000_010_000))

	const listing = JSON.parse(await tools.get('amp_runs').execute({ limit: 0 }, CALLER))
	const olderIndex = listing.runs.findIndex((row) => row.runId === older)
	const newerIndex = listing.runs.findIndex((row) => row.runId === newer)
	assert.notEqual(olderIndex, -1)
	assert.notEqual(newerIndex, -1)
	assert.ok(newerIndex < olderIndex, 'same-epoch runs are ordered by their recorded mtime')
})
