/**
 * dsh-amp one-shot provider behavioural tests.
 *
 * The provider is driven through `apply()` with a fake ctx, so every assertion below
 * exercises plugin code: account selection, the prompt path, the failure classifier,
 * and — the reason this file exists — what the failure path is allowed to return.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

// The ledger is created during `apply()`. Point it at a throwaway home so a test run
// can never touch the real `~/.dsh/state/dsh-amp/ledger.json`.
process.env.DSH_HOME = process.env.DSH_HOME ?? '/tmp/dsh-amp-test-home'

const TOKEN = 'sgamp_SECRET123'
const { apply, SOURCE } = await import('../lib/index.js')

test('source fingerprint: the loaded host row is identified', () => {
	assert.match(SOURCE.file, /lib\/index\.js$/)
	assert.match(SOURCE.hash, /^[0-9a-f]{12}$/)
	// One entry hash cannot prove a change to a NON-entry module is live; this can.
	assert.match(SOURCE.modules['accounts.js'], /^[0-9a-f]{12}$/)
	assert.match(SOURCE.modules['live.js'] ?? SOURCE.modules['artifact.js'], /^[0-9a-f]{12}$/)
})

function byteReader(text) {
	return { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) }
}

function makeProvider({ exitCode, stdout = '', stderr = '', accountRefs = ['R1'], waitForExit, failResolve, failSettings, settingsValue } = {}) {
	const providers = []
	const state = { spec: undefined }
	const ctx = {
		logger: { info() {}, warn() {} },
		effect(fn) {
			fn()
			return () => {}
		},
		provide(name, value) {
			ctx.__services ??= {}
			ctx.__services[name] = value
		},
		get(name) {
			return ctx.__services?.[name]
		},
		inject(deps, callback) {
			// A settings service: either one that REFUSES the namespace (a duplicate
			// registration, or a stored section its schema rejects), or a working one whose
			// committed value a test can change without firing the watcher. Otherwise this
			// harness has no settings service at all, which is a legitimate composition.
			if (settingsValue !== undefined && deps.includes('settings') && typeof callback === 'function') {
				callback({
					effect(fn) {
						fn()
						return () => {}
					},
					provide() {},
					settings: {
						register(_ns, _schema, options) {
							const base = options?.base ?? {}
							return {
								get: () => ({ ...base, ...settingsValue }),
								watch: () => () => {},
							}
						},
					},
				})
				return
			}
			if (failSettings === true && deps.includes('settings') && typeof callback === 'function') {
				callback({
					effect(fn) {
						fn()
						return () => {}
					},
					provide() {},
					settings: {
						register() {
							throw new Error('settings namespace "dsh-amp" is already registered')
						},
					},
				})
			}
		},
		credentials: {
			async resolve(ref) {
				// A per-ref token, so a test can tell WHICH account a dispatch used.
				return { value: ref === 'R1' ? TOKEN : `sgamp_${String(ref)}` }
			}
		},
		subprocess: {
			async resolveExecutable(bin) {
				if (failResolve === true) throw new Error('amp executable not found')
				return bin
			},
			spawn(spec) {
				state.spec = spec
				return {
					stdin: { write() {}, end() {} },
					done: Promise.resolve({ exitCode }),
					collected: { stdout: byteReader(stdout), stderr: byteReader(stderr) },
					terminate() {},
					waitForExit: waitForExit ?? (() => Promise.resolve(true)),
				}
			},
		},
		subagents: {
			registerProvider(provider) {
				providers.push(provider)
				return () => {}
			},
		},
	}
	apply(ctx, { accountRefs, modes: ['low'], cwd: '/tmp' })
	return { provider: providers.at(-1), providers, state, ctx, pool: ctx.__services?.ampAccounts }
}

async function run({ exitCode, stdout, stderr }) {
	const { provider, state } = makeProvider({ exitCode, stdout, stderr })
	const handle = await provider.start({
		prompt: [{ type: 'text', text: 'review the plugin' }],
		parent: { id: 'P1' },
		signal: new AbortController().signal,
	})
	return { result: await handle.result, spec: state.spec }
}

const SUCCESS_RESULT = '{"type":"result","subtype":"success","result":"ALL DONE","num_turns":3,"is_error":false}\n'

test('F13: the failure path redacts the injected token from model-visible output', async () => {
	const { result } = await run({ exitCode: 1, stderr: `boom AMP_API_KEY=${TOKEN}` })
	assert.equal(result.stopReason, 'error')
	const asJson = JSON.stringify(result)
	assert.equal(asJson.includes(TOKEN), false, 'the raw token must never reach the caller')
	assert.match(asJson, /sgamp_<redacted>/)
	assert.match(result.diagnostic, /sgamp_<redacted>/)
})

test('F13b: a token in a structured error is redacted too', async () => {
	const stdout = `{"type":"result","subtype":"error_during_execution","is_error":true,"error":"auth failed for ${TOKEN}"}\n`
	const { result } = await run({ exitCode: 0, stdout })
	assert.equal(result.stopReason, 'error')
	assert.equal(JSON.stringify(result).includes(TOKEN), false)
	assert.match(JSON.stringify(result), /sgamp_<redacted>/)
})

test('the token reaches the child through env, never through argv', async () => {
	const { spec } = await run({ exitCode: 0, stdout: SUCCESS_RESULT })
	assert.equal(spec.env.AMP_API_KEY, TOKEN)
	assert.equal(spec.argv.join(' ').includes(TOKEN), false)
	assert.equal(spec.argv.join(' ').includes('review the plugin'), false, 'the prompt travels on stdin, not argv')
})

test('a successful run returns the result text and reports completed', async () => {
	const { result } = await run({ exitCode: 0, stdout: SUCCESS_RESULT })
	assert.equal(result.stopReason, 'completed')
	assert.equal(result.output.length, 1)
	assert.equal(result.output[0].text, 'ALL DONE')
})

test('a clean exit with no result message is still a failure', async () => {
	const { result } = await run({ exitCode: 0, stdout: '\n' })
	assert.equal(result.stopReason, 'error')
	assert.match(result.output.at(-1).text, /no result message/)
})

test('F9: an oversized prompt is refused loudly instead of silently truncated', async () => {
	const { provider, state } = makeProvider({ exitCode: 0 })
	const huge = 'x'.repeat(1024 * 1024 + 1)
	// Whether the refusal surfaces as a rejected start() or as an error result, the caller must be
	// TOLD: truncating produced a plausible run built on half an instruction.
	const outcome = await Promise.resolve()
		.then(() => provider.start({ prompt: [{ type: 'text', text: huge }], parent: { id: 'P1' }, signal: new AbortController().signal }))
		.then((handle) => handle.result, (error) => error)
	const text = outcome instanceof Error ? outcome.message : JSON.stringify(outcome)
	assert.match(text, /refusing rather than truncating/)
	const delivered = state.spec?.stdio?.stdin?.data
	assert.equal(typeof delivered === 'string' && delivered.length > 1024 * 1024, false, 'the oversized prompt was never delivered (a probe spawn may still exist)')
})

test('F9: the size guard measures BYTES, so a multibyte prompt cannot arrive truncated', async () => {
	const { provider, state } = makeProvider({ exitCode: 0 })
	// 400k CJK characters: comfortably under 1M in UTF-16 code units, but ~1.2MB in UTF-8 bytes.
	const multibyte = '中'.repeat(400_000)
	assert.ok(multibyte.length < 1024 * 1024, 'the old code-unit check would have let this through')
	const outcome = await Promise.resolve()
		.then(() => provider.start({ prompt: [{ type: 'text', text: multibyte }], parent: { id: 'P1' }, signal: new AbortController().signal }))
		.then((handle) => handle.result, (error) => error)
	const text = outcome instanceof Error ? outcome.message : JSON.stringify(outcome)
	assert.match(text, /refusing rather than truncating/)
	const delivered = state.spec?.stdio?.stdin?.data
	assert.equal(typeof delivered === 'string' && delivered.length > 0, false, 'nothing headless was delivered')
})

test('a rejected start() hands the account claim back (review P1)', async () => {
	const { provider, pool } = makeProvider({ exitCode: 0, failResolve: true })
	const released = []
	const original = pool.release.bind(pool)
	pool.release = (ref) => {
		released.push(ref)
		return original(ref)
	}
	// The account is selected first, and `resolveExecutable` then fails. No run is published, so
	// no caller can dispose it: without an explicit release the claim outlives the refusal for
	// the whole 30-minute TTL and pushes the next dispatch off a healthy account.
	await assert.rejects(
		() =>
			provider.start({
				prompt: [{ type: 'text', text: 'go' }],
				parent: { id: 'P1' },
				signal: new AbortController().signal,
			}),
		/amp executable not found/,
	)
	assert.deepEqual(released, ['R1'], 'the claim is released on the path that never published a run')
})

test('a prompt refused before selection never claims an account at all (review P1)', async () => {
	const { provider, pool } = makeProvider({ exitCode: 0 })
	const released = []
	const original = pool.release.bind(pool)
	pool.release = (ref) => {
		released.push(ref)
		return original(ref)
	}
	await assert.rejects(() =>
		provider.start({
			prompt: [{ type: 'image', data: 'x' }],
			parent: { id: 'P1' },
			signal: new AbortController().signal,
		}),
	)
	assert.deepEqual(released, [], 'nothing was claimed, so there is nothing to release')
})

test('the run id is unique across mounts, because an old run outlives the provider (review P2)', async () => {
	// Two `apply()` calls stand for a remount (HMR/loader reload): the first provider keeps a
	// run that is still live, and the seam contract promises the id is unique in the parent
	// namespace. A per-process counter restarts at 1 and hands out the SAME id again.
	const { providers } = makeProvider({ exitCode: 0 })
	const second = makeProvider({ exitCode: 0 })
	const all = [...providers, ...second.providers].filter((p) => p.name === 'amp-low')
	assert.equal(all.length, 2)
	const ids = []
	for (const provider of all) {
		const handle = await provider.start({
			prompt: [{ type: 'text', text: 'go' }],
			parent: { id: 'P1' },
			signal: new AbortController().signal,
		})
		ids.push(handle.id)
	}
	assert.equal(ids[0] === ids[1], false, 'two live runs of one parent must not share an id')
	assert.match(ids[1], /^dsh-amp-low-/, 'and it stays attributable to the mode that served it')
})

test('dispose() refuses to claim quiescence it could not prove (review P1)', async () => {
	// `waitForExit()` rejects only when the provider cannot prove the managed range is empty;
	// the seam contract says dispose() awaits teardown "to actual exit", so swallowing that
	// rejection makes dispose resolve while an orphan may still be running.
	const { provider } = makeProvider({ exitCode: 0, waitForExit: () => Promise.reject(new Error('owner observation failed')) })
	const handle = await provider.start({
		prompt: [{ type: 'text', text: 'go' }],
		parent: { id: 'P1' },
		signal: new AbortController().signal,
	})
	await assert.rejects(() => handle.dispose(), /owner observation failed/)
})

test('AMP-C1: a settings namespace that cannot be registered refuses dispatch instead of diverging', async () => {
	// Swallowing the registration error left TWO live truths: the settings page kept saving the
	// `dsh-amp` namespace while this row dispatched from the composition value the page never
	// reached. The failure is published (so the page goes read-only) and dispatch is refused.
	const { provider, pool } = makeProvider({ exitCode: 0, failSettings: true })
	assert.match(String(pool.settingsError), /could not be registered/)
	await assert.rejects(
		() =>
			provider.start({
				prompt: [{ type: 'text', text: 'go' }],
				parent: { id: 'P1' },
				signal: new AbortController().signal,
			}),
		/could not be registered/,
	)
})

test('AMP-C4: a COMMITTED settings change reaches the very next dispatch, even before its watcher runs', async () => {
	// `scope.get()` is the committed value; `watch()` is documented as an ASYNCHRONOUS observer.
	// The reviewed build dispatched from a mirror updated inside the watcher, so a run started in
	// the window between a commit and its callback used the previous configuration.
	const committed = { accountRefs: ['R1'] }
	const { provider, state } = makeProvider({ exitCode: 0, settingsValue: committed })
	committed.accountRefs = ['R2'] // committed; the watcher has NOT fired
	const handle = await provider.start({
		prompt: [{ type: 'text', text: 'go' }],
		parent: { id: 'P1' },
		signal: new AbortController().signal,
	})
	await handle.result
	assert.equal(state.spec.env.AMP_API_KEY, 'sgamp_R2', 'the dispatch used the committed value, not a stale mirror')
})

test('AMP-G2: dispose waits with a BOUND and reports unproven quiescence instead of hanging', async () => {
	let seenSignal
	const { provider } = makeProvider({
		exitCode: 0,
		waitForExit: (signal) => {
			seenSignal = signal
			// The seam's contract: `false` means the bound expired before the range emptied.
			return Promise.resolve(false)
		},
	})
	const handle = await provider.start({
		prompt: [{ type: 'text', text: 'go' }],
		parent: { id: 'P1' },
		signal: new AbortController().signal,
	})
	// `dispose()` is what performs the wait, so it runs first; the rejection is the contract.
	await assert.rejects(() => handle.dispose(), /UNPROVEN/)
	assert.ok(seenSignal instanceof AbortSignal, 'the wait is bounded by a caller-owned signal')
})

test('AMP-G5: an empty prompt never reaches selection or a spawn', async () => {
	const { provider, state, pool } = makeProvider({ exitCode: 0 })
	const released = []
	const original = pool.release.bind(pool)
	pool.release = (ref, token) => {
		released.push([ref, token])
		return original(ref, token)
	}
	await assert.rejects(
		() => provider.start({ prompt: [], parent: { id: 'P1' }, signal: new AbortController().signal }),
		/needs a non-empty prompt/,
	)
	assert.equal(state.spec, undefined, 'nothing was spawned')
	assert.deepEqual(released, [], 'and no account was claimed')
})
