/**
 * Composition smoke — no agent run, no credit spent.
 *
 * The unit tests build the live tools directly, so they cannot see drift in the ROW that mounts
 * them: a renamed export, a missing inject, a tool that stopped being registered, a schema whose
 * required field changed. This file applies the real agent-plane row and inspects the surface.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const plugin = await import('../lib/live-plugin.js')

function mount(config) {
	const registered = new Map()
	const services = new Map()
	const ctx = {
		logger: { info() {}, warn() {} },
		effect(fn) {
			fn()
			return () => {}
		},
		inject(deps, callback) {
			if (typeof callback === 'function') callback({ get: () => undefined })
		},
		provide(name, value) {
			services.set(name, value)
		},
		get(name) {
			if (name === 'tools') {
				return {
					register(tool) {
						registered.set(tool.name, tool)
						return () => {}
					},
				}
			}
			if (name === 'jobs') {
				// Faithful to the registry: `start()` decides admission first and only then
				// invokes `run()`, which is where the producer creates its execution resources.
				return { start: (spec) => { spec.run(); return 'job-1' } }
			}
			return services.get(name)
		},
		subprocess: { async resolveExecutable(bin) { return bin } },
		credentials: { async resolve() { return { value: 'sgamp_redacted' } } },
	}
	plugin.apply(ctx, config)
	return registered
}

test('the agent row mounts exactly the documented tool surface', () => {
	const tools = mount({ accountRefs: ['R1'], modes: ['low', 'medium'] })
	assert.deepEqual(
		[...tools.keys()].sort(),
		['amp_accounts', 'amp_run', 'amp_runs', 'amp_send_message', 'amp_stop'],
		'the preset grants these five and nothing else',
	)
})

test('the two dispatch tools still require their identifying argument', () => {
	const tools = mount({ accountRefs: ['R1'], modes: ['low'] })
	const run = tools.get('amp_run')
	const send = tools.get('amp_send_message')
	assert.equal(run.parameters.required.includes('prompt'), true, 'amp_run without a prompt is meaningless')
	assert.equal(send.parameters.required.includes('run'), true, 'amp_send_message without a run is meaningless')
	for (const tool of tools.values()) {
		assert.equal(typeof tool.execute, 'function', `${tool.name} must be executable`)
		assert.equal(typeof tool.description, 'string', `${tool.name} must describe itself to a model`)
	}
})

test('the agent row follows a settings change instead of freezing at mount', async () => {
	const registered = new Map()
	const services = new Map()
	const listeners = []
	const ctx = {
		logger: { info() {}, warn() {} },
		effect(fn) {
			fn()
			return () => {}
		},
		inject(deps, callback) {
			// The host row's service is exposed on this fake ctx; the callback context must see it.
			if (typeof callback === 'function') callback({ get: (name) => ctx.get(name) })
		},
		provide(name, value) {
			services.set(name, value)
		},
		get(name) {
			if (name === 'tools') {
				return { register(tool) { registered.set(tool.name, tool); return () => {} } }
			}
			// The host row's subscription service, as index.js provides it.
			if (name === 'ampSettings') {
				return {
					current: () => ({}),
					subscribe: (listener) => {
						listeners.push(listener)
						return () => {}
					},
				}
			}
			if (name === 'jobs') {
				// Faithful to the registry: `start()` decides admission first and only then
				// invokes `run()`, which is where the producer creates its execution resources.
				return { start: (spec) => { spec.run(); return 'job-1' } }
			}
			return services.get(name)
		},
		subprocess: { async resolveExecutable(bin) { return bin } },
		credentials: { async resolve() { return { value: 'sgamp_redacted' } } },
	}
	plugin.apply(ctx, { accountRefs: ['R1'], modes: ['low'], ampBin: '/first/amp' })
	assert.equal(listeners.length, 1, 'the row subscribes to the resolved-config feed')

	// A settings edit reaches the running row…
	listeners[0]({ accountRefs: ['R2'], modes: ['low'], ampBin: '/second/amp', graceMs: 1000 })
	// …and the TOOL that was already registered must resolve the new binary, not the mounted one.
	const spawned = []
	ctx.subprocess.resolveExecutable = async (bin) => {
		spawned.push(bin)
		return bin
	}
	ctx.subprocess.spawn = () => ({
		stdin: { write() {}, end() {} },
		done: Promise.resolve({ exitCode: 0 }),
		collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) } },
		terminate() {},
		waitForExit: () => Promise.resolve(true),
	})
	await registered.get('amp_run').execute({ prompt: 'hello', mode: 'low' }, { agent: { id: 'A1' } })
	assert.deepEqual(spawned, ['/second/amp'], 'the registered tool reads the live value at call time')
})

test('a missing settings service is announced, not silently frozen', async () => {
	const warnings = []
	const registered = new Map()
	const ctx = {
		logger: { info() {}, warn: (message) => warnings.push(message) },
		effect(fn) {
			fn()
			return () => {}
		},
		inject(deps, callback) {
			if (typeof callback === 'function') callback({ get: () => undefined })
		},
		get(name) {
			if (name === 'tools') {
				return { register(tool) { registered.set(tool.name, tool); return () => {} } }
			}
			if (name === 'jobs') {
				// Faithful to the registry: `start()` decides admission first and only then
				// invokes `run()`, which is where the producer creates its execution resources.
				return { start: (spec) => { spec.run(); return 'job-1' } }
			}
			return undefined
		},
		subprocess: { async resolveExecutable(bin) { return bin } },
		credentials: { async resolve() { return { value: 'sgamp_redacted' } } },
	}
	assert.doesNotThrow(() => plugin.apply(ctx, { accountRefs: ['R1'], modes: ['low'] }))
	assert.equal(registered.size, 5, 'the tools still mount')
	assert.ok(
		warnings.some((message) => /settings stay frozen at mount/.test(message)),
		'and the degradation is visible in the log instead of being silent',
	)
})

test('a settings change between mount and subscribe is not lost', async () => {
	const registered = new Map()
	let listener
	const ctx = {
		logger: { info() {}, warn() {} },
		effect(fn) {
			fn()
			return () => {}
		},
		inject(deps, callback) {
			if (typeof callback === 'function') {
				callback({
					get: () => ({
						// The host already moved on before this row got to subscribe.
						current: () => ({ accountRefs: ['R1'], modes: ['low'], ampBin: '/changed/amp' }),
						subscribe: (cb) => {
							listener = cb
							return () => {}
						},
					}),
				})
			}
		},
		get(name) {
			if (name === 'tools') {
				return { register(tool) { registered.set(tool.name, tool); return () => {} } }
			}
			if (name === 'jobs') {
				// Faithful to the registry: `start()` decides admission first and only then
				// invokes `run()`, which is where the producer creates its execution resources.
				return { start: (spec) => { spec.run(); return 'job-1' } }
			}
			return undefined
		},
		subprocess: { async resolveExecutable(bin) { return bin } },
		credentials: { async resolve() { return { value: 'sgamp_redacted' } } },
	}
	plugin.apply(ctx, { accountRefs: ['R1'], modes: ['low'], ampBin: '/mounted/amp' })
	assert.equal(typeof listener, 'function', 'the subscription is established')

	const spawned = []
	ctx.subprocess.spawn = (spec) => {
		spawned.push(spec.argv[0])
		return {
			stdin: { write() {}, end() {} },
			done: Promise.resolve({ exitCode: 0 }),
			collected: { stdout: { readFrom: () => ({ text: '', lossy: false }) }, stderr: { readFrom: () => ({ text: '', lossy: false }) } },
			terminate() {},
			waitForExit: () => Promise.resolve(true),
		}
	}
	ctx.subprocess.resolveExecutable = async (bin) => {
		spawned.push(bin)
		return bin
	}
	await registered.get('amp_run').execute({ prompt: 'hello', mode: 'low' }, { agent: { id: 'A1' } })
	assert.ok(spawned.some((value) => value === '/changed/amp'), 'the reconcile at subscribe time wins over the mount snapshot')
})
