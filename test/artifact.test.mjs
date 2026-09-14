import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'

import { createArtifactStore, pruneRuns } from '../lib/artifact.js'

function fixture(t) {
	const base = mkdtempSync(join(tmpdir(), 'dsh-amp-artifact-'))
	const root = join(base, 'runs')
	t.after(() => rmSync(base, { recursive: true, force: true }))
	return { base, root, store: createArtifactStore({ root }) }
}

test('default root follows DSH_HOME or the user .dsh directory', () => {
	const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
	assert.equal(createArtifactStore().root, join(home, 'state', 'dsh-amp', 'runs'))
})

test('open, append, checkpoint, and finalize preserve exact stream bytes', (t) => {
	const { store } = fixture(t)
	const handle = store.open('run-1', { mode: 'medium' })
	assert.notEqual(handle.ok, false)

	const text = `first line\n${'界'.repeat(70_000)}\nlast line`
	assert.deepEqual(store.append(handle, text), { ok: true, bytes: Buffer.byteLength(text) })
	assert.equal(store.checkpoint(handle, { phase: 27 }).ok, true)
	const final = store.finalize(handle, { outcome: 'partial', phase: 27 })

	assert.equal(final.ok, true)
	assert.equal(final.bytes, Buffer.byteLength(text))
	assert.equal(readFileSync(final.artifactPath, 'utf8'), text)
	assert.deepEqual(store.readCheckpoint('run-1'), { outcome: 'partial', phase: 27 })
	assert.deepEqual(store.pathOf('run-1'), {
		dir: join(store.root, 'run-1'),
		streamPath: join(store.root, 'run-1', 'stream.log'),
		checkpointPath: join(store.root, 'run-1', 'checkpoint.json'),
	})
})

test('append accumulates multiple segments in order', (t) => {
	const { store } = fixture(t)
	const handle = store.open('ordered')
	assert.equal(store.append(handle, 'alpha').ok, true)
	assert.equal(store.append(handle, 'βeta').ok, true)
	assert.equal(store.close(handle).ok, true)
	assert.equal(readFileSync(store.pathOf('ordered').streamPath, 'utf8'), 'alphaβeta')
})

test('checkpoint replacement exposes complete old and new JSON without temp remnants', (t) => {
	const { store } = fixture(t)
	const handle = store.open('atomic')
	const oldFacts = { phase: 'old', values: Array.from({ length: 1000 }, (_, index) => index) }
	const newFacts = { phase: 'new', values: Array.from({ length: 1000 }, (_, index) => 1000 - index) }

	assert.equal(store.checkpoint(handle, oldFacts).ok, true)
	assert.deepEqual(JSON.parse(readFileSync(handle.checkpointPath, 'utf8')), oldFacts)
	assert.equal(store.checkpoint(handle, newFacts).ok, true)
	assert.deepEqual(JSON.parse(readFileSync(handle.checkpointPath, 'utf8')), newFacts)
	assert.deepEqual(readdirSync(handle.dir).sort(), ['checkpoint.json', 'stream.log'])
	store.close(handle)
})

test('finalize is idempotent and does not rewrite its first outcome', (t) => {
	const { store } = fixture(t)
	const handle = store.open('final-once')
	store.append(handle, 'only once')

	const first = store.finalize(handle, { outcome: 'completed' })
	const second = store.finalize(handle, { outcome: 'should-not-replace' })

	assert.strictEqual(second, first)
	assert.equal(readFileSync(first.artifactPath, 'utf8'), 'only once')
	assert.deepEqual(store.readCheckpoint('final-once'), { outcome: 'completed' })
})

test('opening an existing run resumes append after previous bytes', (t) => {
	const { store } = fixture(t)
	const first = store.open('resume')
	store.append(first, 'before crash\n')
	store.close(first)

	const resumed = store.open('resume')
	assert.equal(resumed.bytes, Buffer.byteLength('before crash\n'))
	store.append(resumed, 'after restart\n')
	store.close(resumed)

	assert.equal(readFileSync(store.pathOf('resume').streamPath, 'utf8'), 'before crash\nafter restart\n')
	assert.deepEqual(store.list(), ['resume'])
})

test('runId validation rejects traversal, absolute paths, and separators without escaping root', (t) => {
	const { base, root } = fixture(t)
	const warnings = []
	const store = createArtifactStore({ root, logger: { warn: (message) => warnings.push(message) } })
	const outside = join(base, 'evil')

	for (const runId of ['../evil', '/abs/path', 'a/b', '.', '..', 'a\\b']) {
		const result = store.open(runId)
		assert.equal(result.ok, false, runId)
		assert.equal(typeof result.error, 'string')
	}

	assert.equal(statSync(base).isDirectory(), true)
	assert.equal(readdirSync(base).includes('evil'), false)
	assert.equal(readdirSync(base).includes('runs'), false)
	assert.equal(warnings.length, 6)
	assert.equal(outside.startsWith(base), true)
})

test('checkpoint and stream files have owner-only permissions', (t) => {
	const { store } = fixture(t)
	const handle = store.open('private')
	store.append(handle, 'secret')
	store.checkpoint(handle, { secret: true })

	assert.equal(statSync(handle.streamPath).mode & 0o777, 0o600)
	assert.equal(statSync(handle.checkpointPath).mode & 0o777, 0o600)
	store.close(handle)
})

test('an unusable root returns failures and warns instead of throwing', (t) => {
	const { base } = fixture(t)
	const rootFile = join(base, 'not-a-directory')
	writeFileSync(rootFile, 'occupied')
	const warnings = []
	const store = createArtifactStore({ root: rootFile, logger: { warn: (message) => warnings.push(message) } })

	let result
	assert.doesNotThrow(() => {
		result = store.open('blocked')
	})
	assert.equal(result.ok, false)
	assert.equal(typeof result.error, 'string')
	// Two failures are worth a voice here: the open itself, and the retention scan that cannot read
	// the root either. Silencing either one is how a broken root stays unnoticed.
	assert.equal(warnings.length, 2)
	assert.ok(warnings.some((message) => /open blocked/.test(message)), 'the open failure is reported')
	assert.ok(warnings.some((message) => /retention/.test(message)), 'and so is the unusable retention scan')
})

test('append failure preserves bytes already stored and returns the written count', (t) => {
	const { store } = fixture(t)
	const warnings = []
	const noisyStore = createArtifactStore({ root: store.root, logger: { warn: (message) => warnings.push(message) } })
	const handle = noisyStore.open('append-failure')
	assert.equal(noisyStore.append(handle, 'durable').ok, true)
	noisyStore.close(handle)

	const failed = noisyStore.append(handle, 'lost')
	assert.deepEqual({ ok: failed.ok, bytes: failed.bytes }, { ok: false, bytes: 0 })
	assert.equal(readFileSync(handle.streamPath, 'utf8'), 'durable')
	assert.equal(warnings.length, 1)
})

test('missing checkpoint returns undefined', (t) => {
	const { store } = fixture(t)
	assert.equal(store.readCheckpoint('missing'), undefined)
	const handle = store.open('opened-without-checkpoint')
	assert.equal(store.readCheckpoint('opened-without-checkpoint'), undefined)
	store.close(handle)
})

test('checkpoint serialization failures are contained and keep the previous version', (t) => {
	const { store } = fixture(t)
	const handle = store.open('bad-json')
	store.checkpoint(handle, { stable: true })
	const circular = {}
	circular.self = circular

	const result = store.checkpoint(handle, circular)
	assert.equal(result.ok, false)
	assert.deepEqual(store.readCheckpoint('bad-json'), { stable: true })
	assert.deepEqual(readdirSync(dirname(handle.checkpointPath)).sort(), ['checkpoint.json', 'stream.log'])
	store.close(handle)
})

// Every survivor below is written with a finished checkpoint: retention may only delete runs whose
// record says they finished. That rule is the point of these tests, not an inconvenience.
function makeRun(root, name, ageDays, { finished = true, corrupt = false, missing = false } = {}) {
	const dir = join(root, name)
	mkdirSync(dir, { recursive: true })
	if (missing !== true) {
		writeFileSync(join(dir, 'checkpoint.json'), corrupt ? '{ not json' : JSON.stringify({ finished }))
	}
	const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
	utimesSync(dir, when, when)
	return dir
}

test('retention: finished runs outside the window are pruned, the newest keepCount survive', async () => {
	const { existsSync } = await import('node:fs')
	const root = mkdtempSync(join(tmpdir(), 'dsh-amp-retention-'))
	try {
		const fresh = makeRun(root, 'fresh', 0.1)
		const old = makeRun(root, 'old', 30)
		const ancient = makeRun(root, 'ancient', 60)
		const result = pruneRuns(root, { keepDays: 7, keepCount: 1 })
		assert.equal(result.ok, true)
		assert.deepEqual(result.removed.sort(), ['ancient', 'old'])
		assert.equal(existsSync(fresh), true)
		assert.equal(existsSync(old), false)

		const many = []
		for (let index = 0; index < 6; index += 1) many.push(makeRun(root, `bulk-${String(index)}`, 90 + index))
		const second = pruneRuns(root, { keepDays: 0, keepCount: 3 })
		assert.equal(second.ok, true)
		assert.ok([fresh, ...many].filter((dir) => existsSync(dir)).length >= 3, 'the count floor wins over age')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('retention: a run that never finished is NEVER auto-deleted, however old it is', async () => {
	const { existsSync } = await import('node:fs')
	const root = mkdtempSync(join(tmpdir(), 'dsh-amp-retention-safe-'))
	try {
		// The three shapes rescue depends on: crashed, corrupt, and no record at all.
		const crashed = makeRun(root, 'crashed', 90, { finished: false })
		const corrupt = makeRun(root, 'corrupt', 90, { corrupt: true })
		const silent = makeRun(root, 'silent', 90, { missing: true })
		const disposable = makeRun(root, 'disposable', 90)

		const result = pruneRuns(root, { keepDays: 0, keepCount: 0 })
		assert.equal(result.ok, true)
		assert.deepEqual(result.removed, ['disposable'], 'only the run whose record says finished may go')
		assert.equal(result.protectedCount, 3, 'and the report says how many were protected')
		for (const dir of [crashed, corrupt, silent]) {
			assert.equal(existsSync(dir), true, 'a rescuer must still find this one')
		}
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('retention: a deletion that fails returns the reason instead of throwing', async () => {
	const { chmodSync } = await import('node:fs')
	const root = mkdtempSync(join(tmpdir(), 'dsh-amp-prune-fail-'))
	try {
		makeRun(root, 'stale-run', 30)
		chmodSync(root, 0o500) // nothing may be unlinked from an unwritable parent
		const result = pruneRuns(root, { keepDays: 1, keepCount: 0 })
		assert.equal(result.ok, false, 'a failed prune reports failure rather than throwing')
		assert.match(String(result.error), /prune stale-run/, 'and names which run and why')
	} finally {
		chmodSync(root, 0o700)
		rmSync(root, { recursive: true, force: true })
	}
})

test('retention: an unreadable root reports failure in the store error shape', async () => {
	const { chmodSync } = await import('node:fs')
	const root = mkdtempSync(join(tmpdir(), 'dsh-amp-prune-root-'))
	try {
		chmodSync(root, 0o000)
		const result = pruneRuns(root, {})
		assert.equal(result.ok, false, 'pretending success here hid an unreadable root')
		assert.match(String(result.error), /list runs for prune/)
	} finally {
		chmodSync(root, 0o700)
		rmSync(root, { recursive: true, force: true })
	}
})

test('retention: when the budget forces a choice, a FAILED run survives over a successful one', async () => {
	const { existsSync } = await import('node:fs')
	const root = mkdtempSync(join(tmpdir(), 'dsh-amp-retention-failures-'))
	const write = (name, ageDays, failure) => {
		const dir = join(root, name)
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ finished: true, failure }))
		const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
		utimesSync(dir, when, when)
		return dir
	}
	try {
		const oldFailure = write('old-failure', 90, { kind: 'credits' })
		const oldSuccess = write('old-success', 89, null)
		const recentSuccess = write('recent-success', 0.1, null)

		const result = pruneRuns(root, { keepDays: 7, keepCount: 1 })
		assert.equal(result.ok, true)
		assert.ok(result.removed.includes('old-success'), 'the oldest SUCCESS is what goes')
		assert.equal(existsSync(oldFailure), true, 'the record of a failure is worth more than one more success')
		assert.equal(existsSync(recentSuccess), true, 'the newest always survives')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('retention: many old failures must not evict out-of-window successes', async () => {
	const { existsSync } = await import('node:fs')
	const root = mkdtempSync(join(tmpdir(), 'dsh-amp-retention-budgets-'))
	const write = (name, ageDays, failure) => {
		const dir = join(root, name)
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ finished: true, failure }))
		const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000)
		utimesSync(dir, when, when)
		return dir
	}
	try {
		// The reviewer's counterexample: failures outnumber the shared budget.
		const failures = ['f1', 'f2', 'f3'].map((name, index) => write(name, 90 + index, { kind: 'credits' }))
		const successes = ['s1', 's2'].map((name, index) => write(name, 90 + index, null))

		const result = pruneRuns(root, { keepDays: 7, keepCount: 2 })
		assert.equal(result.ok, true)
		// Each group keeps its own newest two.
		assert.equal(successes.filter((dir) => existsSync(dir)).length, 2, 'successes are not starved by failures')
		assert.equal(failures.filter((dir) => existsSync(dir)).length, 2, 'failures keep their own budget')
		assert.equal(result.removed.length, 1, 'and only the oldest failure goes')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('AMP-R4: two stores cannot share one key in the same millisecond', (t) => {
	// The key used to be `${runId}-${Date.now()}`, and `runId` restarts at run-1 in every
	// process — so two hosts sharing one DSH_HOME that opened their first run in the same
	// millisecond wrote into ONE directory. One host's prune then deleted the other's live
	// record: the survivor's append "succeeded" into an unlinked inode and its next checkpoint
	// failed with ENOENT.
	const { root, store } = fixture(t)

	// The reviewed shape, for the record: one millisecond + one run id = one directory.
	const legacyA = store.open('dsh-amp-run-1-1700000000000', { mode: 'low' })
	const legacyB = store.open('dsh-amp-run-1-1700000000000', { mode: 'low' })
	assert.equal(legacyA.dir, legacyB.dir, 'without a pid/uuid the two hosts collide — the bug')

	// The shipped shape adds pid + uuid, so the same millisecond is no longer an identity.
	const a = store.open('dsh-amp-run-1-1700000000000-111-aaaaaaaa', { mode: 'low' })
	const b = store.open('dsh-amp-run-1-1700000000000-222-bbbbbbbb', { mode: 'low' })
	assert.notEqual(a.ok, false, 'the store opened its own directory')
	assert.notEqual(b.ok, false, 'and the second store opened a DIFFERENT one')
	assert.notEqual(a.dir, b.dir, 'a pid and a uuid keep two processes apart')

	// A finishes and its record is old enough to prune; the LIVE record must survive it.
	assert.equal(store.finalize(a, { finished: true, status: 'completed' }).ok, true)
	const pruned = pruneRuns(root, { keepDays: 0, keepCount: 0, now: Date.now() + 100000 })
	assert.equal(pruned.removed.includes(basename(a.dir)), true, 'the finished record is collectable')
	assert.equal(pruned.removed.includes(basename(b.dir)), false, 'the other run is still live and is NEVER removed')
	assert.equal(store.append(b, 'still working').ok, true)
	assert.equal(store.checkpoint(b, { finished: false }).ok, true, 'and its record keeps working')
})

test('AMP-G7: listDetailed reports each run with the mtime a caller needs to order same-epoch keys', (t) => {
	const { store } = fixture(t)
	store.open('dsh-amp-run-1-1700000000000-111-aaaaaaaa', { mode: 'low' })
	store.open('dsh-amp-run-9-1700000000000', { mode: 'low' })
	const rows = store.listDetailed()
	assert.equal(rows.length, 2)
	for (const row of rows) {
		assert.equal(typeof row.name, 'string')
		assert.equal(typeof row.dir, 'string')
		assert.equal(typeof row.mtimeMs, 'number')
		assert.ok(Number.isFinite(row.mtimeMs) && row.mtimeMs > 0)
	}
	assert.deepEqual(store.listDetailed().map((row) => row.name), store.list(), 'same set as list()')
})
