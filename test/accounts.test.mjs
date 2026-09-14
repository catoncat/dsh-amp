/**
 * dsh-amp account-pool selection tests.
 *
 * The rule under test is the one this deployment learned the hard way: `$1` is a
 * PREFERENCE, not a gate. Measured on the real CLI, a `low` run started on an account
 * holding $0.90 while `medium` on the same account was refused — so a pool that skipped
 * below-floor accounts would refuse work Amp would have accepted, and a pool that
 * trusted a stale reading would dispatch onto an exhausted account.
 *
 * No DSH dependency: the pool talks to `ctx.credentials`, `ctx.subprocess` and a ledger
 * file, so a fake ctx and a seeded ledger file are enough.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { createAccountPool } = await import('../lib/accounts.js')
const { createLedger, MIN_START_CREDITS } = await import('../lib/ledger.js')

const USAGE = (credits) => `Signed in as someone@example.test\n**Individual credits:** $${credits.toFixed(2)} remaining (set up auto-reload)\n`

function harness({ refs, accounts = {}, tokens, usage = {}, failing = new Set(), hanging = new Set() }) {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-amp-pool-'))
	const file = join(dir, 'ledger.json')
	writeFileSync(file, JSON.stringify({ version: 1, accounts }))
	const ledger = createLedger(file, { warn() {} })
	const spawns = []
	const resolvedTokens = tokens ?? Object.fromEntries(refs.map((ref) => [ref, `sgamp_TOKEN_${ref}`]))
	const ctx = {
		logger: { warn() {}, info() {} },
		credentials: {
			async resolve(ref) {
				return resolvedTokens[ref] === undefined ? undefined : { value: resolvedTokens[ref] }
			},
		},
		subprocess: {
			async resolveExecutable(bin) {
				return bin
			},
			spawn(spec) {
				spawns.push(spec)
				const token = spec.env.AMP_API_KEY
				const text = usage[token] ?? USAGE(5)
				if (hanging.has(token)) {
					// A probe that never reports an exit: the shape a DNS/proxy/upstream stall takes.
					// The seam only reacts to the caller's `signal`, so the pool must own the deadline.
					const done = new Promise((_, reject) => {
						spec.signal?.addEventListener('abort', () => reject(new Error('amp usage timed out')), { once: true })
					})
					return {
						done,
						collected: {
							stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
							stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
						},
						terminate() {},
						waitForExit: () => Promise.resolve(true),
					}
				}
				return {
					done: Promise.resolve({ exitCode: failing.has(token) ? 1 : 0 }),
					collected: {
						stdout: { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) },
						stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
					},
					terminate() {},
					waitForExit: () => Promise.resolve(true),
				}
			},
		},
	}
	const pool = createAccountPool(ctx, () => ({ accountRefs: refs, ampBin: 'amp' }), ledger)
	return {
		pool,
		spawns,
		ledger,
		fresh: (checkedAt = Date.now()) => ({ remaining: 0, readable: true, exhausted: false, checkedAt }),
		seed: (ref, remaining, extra = {}) => {
			const record = { remaining, readable: true, exhausted: remaining === 0, checkedAt: Date.now(), ...extra }
			writeFileSync(file, JSON.stringify({ version: 1, accounts: { ...accounts, [ref]: record } }))
			return createLedger(file, { warn() {} })
		},
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	}
}

test('a funded account beats a below-floor one', async () => {
	const h = harness({
		refs: ['A', 'B'],
		accounts: {
			A: { remaining: 0.9, readable: true, exhausted: false, checkedAt: Date.now() },
			B: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() },
		},
	})
	try {
		const pick = await h.pool.choose()
		assert.equal(pick.ref, 'B')
		assert.equal(pick.state, 'ledger')
	} finally {
		h.cleanup()
	}
})

test('a below-floor account is still dispatched when nothing better exists (the whole point)', async () => {
	const h = harness({
		refs: ['A'],
		accounts: { A: { remaining: 0.9, readable: true, exhausted: false, checkedAt: Date.now() } },
	})
	try {
		const pick = await h.pool.choose()
		assert.equal(pick.ref, 'A', 'refusing here would reject work Amp accepts in low mode')
		assert.match(pick.state, /below-floor/)
		assert.match(pick.detail, /\$1 floor this mode needs/)
	} finally {
		h.cleanup()
	}
})

test('an empty account is skipped, and a token-less ref never wins', async () => {
	const h = harness({
		refs: ['EMPTY', 'NOTOKEN', 'OK'],
		accounts: {
			EMPTY: { remaining: 0, readable: true, exhausted: true, checkedAt: Date.now() },
			OK: { remaining: 3, readable: true, exhausted: false, checkedAt: Date.now() },
		},
		tokens: { EMPTY: 'sgamp_E', NOTOKEN: '', OK: 'sgamp_O' },
	})
	try {
		const pick = await h.pool.choose()
		assert.equal(pick.ref, 'OK')
	} finally {
		h.cleanup()
	}
})

test('a stale reading is re-read instead of trusted', async () => {
	const h = harness({
		refs: ['A'],
		// checkedAt 0 = ancient, so selection must confirm this one against the remote.
		accounts: { A: { remaining: 4, readable: true, exhausted: false, checkedAt: 0 } },
		usage: { sgamp_TOKEN_A: USAGE(0) },
	})
	try {
		assert.equal(h.pool.stale('A'), true)
		await assert.rejects(() => h.pool.choose(), /no account can start a run/)
		assert.equal(h.spawns.length, 1, 'exactly one confirmation read')
	} finally {
		h.cleanup()
	}
})

test('a throttle is remembered for its own window, then the other account is used', async () => {
	const h = harness({
		refs: ['A', 'B'],
		accounts: {
			A: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() },
			B: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() },
		},
	})
	try {
		assert.equal((await h.pool.choose()).ref, 'A')
		await h.pool.noteRefusal('A', { kind: 'rate-limit', retryAfterMs: 60_000 })
		assert.ok(h.pool.coolingUntil('A') > Date.now())
		const pick = await h.pool.choose()
		assert.equal(pick.ref, 'B', 'the mechanism waits out the throttle instead of handing it to the agent')
	} finally {
		h.cleanup()
	}
})

test('a credit refusal forces that account to be re-read', async () => {
	const h = harness({
		refs: ['A', 'B'],
		accounts: {
			A: { remaining: 4, readable: true, exhausted: false, checkedAt: Date.now() },
			B: { remaining: 4, readable: true, exhausted: false, checkedAt: Date.now() },
		},
		usage: { sgamp_TOKEN_A: USAGE(0.2) },
	})
	try {
		const before = h.spawns.length
		const reading = await h.pool.noteRefusal('A', { kind: 'credits' })
		assert.equal(h.spawns.length, before + 1, 'the stale number is replaced by a reading')
		assert.equal(reading.ok, true)
		assert.equal(h.ledger.remaining('A'), 0.2)
		const pick = await h.pool.choose()
		assert.equal(pick.ref, 'B', 'the account just proven below the floor is skipped, not retried')
	} finally {
		h.cleanup()
	}
})

test('a readable-but-unmeasurable account must not monopolize either (review finding)', async () => {
	// The reading succeeds but says nothing about money. Returning it eagerly re-creates the
	// same monopoly one branch over, and an upstream wording change would trigger it for the
	// whole pool — so it is a FALLBACK, not a winner.
	const h = harness({
		refs: ['NA', 'B'],
		accounts: { B: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() } },
		usage: { sgamp_TOKEN_NA: 'Signed in as someone@example.test\n' },
	})
	try {
		const pick = await h.pool.choose()
		assert.equal(pick.ref, 'B', 'an account we can measure beats one we cannot')
	} finally {
		h.cleanup()
	}
})

test('an unmeasurable-but-readable account is dispatched when it is all there is', async () => {
	const h = harness({
		refs: ['NA'],
		usage: { sgamp_TOKEN_NA: 'Signed in as someone@example.test\n' },
	})
	try {
		const pick = await h.pool.choose()
		assert.equal(pick.ref, 'NA')
		assert.equal(pick.state, 'confirmed-no-amount')
	} finally {
		h.cleanup()
	}
})

const { floorForMode, headroomForMode, MODE_HEADROOM } = await import('../lib/ledger.js')
const { FRESH_ACCOUNT_CREDITS } = await import('../lib/ledger.js')

test('the floor still decides which modes may run, and headroom decides which account', async () => {
	const h = harness({
		refs: ['A', 'B'],
		accounts: {
			A: { remaining: 0.9, readable: true, exhausted: false, checkedAt: Date.now() },
			B: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() },
		},
	})
	try {
		// No mode's bar may sit below the server's own start gate: a run that starts at $0.90 gets
		// refused mid-conversation once the balance dips under $1 (measured), so $0.90 is not
		// headroom for ANY mode and the funded account wins both.
		assert.equal((await h.pool.choose({ mode: 'low' })).ref, 'B', 'low still needs to clear the $1 gate')
		assert.equal((await h.pool.choose({ mode: 'medium' })).ref, 'B', 'medium needs $4 of measured headroom')
	} finally {
		h.cleanup()
	}
})

test('preference, not a gate: a below-floor account is still dispatched when it is all there is', async () => {
	const h = harness({
		refs: ['A'],
		accounts: { A: { remaining: 0.1, readable: true, exhausted: false, checkedAt: Date.now() } },
	})
	try {
		const pick = await h.pool.choose({ mode: 'medium' })
		assert.equal(pick.ref, 'A', 'refusing here would reject work Amp might still accept')
		assert.match(pick.state, /below-floor/)
	} finally {
		h.cleanup()
	}
})

test('$0.90 is NOT headroom for low: it clears the floor but not the start gate', async () => {
	const h = harness({
		refs: ['A'],
		accounts: { A: { remaining: 0.9, readable: true, exhausted: false, checkedAt: Date.now() } },
	})
	try {
		const pick = await h.pool.choose({ mode: 'low' })
		assert.equal(pick.ref, 'A', 'preference, not a gate — it is still used when it is all there is')
		assert.match(pick.state, /below-start-gate/, 'but the caveat is attached: $0.90 is under the gate the server enforces')
	} finally {
		h.cleanup()
	}
})

test('U3: an unknown mode takes the conservative default', () => {
	assert.equal(floorForMode('low'), 0)
	assert.equal(floorForMode('medium'), 1)
	assert.equal(floorForMode('high'), 1)
	assert.equal(floorForMode('telepathic'), 1)
	assert.equal(floorForMode(undefined), 1)
})

test('an unreadable account must NOT monopolize dispatch (review finding)', async () => {
	// [A] cannot be read at all; [B] is confirmed funded. Returning [A] eagerly would starve
	// [B] on every single dispatch AND pay a wasted remote read each time.
	const h = harness({
		refs: ['A', 'B'],
		accounts: { B: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() } },
		failing: new Set(['sgamp_TOKEN_A']),
	})
	try {
		const pick = await h.pool.choose()
		assert.equal(pick.ref, 'B', 'a confirmed account beats an unreadable one')
		assert.equal(pick.state, 'ledger')
		assert.equal(h.spawns.length, 1, 'exactly the one confirm the unreadable account cost')
	} finally {
		h.cleanup()
	}
})

test('an unreadable account is still dispatched when it is all there is (fail-open kept)', async () => {
	const h = harness({ refs: ['A'], failing: new Set(['sgamp_TOKEN_A']) })
	try {
		const pick = await h.pool.choose()
		assert.equal(pick.ref, 'A', 'a failed reading is not evidence of an empty account')
		assert.equal(pick.state, 'unreadable')
	} finally {
		h.cleanup()
	}
})

test('probing is bounded: a pool of unknowns cannot cost one read per account', async () => {
	const refs = ['A', 'B', 'C', 'D', 'E']
	const h = harness({ refs, failing: new Set(refs.map((ref) => `sgamp_TOKEN_${ref}`)) })
	try {
		const pick = await h.pool.choose()
		assert.equal(h.spawns.length, 3, 'MAX_CONFIRM_READS caps the round trips per dispatch')
		assert.ok(refs.includes(pick.ref))
	} finally {
		h.cleanup()
	}
})

test('a known below-floor account is preferred over an unreadable one', async () => {
	// Both are "dispatch anyway" candidates; the one we can actually measure wins.
	const h = harness({
		refs: ['UNREADABLE', 'LOW'],
		accounts: { LOW: { remaining: 0.5, readable: true, exhausted: false, checkedAt: Date.now() } },
		failing: new Set(['sgamp_TOKEN_UNREADABLE']),
	})
	try {
		const pick = await h.pool.choose()
		assert.equal(pick.ref, 'LOW')
		assert.match(pick.state, /below-floor/)
	} finally {
		h.cleanup()
	}
})

test('an unreadable pool fails with a mechanism-level message, not balance homework', async () => {
	const h = harness({ refs: ['A', 'B'], tokens: { A: '', B: '' } })
	try {
		await assert.rejects(
			() => h.pool.choose(),
			(error) => {
				assert.match(error.message, /none of the 2 configured account refs resolves to a token/)
				return true
			},
		)
	} finally {
		h.cleanup()
	}
})

test('every account empty or throttled reports why, per account', async () => {
	const h = harness({
		refs: ['A', 'B'],
		accounts: {
			A: { remaining: 0, readable: true, exhausted: true, checkedAt: Date.now() },
			B: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() },
		},
	})
	try {
		await h.pool.noteRefusal('B', { kind: 'rate-limit', retryAfterMs: 30_000 })
		await assert.rejects(
			() => h.pool.choose(),
			(error) => {
				assert.match(error.message, /A: \$0 left/)
				assert.match(error.message, /B: throttled for another/)
				assert.match(error.message, /pool waits out rate limits by itself/i)
				return true
			},
		)
	} finally {
		h.cleanup()
	}
})

test('a refusal buys exactly the window the server stated (capture-measured), and the pool moves on', async () => {
	const h = harness({
		refs: ['A', 'B'],
		accounts: {
			A: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() },
			B: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() },
		},
	})
	try {
		const first = await h.pool.noteRefusal('A', { kind: 'rate-limit', retryAfterMs: 60_000 })
		const firstLeft = h.pool.coolingUntil('A') - Date.now()
		await h.pool.noteRefusal('A', { kind: 'rate-limit', retryAfterMs: 60_000 })
		const secondLeft = h.pool.coolingUntil('A') - Date.now()
		assert.equal(first.streak, 1)
		// A packet capture showed the message carries an ACCURATE ~60s window (57 -> 41 -> 25 -> 10,
		// then reset), so doubling the wait would only idle an account that was about to work again.
		assert.ok(secondLeft <= 61_000, 'the stated window is honoured, not doubled')
		assert.ok(Math.abs(secondLeft - firstLeft) < 2_000, 'both refusals cost the same window')
		assert.equal(h.pool.refusalStreak('A'), 2, 'the streak is still recorded for diagnostics')
		assert.equal((await h.pool.choose()).ref, 'B', 'and the pool moves to the account that did not refuse')
	} finally {
		h.cleanup()
	}
})

test('a success clears the streak, so a recovered account is trusted again', async () => {
	const h = harness({ refs: ['A'], accounts: { A: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() } } })
	try {
		await h.pool.noteRefusal('A', { kind: 'rate-limit', retryAfterMs: 60_000 })
		assert.equal(h.pool.refusalStreak('A'), 1)
		h.pool.noteSuccess('A')
		assert.equal(h.pool.refusalStreak('A'), 0)
		assert.equal(h.pool.coolingUntil('A'), undefined, 'and it is immediately selectable again')
		assert.equal((await h.pool.choose()).ref, 'A')
	} finally {
		h.cleanup()
	}
})

test('the probe budget must not starve the scan past untouched accounts (live finding)', async () => {
	// Every observed account is stale AND depleted; accounts 6..8 were never seen. Before the fix
	// the first three probes exhausted the budget, so 6..8 were skipped and the pool returned a
	// $0.90 account while three untouched $5 ones sat behind it (observed on the real machine).
	const stale = (remaining) => ({ remaining, readable: true, exhausted: false, checkedAt: 0 })
	const h = harness({
		refs: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
		accounts: { A: stale(0.9), B: stale(0.9), C: stale(0.9), D: stale(0.9), E: stale(0.9) },
		usage: Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((r) => [`sgamp_TOKEN_${r}`, `Signed in as x\n**Individual credits:** $0.90 remaining\n`])),
	})
	try {
		const pick = await h.pool.choose()
		assert.equal(pick.ref, 'F', 'the first never-seen account enters on the fresh-account grant')
		assert.equal(pick.remaining, FRESH_ACCOUNT_CREDITS)
		assert.equal(pick.state, 'assumed')
	} finally {
		h.cleanup()
	}
})

test('F26: a medium run takes the account with headroom over one that merely clears the floor', async () => {
	const h = harness({
		refs: ['THIN', 'FUNDED'],
		accounts: {
			THIN: { remaining: 1.5, readable: true, exhausted: false, checkedAt: Date.now() },
			FUNDED: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() },
		},
	})
	try {
		const pick = await h.pool.choose({ mode: 'medium' })
		assert.equal(pick.ref, 'FUNDED', '$1.50 starts a medium run and then dies in it — the measured $3-4 spend is the bar')
	} finally {
		h.cleanup()
	}
})

test('F26: when nothing clears the bar, the RICHEST startable account is used', async () => {
	const h = harness({
		refs: ['A', 'B'],
		accounts: {
			A: { remaining: 1.2, readable: true, exhausted: false, checkedAt: Date.now() },
			B: { remaining: 2.5, readable: true, exhausted: false, checkedAt: Date.now() },
		},
	})
	try {
		const pick = await h.pool.choose({ mode: 'medium' })
		assert.equal(pick.ref, 'B', 'the bar exists to finish the run, so the best-funded candidate is the best bet')
		assert.equal(pick.remaining, 2.5)
		assert.match(pick.state, /below-headroom/, 'and it is honest that it may still not finish')
	} finally {
		h.cleanup()
	}
})

test("F26: the reviewer's example — $1.01 must not win over $3.99 when neither clears the bar", async () => {
	const h = harness({
		refs: ['THIN', 'RICH'],
		accounts: {
			THIN: { remaining: 1.01, readable: true, exhausted: false, checkedAt: Date.now() },
			RICH: { remaining: 3.99, readable: true, exhausted: false, checkedAt: Date.now() },
		},
	})
	try {
		assert.equal((await h.pool.choose({ mode: 'medium' })).ref, 'RICH')
	} finally {
		h.cleanup()
	}
})

test('F26: within the tier that CAN finish, configured order is the deliberate choice', async () => {
	const h = harness({
		refs: ['FIRST', 'SECOND'],
		accounts: {
			FIRST: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() },
			SECOND: { remaining: 9, readable: true, exhausted: false, checkedAt: Date.now() },
		},
	})
	try {
		const pick = await h.pool.choose({ mode: 'medium' })
		assert.equal(pick.ref, 'FIRST', 'the ref order carries the operator rotation intent; only the fallback tier bids on wealth')
		assert.equal(pick.state, 'ledger')
	} finally {
		h.cleanup()
	}
})

test('F26: adjacent fallback tiers keep their documented order', async () => {
	// low: a $0.50 account clears low's floor but not the $1 gate → it outranks an account whose
	// balance could not be read at all.
	const lowCase = harness({
		refs: ['FIFTY', 'NO_AMOUNT'],
		accounts: { FIFTY: { remaining: 0.5, readable: true, exhausted: false, checkedAt: Date.now() } },
		usage: { 'sgamp_TOKEN_NO_AMOUNT': 'signed in as someone\n' },
	})
	// medium: the unreadable-amount account outranks a known-below-floor one.
	const medCase = harness({
		refs: ['NO_AMOUNT', 'FIFTY'],
		accounts: { FIFTY: { remaining: 0.5, readable: true, exhausted: false, checkedAt: Date.now() } },
		usage: { 'sgamp_TOKEN_NO_AMOUNT': 'signed in as someone\n' },
	})
	try {
		assert.equal((await lowCase.pool.choose({ mode: 'low' })).ref, 'FIFTY', 'below the gate still beats "amount unknown"')
		assert.equal((await medCase.pool.choose({ mode: 'medium' })).ref, 'NO_AMOUNT', 'and "amount unknown" beats a known near-empty account')
	} finally {
		lowCase.cleanup()
		medCase.cleanup()
	}
})

test('the flagged regression: a $0.60 account must not outrank a later $5 one', async () => {
	const h = harness({
		refs: ['CHEAP', 'FUNDED'],
		accounts: {
			CHEAP: { remaining: 0.6, readable: true, exhausted: false, checkedAt: Date.now() },
			FUNDED: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() },
		},
	})
	try {
		// REVIEW-f26.md caught exactly this: with `low: 0.5` the $0.60 account cleared the bar and won
		// on config order, so a nearly-empty account was chosen while a $5 one sat behind it.
		for (const mode of ['low', 'medium']) {
			const pick = await h.pool.choose({ mode })
			assert.equal(pick.ref, 'FUNDED', `${mode}: no bar may sit below the $1 start gate`)
		}
	} finally {
		h.cleanup()
	}
})

test('F26: headroomForMode maps every mode and defaults unknown to medium', () => {
	assert.deepEqual(MODE_HEADROOM, { low: 1.5, medium: 4, high: 6, ultra: 10 }, 'the table the pool bids with')
	for (const [mode, value] of Object.entries(MODE_HEADROOM)) assert.equal(headroomForMode(mode), value)
	assert.equal(headroomForMode('nonsense'), MODE_HEADROOM.medium, 'an unknown mode must not bid zero')
	assert.equal(headroomForMode(undefined), MODE_HEADROOM.medium)
})

test('F26: exactly at headroom clears the bar, a cent below does not', async () => {
	for (const [mode, bar] of Object.entries({ medium: 4, high: 6, ultra: 10 })) {
		const at = harness({ refs: ['AT'], accounts: { AT: { remaining: bar, readable: true, exhausted: false, checkedAt: Date.now() } } })
		const below = harness({ refs: ['BELOW'], accounts: { BELOW: { remaining: bar - 0.01, readable: true, exhausted: false, checkedAt: Date.now() } } })
		try {
			const good = await at.pool.choose({ mode })
			assert.equal(good.state, 'ledger', `${mode}: at the bar means no caveat`)
			const poor = await below.pool.choose({ mode })
			assert.match(poor.state, /below-headroom/, `${mode}: a cent below the bar must carry the caveat`)
		} finally {
			at.cleanup()
			below.cleanup()
		}
	}
})

test('F26: a measured startable account outranks a merely assumed fresh one', async () => {
	// Three stale entries burn the probe budget, so the never-seen account can only be ASSUMED.
	const stale = { remaining: 0.2, readable: true, exhausted: false, checkedAt: 0 }
	const h = harness({
		refs: ['S1', 'S2', 'S3', 'NEVER', 'CONFIRMED'],
		accounts: {
			S1: stale, S2: stale, S3: stale,
			CONFIRMED: { remaining: 1.2, readable: true, exhausted: false, checkedAt: Date.now() },
		},
		usage: { 'sgamp_TOKEN_S1': 'credits=$0.20 remaining', 'sgamp_TOKEN_S2': 'credits=$0.20 remaining', 'sgamp_TOKEN_S3': 'credits=$0.20 remaining' },
	})
	try {
		const pick = await h.pool.choose({ mode: 'medium' })
		assert.equal(pick.ref, 'CONFIRMED', 'a reading beats a guess: $1.20 measured is preferred to $5 assumed')
		assert.match(pick.state, /below-headroom/, 'and it is honest that it may not finish')
	} finally {
		h.cleanup()
	}
})

test('F26: with the budget spent, an assumed fresh account still beats a below-gate one', async () => {
	const stale = { remaining: 0.2, readable: true, exhausted: false, checkedAt: 0 }
	const h = harness({
		refs: ['S1', 'S2', 'S3', 'NEVER', 'TINY'],
		accounts: {
			S1: stale, S2: stale, S3: stale,
			TINY: { remaining: 0.5, readable: true, exhausted: false, checkedAt: Date.now() },
		},
		usage: { 'sgamp_TOKEN_S1': 'credits=$0.20 remaining', 'sgamp_TOKEN_S2': 'credits=$0.20 remaining', 'sgamp_TOKEN_S3': 'credits=$0.20 remaining' },
	})
	try {
		const pick = await h.pool.choose({ mode: 'medium' })
		assert.equal(pick.ref, 'NEVER', 'the documented $5 grant is a better bet than a known $0.50')
		assert.equal(pick.state, 'assumed')
	} finally {
		h.cleanup()
	}
})

test('F26: both entry points actually pass the requested mode into choose', async () => {
	// A pool unit test can be green while an entry point forgets to say which mode it wants, which
	// silently disables the whole headroom policy. Guard the wiring itself, not just the pool.
	const { readFileSync } = await import('node:fs')
	for (const file of ['../lib/index.js', '../lib/live.js']) {
		const text = readFileSync(new URL(file, import.meta.url), 'utf8')
		assert.match(text, /\.choose\(\{\s*mode\s*\}\)/, `${file} must pass { mode } to choose()`)
	}
})

test('the probe budget must not hide a stale but KNOWN-funded account', async () => {
	// Three stale entries burn the budget; the funded account behind them was read ten minutes ago
	// and the pool has never seen the one after it. The reading, even stale, is the better bet.
	const stale = { remaining: 0.2, readable: true, exhausted: false, checkedAt: 0 }
	const h = harness({
		refs: ['S1', 'S2', 'S3', 'STALE_FUNDED', 'NEVER_SEEN'],
		accounts: {
			S1: stale, S2: stale, S3: stale,
			STALE_FUNDED: { remaining: 5, readable: true, exhausted: false, checkedAt: 0 },
		},
		usage: {
			'sgamp_TOKEN_S1': 'credits=$0.20 remaining',
			'sgamp_TOKEN_S2': 'credits=$0.20 remaining',
			'sgamp_TOKEN_S3': 'credits=$0.20 remaining',
		},
	})
	try {
		const pick = await h.pool.choose({ mode: 'medium' })
		assert.equal(pick.ref, 'STALE_FUNDED', 'a stale $5 reading beats an unread guess')
		assert.match(pick.state, /stale/, 'and the notice says the number is stale')
		assert.equal(pick.remaining, 5)
	} finally {
		h.cleanup()
	}
})

test('in-flight: two concurrent dispatches never take the same account', async () => {
	const h = harness({
		refs: ['A', 'B'],
		accounts: {
			A: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() },
			B: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() },
		},
	})
	try {
		// Same tick: without an atomic claim both selections see an unclaimed pool and pick A.
		const picks = await Promise.all([h.pool.choose({ mode: 'medium' }), h.pool.choose({ mode: 'medium' })])
		assert.notEqual(picks[0].ref, picks[1].ref, 'the second dispatch must prefer the unclaimed account')
	} finally {
		h.cleanup()
	}
})

test('in-flight: a finished run releases its claim', async () => {
	const h = harness({
		refs: ['A', 'B'],
		accounts: {
			A: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() },
			B: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() },
		},
	})
	try {
		const first = await h.pool.choose({ mode: 'medium' })
		assert.equal(first.ref, 'A', 'configured order still decides when nothing is claimed')
		const second = await h.pool.choose({ mode: 'medium' })
		assert.equal(second.ref, 'B', 'while the first is claimed')
		h.pool.noteSuccess(first.ref)
		const third = await h.pool.choose({ mode: 'medium' })
		assert.equal(third.ref, 'A', 'after the run reported back, the claim is gone')
	} finally {
		h.cleanup()
	}
})

test('in-flight: a claim is a preference, not a lock — the only account is still dispatched', async () => {
	const h = harness({
		refs: ['ONLY'],
		accounts: { ONLY: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() } },
	})
	try {
		const first = await h.pool.choose({ mode: 'medium' })
		assert.equal(first.ref, 'ONLY')
		const second = await h.pool.choose({ mode: 'medium' })
		assert.equal(second.ref, 'ONLY', 'refusing to run would be worse than sharing the account')
		assert.match(second.state, /already-claimed/, 'but the caller is told it is shared')
	} finally {
		h.cleanup()
	}
})

test('preview reports the selection without claiming it', async () => {
	const h = harness({
		refs: ['A', 'B'],
		accounts: {
			A: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() },
			B: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() },
		},
	})
	try {
		const first = await h.pool.preview({ mode: 'medium' })
		const second = await h.pool.preview({ mode: 'medium' })
		assert.equal(first.ref, 'A')
		assert.equal(second.ref, 'A', 'asking twice must not move the answer')
		// The real dispatch still gets the account the preview named.
		const chosen = await h.pool.choose({ mode: 'medium' })
		assert.equal(chosen.ref, 'A', 'a preview must never consume the in-flight claim')
		assert.equal(chosen.state, 'ledger', 'and it is not marked as shared')
	} finally {
		h.cleanup()
	}
})

test('a preview never spends a probe; a real selection still does', async () => {
	// The fake `amp usage` would answer $3.00. If a preview reads, the state becomes `ledger`; if it
	// answers from the ledger alone, the account is unobserved and enters on the documented grant.
	// The harness' USAGE() helper produces the format `amp usage` really prints; inventing a
	// shorter line parses as "no amount" and would make this test pass for the wrong reason.
	const options = { refs: ['A'], usage: { 'sgamp_TOKEN_A': USAGE(3) } }
	const free = harness(options)
	const paid = harness(options)
	try {
		const preview = await free.pool.preview({ mode: 'medium', probe: false })
		assert.equal(preview.state, 'assumed', 'a preview must not touch the network')
		assert.equal(preview.remaining, 5, 'it reports the documented grant, not a reading it did not take')

		const chosen = await paid.pool.choose({ mode: 'medium' })
		// $3 clears medium's $1 start gate but not its $4 headroom, so it enters as a below-headroom
		// candidate — the state suffix is the proof that a READING happened.
		// `confirmed` is the state a REAL reading produces; with `probe: false` this ref could only
		// have been `assumed`. That difference is what proves the preview skipped the network.
		assert.match(chosen.state, /^confirmed/, 'a real dispatch still reads when the ledger is cold')
		assert.equal(chosen.remaining, 3, 'and it uses the number it read')
		assert.equal(chosen.remaining, 3)
	} finally {
		free.cleanup()
		paid.cleanup()
	}
})

test('AMP-C5: an `amp usage` probe carries a real deadline, not a termination grace', async () => {
	const h = harness({ refs: ['A'] })
	try {
		await h.pool.list({ refresh: true })
		const spec = h.spawns.at(-1)
		// `graceMs` bounds the termination procedure and the post-exit drain; it is NOT an
		// execution deadline. The reviewed build passed its 20s "timeout" there and no signal at
		// all, so a hung probe left `handle.done` pending forever and every selection behind it.
		assert.equal(spec.graceMs, 5000, 'graceMs is the short termination grace')
		assert.ok(spec.signal instanceof AbortSignal, 'and the deadline is carried by a signal, the seam\'s cancel channel')
	} finally {
		h.cleanup()
	}
})

test('AMP-C5: a probe that never exits is abandoned on the deadline, and the account is UNKNOWN not spent', async () => {
	const h = harness({ refs: ['A'], hanging: new Set(['sgamp_TOKEN_A']) })
	try {
		// 20 seconds is the real deadline, so shorten the wait by racing it: what matters is that
		// the pool DOES stop waiting and reports an unreadable reading rather than a zero balance.
		const reading = await Promise.race([
			h.pool.choose({ mode: 'low' }),
			new Promise((resolve) => setTimeout(() => resolve('still-hanging'), 25_000)),
		])
		assert.notEqual(reading, 'still-hanging', 'a hung probe must not block selection forever')
		assert.equal(h.ledger.read('A'), undefined, 'and it must never be recorded as spent')
	} finally {
		h.cleanup()
	}
}, { timeout: 30_000 })

test('AMP-G3: a lease belongs to its run — releasing one cannot free another on the same ref', async () => {
	const h = harness({ refs: ['A'], accounts: { A: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() } } })
	try {
		// Fail-open path: with one ref, a second dispatch still takes it and says so.
		const first = await h.pool.choose({ mode: 'low' })
		const second = await h.pool.choose({ mode: 'low' })
		assert.equal(first.ref, 'A')
		assert.equal(second.ref, 'A')
		assert.match(second.state, /already-claimed/)
		assert.notEqual(first.claimToken, second.claimToken, 'each run holds its own lease token')

		// Run A ends. Run B is STILL RUNNING, so the account must still look claimed; the
		// ref-keyed Map this replaced would have freed it here and sent a third dispatch onto it.
		assert.equal(h.pool.release(first.ref, first.claimToken), true)
		const third = await h.pool.choose({ mode: 'low' })
		assert.match(third.state, /already-claimed/, 'B still owns the account')

		// Only when the LAST lease goes does the account look free again.
		h.pool.release(second.ref, second.claimToken)
		h.pool.release(third.ref, third.claimToken)
		const fourth = await h.pool.choose({ mode: 'low' })
		assert.equal(/already-claimed/.test(String(fourth.state)), false, 'no lease left, so no suffix')
	} finally {
		h.cleanup()
	}
})

test('AMP-G3b: a WRONG token releases nothing', async () => {
	const h = harness({ refs: ['A'], accounts: { A: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() } } })
	try {
		await h.pool.choose({ mode: 'low' })
		assert.equal(h.pool.release('A', 'not-my-lease'), false)
		const next = await h.pool.choose({ mode: 'low' })
		assert.match(next.state, /already-claimed/, 'the real lease is untouched')
	} finally {
		h.cleanup()
	}
})

test('AMP-G3c: accounting (noteSuccess/noteRefusal/refresh) only drops the lease it was given', async () => {
	const h = harness({ refs: ['A'], accounts: { A: { remaining: 5, readable: true, exhausted: false, checkedAt: Date.now() } } })
	try {
		const first = await h.pool.choose({ mode: 'low' })
		const second = await h.pool.choose({ mode: 'low' })
		// A reports success while B keeps running: B's lease must survive.
		h.pool.noteSuccess(first.ref, first.claimToken)
		const third = await h.pool.choose({ mode: 'low' })
		assert.match(third.state, /already-claimed/, 'noteSuccess released only its own lease')
		// An accounting call with NO token must not touch anyone's claim either.
		h.pool.noteSuccess(second.ref)
		const fourth = await h.pool.choose({ mode: 'low' })
		assert.match(fourth.state, /already-claimed/, 'a tokenless accounting call releases nothing')
	} finally {
		h.cleanup()
	}
})
