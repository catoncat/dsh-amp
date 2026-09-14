/**
 * dsh-amp web-route contract tests.
 *
 * This file exists because the browser half and the host half disagreed about one field:
 * the page gates every edit on `allRefsAvailable`, and the route never sent it, so the
 * accounts page was permanently read-only while telling the user the session could not
 * edit. The route side is exercised for real below; the browser side cannot be imported
 * here (it is a `window.__ModuleLoader__` factory), so its half of the contract is
 * locked statically — a rename on either side must fail this suite.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const { registerAccountRoutes } = await import('../lib/web.js')

function install(pool) {
	let route
	const serverCtx = {
		webServer: {
			register(config) {
				route = config
				return () => {}
			},
		},
		effect(fn) {
			fn()
			return () => {}
		},
	}
	const ctx = {
		inject(deps, callback) {
			if (deps.includes('webServer')) callback(serverCtx)
		},
		effect(fn) {
			fn()
			return () => {}
		},
	}
	registerAccountRoutes(ctx, pool)
	return route
}

function get(route, overrides = {}) {
	return new Promise((resolve) => {
		const req = {
			url: '/api/dsh-amp/accounts',
			method: 'GET',
			headers: { 'x-dsh-amp': '1', host: '127.0.0.1:3080' },
			socket: { remoteAddress: '127.0.0.1' },
			...overrides,
		}
		const res = {
			statusCode: undefined,
			written: undefined,
			writeHead(code) {
				this.statusCode = code
			},
			end(text) {
				this.written = text
				resolve({ status: this.statusCode, body: JSON.parse(text) })
			},
		}
		void route.handler(req, res)
	})
}

test('the route tells the page whether the full ref list is trustworthy', async () => {
	const route = install({
		list: async () => ({ total: 3, shown: 2, rows: [{ ref: 'A' }, { ref: 'B' }] }),
		allRefs: () => ['A', 'B', 'C'],
		source: { file: '/installed/lib/index.js', hash: 'abcdef123456', drift: 'STALE' },
	})
	const { status, body } = await get(route)
	assert.equal(status, 200)
	assert.deepEqual(body.allRefs, ['A', 'B', 'C'])
	assert.equal(body.allRefsAvailable, true, 'the page stays editable only when this is true')
	assert.equal(body.source.drift, 'STALE', 'U6: the page can say the build it shows is stale')
})

test('a truncated ref list must NOT be advertised as available', async () => {
	const route = install({
		list: async () => ({ total: 3, shown: 2, rows: [{ ref: 'A' }, { ref: 'B' }] }),
		allRefs: () => ['A', 'B'],
	})
	const { body } = await get(route)
	assert.equal(body.allRefsAvailable, false, 'writing this list back would delete account C')
})

test('a pool that cannot enumerate refs must NOT be advertised as available', async () => {
	const route = install({
		list: async () => ({ total: 3, shown: 2, rows: [{ ref: 'A' }, { ref: 'B' }] }),
	})
	const { body } = await get(route)
	assert.deepEqual(body.allRefs, [])
	assert.equal(body.allRefsAvailable, false)
})

test('the account view is refused for anything but the local UI', async () => {
	const route = install({ list: async () => ({ total: 0, shown: 0, rows: [] }) })
	const foreign = await get(route, { socket: { remoteAddress: '10.0.0.9' } })
	assert.equal(foreign.status, 403)
	const noHeader = await get(route, { headers: { host: '127.0.0.1:3080' } })
	assert.equal(noHeader.status, 403)
	const badOrigin = await get(route, { headers: { 'x-dsh-amp': '1', host: '127.0.0.1:3080', origin: 'http://evil.test' } })
	assert.equal(badOrigin.status, 403)
})

test('static contract lock: both halves name the same gate field', () => {
	const web = readFileSync(new URL('../lib/web.js', import.meta.url), 'utf8')
	const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
	assert.match(web, /allRefsAvailable/, 'the route must send the field')
	assert.match(client, /body\.allRefsAvailable/, 'the page must gate on that exact field')
	assert.match(web, /source: pool\.source/, 'the route must send the build it is running')
	assert.match(client, /source\.drift === 'STALE'/, 'the page must surface a stale build')
	assert.match(client, /driftUnknown/, 'and must not let "cannot compare" read as "confirmed current"')
})

test('the route asks the POOL which account is next, instead of letting the page re-derive it', async () => {
	const asked = []
	const probes = []
	const route = install({
		list: async () => ({ total: 2, shown: 2, rows: [{ ref: 'A', exhausted: false }, { ref: 'B', exhausted: true }] }),
		allRefs: () => ['A', 'B'],
		preview: async (options) => {
			asked.push(options.mode)
			probes.push(options.probe)
			return { ref: 'B', state: 'assumed', remaining: 5 }
		},
		source: { hash: 'x', modules: {}, drift: 'in-sync' },
	})
	const { status, body } = await get(route)
	assert.equal(status, 200)
	assert.deepEqual(asked, ['low', 'medium'], 'the pool is asked per mode, on the side that owns the rule')
	assert.deepEqual(probes, [false, false], 'and the page asks for a FREE preview: rendering must not probe')
	assert.equal(body.next.byMode.medium.ref, 'B', 'and its answer travels to the page')
	assert.equal(body.next.byMode.medium.state, 'assumed')
})

test('a pool that cannot answer choose still renders the page', async () => {
	const route = install({
		list: async () => ({ total: 1, shown: 1, rows: [{ ref: 'A', exhausted: false }] }),
		allRefs: () => ['A'],
		source: { hash: 'x', modules: {}, drift: 'in-sync' },
	})
	const { status, body } = await get(route)
	assert.equal(status, 200, 'a missing pool method must not break the page')
	assert.deepEqual(body.next, { byMode: {} })
})

test('the settings page must PREVIEW the next account, never claim it', async () => {
	let chose = 0
	const route = install({
		list: async () => ({ total: 2, shown: 2, rows: [{ ref: 'A', exhausted: false }, { ref: 'B', exhausted: false }] }),
		allRefs: () => ['A', 'B'],
		preview: async (options) => ({ ref: options.mode === 'low' ? 'B' : 'A', state: 'ledger', remaining: 5 }),
		choose: async () => {
			chose += 1
			return { ref: 'A', state: 'ledger', remaining: 5 }
		},
		source: { hash: 'x', modules: {}, drift: 'in-sync' },
	})
	const { status, body } = await get(route)
	assert.equal(status, 200)
	assert.equal(chose, 0, 'rendering the page must not take an in-flight claim')
	assert.equal(body.next.byMode.medium.ref, 'A', 'the preview still answers')
	assert.equal(body.next.byMode.low.ref, 'B')

	// A pool with no preview reports nothing rather than falling back to a claiming call.
	const legacy = install({
		list: async () => ({ total: 1, shown: 1, rows: [{ ref: 'A', exhausted: false }] }),
		allRefs: () => ['A'],
		choose: async () => {
			chose += 1
			return { ref: 'A', state: 'ledger', remaining: 5 }
		},
		source: { hash: 'x', modules: {}, drift: 'in-sync' },
	})
	const second = await get(legacy)
	assert.equal(second.status, 200)
	assert.equal(chose, 0, 'no preview available means no claim taken')
	assert.deepEqual(second.body.next, { byMode: {} })
})

test('the page does not claim editing is unavailable while it is still loading', async () => {
	const { readFileSync } = await import('node:fs')
	const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
	// `canEdit` is false during the loading phase, so an ungated note told the user "restart the
	// harness" before the page had even fetched anything. The note must be gated on a ready body.
	assert.match(
		client,
		/: phase\.kind === 'ready'[\s\S]{0,160}t\('editingUnavailable'\)/,
		'the editing note is rendered only once the body is ready',
	)
})

test('AMP-C1: the route publishes a settings failure so the page goes read-only', async () => {
	// When the settings namespace cannot be registered, the page must not keep offering a save
	// that lands nowhere. The route is the only channel that can tell the browser half.
	const pool = {
		source: { file: '/tmp/lib/index.js', hash: 'abc', modules: {} },
		settingsError: 'the "dsh-amp" settings namespace could not be registered (already registered)',
		async list() {
			return { total: 1, shown: 1, rows: [{ ref: 'A', remaining: 5 }] }
		},
		allRefs: () => ['A'],
		preview: async () => undefined,
	}
	const { body } = await get(install(pool))
	assert.equal(body.settingsError, pool.settingsError)

	// And without one, the field is simply absent — the page must not be gated forever.
	const healthy = { ...pool, settingsError: undefined }
	const { body: healthyBody } = await get(install(healthy))
	assert.equal(healthyBody.settingsError, undefined)
})

test('AMP-C7: the browser half builds `write` from the nested Remote, never assuming it exists', () => {
	// `dsh.client.inject` guarantees packages, not Cordis services: the top-level `remote` can be
	// there while `remote.settings` is still mounting. The old factory called
	// `ctx.remote.settings.update(...)` unconditionally, and that throws SYNCHRONOUSLY — before
	// returning a promise — so the caller's `.catch` never saw it and the page stayed busy.
	const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
	assert.match(source, /ctx\.get\('remote\.settings'\)/, 'the write half is resolved through ctx.get')
	assert.equal(/=\s*\(refs\)\s*=>\s*ctx\.remote\.settings\.update/u.test(source), false, 'and the unguarded call site is gone')
	assert.match(source, /typeof settingsRemote\.update === 'function'/, 'a missing Remote degrades to read-only')
	// A settings failure published by the host row also disables editing.
	assert.match(source, /settingsError/, 'the page shows the reason instead of offering a save that lands nowhere')
})

test('AMP-G4: the route passes an explicit limit=0 through as "all"', async () => {
	const seen = []
	const pool = {
		async list(options) {
			seen.push(options)
			return { total: 3, shown: 3, rows: [] }
		},
		allRefs: () => ['A', 'B', 'C'],
		preview: async () => undefined,
	}
	const route = install(pool)
	await get(route, { url: '/api/dsh-amp/accounts?limit=0' })
	assert.equal(seen.at(-1).limit, 0, '0 means all, and the pool only sees that if it is forwarded')
	await get(route)
	assert.equal(seen.at(-1).limit, 12, 'no parameter keeps the default page size')

	// The browser half must ask for 0 too: `undefined` means "default slice" on both sides.
	const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
	assert.match(client, /load\(0, false\)/, 'the show-all button asks for every account')
	assert.equal(/load\(undefined, false\)/u.test(client), false, 'and no longer asks for the default slice')
})
