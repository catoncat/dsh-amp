/**
 * dsh-amp account pool — ledger-first.
 *
 * The rule this implements, from the deployment's owner: do NOT read every account's
 * balance from `amp usage`. That command costs no credits, but it is NOT free — it is
 * a network round trip measured at ~3.4s, so 48 of them took 41s at concurrency 4.
 * It also spends nothing on an account that was never used, which the owner stated
 * plainly: a fresh account holds $5.
 *
 * So the local ledger answers selection, and the remote read is demoted to what it is
 * actually good for — confirming the ONE account a run just used:
 *
 *   selection            0 remote reads   ledger + the $5 fresh-account default
 *   after a run          1 remote read    only the account that just ran
 *   explicit page action  bounded reads   the user asked for them
 *
 * Two facts still shape the rest:
 *
 * 1. Credential refs cannot be enumerated — the credentials service documents that
 *    "the reference half has no enumeration because configuration surfaces learn which
 *    references exist from settings schemas" — so the account list comes from the
 *    `dsh-amp` settings namespace.
 * 2. A ref that does not resolve must be skipped, never used: with no `AMP_API_KEY` in
 *    the child environment the Amp CLI does not fail, it silently authenticates as
 *    whatever account this machine ran `amp login` for.
 */

import { randomUUID } from 'node:crypto'
import { floorForMode, FRESH_ACCOUNT_CREDITS, headroomForMode, MIN_START_CREDITS, remainingFrom } from './ledger.js'

/**
 * How long ONE `amp usage` probe may take before it is abandoned.
 *
 * This is a real caller-owned DEADLINE, not a termination grace: the seam documents that
 * `graceMs` only bounds the termination procedure and the post-exit pipe drain, and that
 * "callers own deadlines" — classification here belongs to the caller. Passing this value
 * as `graceMs` (the previous shape) bounded nothing: a DNS, proxy, or upstream stall left
 * `handle.done` pending forever, and every selection that needed a reading sat behind it.
 */
const USAGE_TIMEOUT_MS = 20_000
/**
 * Grace for the termination the deadline triggers. Deliberately separate from the
 * deadline above, and much shorter: once the probe is abandoned, waiting is pure cost.
 */
const USAGE_TERMINATION_GRACE_MS = 5_000
/** How long a confirmed reading stays authoritative before a run re-confirms it. */
const CONFIRM_AFTER_MS = 10 * 60 * 1000
/** Bound for an EXPLICIT "read them all" action. Selection never uses this. */
const REFRESH_CONCURRENCY = 8
/**
 * How many remote confirms ONE dispatch may spend on accounts the ledger cannot answer for.
 * Unbounded, a pool of unreadable accounts turns every dispatch into dozens of round trips.
 */
const MAX_CONFIRM_READS = 3

function firstGroup(pattern, text) {
	const match = pattern.exec(text)
	return match === null ? undefined : match[1]
}

function toNumber(value) {
	if (typeof value !== 'string') return undefined
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Parse `amp usage`. Real output looks like:
 *
 *   Signed in as someone@example.com
 *   **Individual credits:** $3.29 remaining (set up auto-reload …) - https://…
 *
 * or, for a tiered account, additionally:
 *
 *   **Amp Megawatt Tier:** agent usage $0 of $10 remaining (0%), orb usage …
 *
 * An unrecognized shape yields no numbers at all and the caller treats the account as
 * usable — failing OPEN. A parser that failed closed would turn an upstream wording
 * change into "every account is out of quota".
 */
export function parseUsage(text) {
	const clean = typeof text === 'string' ? text : ''
	const email = firstGroup(/Signed in as\s+(\S+)/iu, clean)
	const credits = toNumber(firstGroup(/Individual credits:?\**[^$]*\$([0-9]+(?:\.[0-9]+)?)\s*remaining/iu, clean))
	const tierUsed = toNumber(firstGroup(/agent usage\s*\$([0-9]+(?:\.[0-9]+)?)\s*of\s*\$/iu, clean))
	const tierTotal = toNumber(
		firstGroup(/agent usage\s*\$[0-9]+(?:\.[0-9]+)?\s*of\s*\$([0-9]+(?:\.[0-9]+)?)/iu, clean),
	)
	// Undefined fields are OMITTED, never set to `undefined`. This object reaches the
	// settings page across the `host.call` JSON boundary, and an explicit `undefined`
	// value is rejected there as non-lossless JSON — which is exactly how the page
	// first failed.
	const usage = {}
	if (email !== undefined) usage.email = email
	if (credits !== undefined) usage.credits = credits
	if (tierUsed !== undefined) usage.tierUsed = tierUsed
	if (tierTotal !== undefined) usage.tierTotal = tierTotal
	if (tierUsed !== undefined && tierTotal !== undefined) usage.tierRemaining = tierTotal - tierUsed
	return usage
}

/**
 * Whether a parsed reading leaves anything to spend. Unknown shapes stay usable.
 *
 * The bar is strictly "more than nothing", NOT `MIN_START_CREDITS`: measured on this
 * deployment, a `low` run started on an account holding $0.90. A pool that refused it
 * would be inventing a rule Amp does not have.
 */
export function isUsable(usage) {
	const remaining = remainingFrom(usage)
	return remaining === undefined ? true : remaining > 0
}

export function describeUsage(usage) {
	const parts = []
	if (usage.email !== undefined) parts.push(usage.email)
	if (usage.credits !== undefined) parts.push(`credits=$${usage.credits.toFixed(2)}`)
	if (usage.tierRemaining !== undefined) {
		parts.push(`tier=$${usage.tierRemaining.toFixed(2)} of $${usage.tierTotal.toFixed(2)} left`)
	}
	if (parts.length === 0) parts.push('balance unreadable (treated as usable)')
	return parts.join(' ')
}

export function createAccountPool(ctx, getResolved, ledger) {
	/**
	 * Accounts that recently refused work with a retry window, keyed by ref. This is the
	 * pool's own memory of a throttle: without it the mechanism would pick the same
	 * throttled account again and hand the 57-second wait to the delegating agent.
	 */
	const cooling = new Map()
	/**
	 * How many times in a row each account has refused work. A throttle is not a one-off: today
	 * every run kept landing on the same spent, hammered accounts while eight untouched accounts
	 * sat in the pool. The first refusal costs its own window; each further one buys a longer
	 * one, so the mechanism moves on by itself instead of asking a human to reorder the list.
	 */
	const refusals = new Map()
	/** Cap so a bad day cannot retire an account forever. */
	const MAX_COOLDOWN_MS = 15 * 60 * 1000
	const isCooling = (ref, now = Date.now()) => (cooling.get(ref) ?? 0) > now

	/** Whether one ledger entry is too old to decide on. */
	const isStale = (ref) => {
		const record = ledger.read(ref)
		if (record === undefined) return false
		const checkedAt = typeof record.checkedAt === 'number' ? record.checkedAt : 0
		return Date.now() - checkedAt > CONFIRM_AFTER_MS
	}

	const tokenOf = async (ref) => {
		const credential = await ctx.credentials.resolve(ref)
		return credential === undefined || typeof credential.value !== 'string' ? '' : credential.value
	}

	/** ONE remote reading for ONE account, folded into the ledger. */
	const readOne = async (ref, token) => {
		const env = { AMP_API_KEY: token }
		// The deadline is the caller's (this file's), and it is carried by an AbortSignal —
		// the seam's documented cancel channel. `graceMs` below stays a termination grace.
		const signal =
			typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(USAGE_TIMEOUT_MS) : undefined
		let handle
		try {
			const executable = await ctx.subprocess.resolveExecutable(getResolved().ampBin, env, signal)
			handle = ctx.subprocess.spawn({
				argv: [executable, 'usage', '--no-color'],
				cwd: process.cwd(),
				stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
				graceMs: USAGE_TERMINATION_GRACE_MS,
				...(signal === undefined ? {} : { signal }),
				env,
			})
			const outcome = await handle.done
			const stdout = handle.collected?.stdout ? handle.collected.stdout.readFrom(0).text : ''
			const stderr = handle.collected?.stderr ? handle.collected.stderr.readFrom(0).text : ''
			// Never let the raw token reach a transcript: `amp usage` prints the account
			// email, and a failure path could echo the environment.
			const text = `${stdout}\n${stderr}`.replace(/sgamp_[A-Za-z0-9_-]+/gu, 'sgamp_<redacted>')
			if (outcome.exitCode !== 0) {
				// A failed reading is NOT evidence of zero. Keep the previous ledger entry and
				// report the failure, so a transient outage cannot mark an account spent.
				return { ok: false, detail: `amp usage exited ${String(outcome.exitCode)}` }
			}
			const usage = parseUsage(text)
			const detail = describeUsage(usage)
			ledger.observe(ref, usage, detail)
			return { ok: true, detail, usage }
		} catch (error) {
			// Abandoned on the deadline, or the seam could not run it at all. Either way the
			// account's balance is UNKNOWN, never zero: a hung probe must not retire an account,
			// and it must not hold a dispatch behind it either. Selection treats an unreadable
			// reading as a lower-priority candidate, so the pool fails open onto a real one.
			return { ok: false, detail: `amp usage could not be read: ${String(error?.message ?? error)}` }
		} finally {
			// The deadline is a request, not a guarantee: the abort listener starts the seam's
			// terminate escalation, and this makes the intent explicit even on an implementation
			// that ignores the signal. Terminating an already-exited probe is a no-op.
			if (handle !== undefined) {
				try {
					handle.terminate()
				} catch {
					/* already gone */
				}
			}
		}
	}

	// In-flight claims: once an account is chosen for a run, it is claimed until that run reports
	// back, so two concurrent dispatches cannot take the same one. A claim is a PREFERENCE, never a
	// lock — if everything is claimed the pool still returns the best candidate (fail-open) and says
	// so, because refusing to run would be a worse failure than sharing an account.
	/** Serialises choose() so a claim cannot interleave with the selection that produced it. */
	let selectionQueue = Promise.resolve()
	const INFLIGHT_TTL_MS = 30 * 60 * 1000
	/**
	 * `ref -> (lease token -> expiry)`.
	 *
	 * A claim belongs to the RUN that took it, not to the account: the fail-open path lets two runs
	 * share one ref, and a ref-keyed boolean would let the first run to finish delete the second
	 * one's claim (it did — the reviewer reproduced a third dispatch landing on a busy account).
	 * Every consumer that reports an ending (`finish`, `noteSuccess`, `noteRefusal`, `refresh`)
	 * carries the token of the lease it is ending, so it can only release its own.
	 */
	const inflight = new Map()
	const claim = (ref, token) => {
		const leases = inflight.get(ref) ?? new Map()
		leases.set(token, Date.now() + INFLIGHT_TTL_MS)
		inflight.set(ref, leases)
		return token
	}
	/** Drop expired leases first so a dead run cannot hold an account past its TTL. */
	const liveLeases = (ref, now = Date.now()) => {
		const leases = inflight.get(ref)
		if (leases === undefined) return undefined
		for (const [token, until] of leases) if (until <= now) leases.delete(token)
		if (leases.size === 0) {
			inflight.delete(ref)
			return undefined
		}
		return leases
	}
	/**
	 * Release leases for one ref. With a token, ONLY that run's lease — which is what every
	 * accounting call must use. Without one, every lease on the ref (the explicit "drop this
	 * account's claims" escape hatch, used by nothing in the dispatch paths).
	 */
	const release = (ref, token) => {
		if (token === undefined) return inflight.delete(ref)
		const leases = inflight.get(ref)
		if (leases === undefined) return false
		const had = leases.delete(token)
		if (leases.size === 0) inflight.delete(ref)
		return had
	}
	const claimed = (ref) => liveLeases(ref) !== undefined

	return {
		/**
		 * Set by the host row when the settings namespace could NOT be registered.
		 *
		 * A pool that keeps serving while the settings page writes into a namespace this
		 * plugin does not own would dispatch with one configuration while the page shows
		 * and saves another. Publishing the failure here lets every dispatch surface (and
		 * the web view) refuse instead of diverging silently.
		 */
		settingsError: undefined,

		/** The local ledger view for the settings page. No remote read by default. */
		async list(options) {
			const refs = getResolved().accountRefs
			const raw = options !== null && typeof options === 'object' ? options.limit : undefined
			const limit = typeof raw === 'number' && Number.isFinite(raw) ? (raw > 0 ? Math.floor(raw) : undefined) : 12
			const shown = limit === undefined ? refs : refs.slice(0, limit)
			if (options !== null && typeof options === 'object' && options.refresh === true) {
				let cursor = 0
				const worker = async () => {
					for (;;) {
						const index = cursor
						cursor += 1
						if (index >= shown.length) return
						const ref = shown[index]
						const token = await tokenOf(ref)
						if (token.trim() === '') continue
						try {
							await readOne(ref, token)
						} catch {
							/* recorded as a failed reading, not as a spent account */
						}
					}
				}
				await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, shown.length) }, worker))
			}
			return { total: refs.length, shown: shown.length, rows: ledger.snapshot(shown) }
		},

		/**
		 * Pick the account for the next run.
		 *
		 * ORDERING, not gatekeeping. Candidates at or above `MIN_START_CREDITS` win, but a
		 * below-floor account is still returned when nothing better exists — measured on this
		 * deployment, a `low` run starts on $0.90 even though `medium` on the same account is
		 * refused. Only a genuinely empty or currently throttled account is skipped, and a
		 * stale reading is re-read rather than trusted. The pool therefore never refuses to
		 * dispatch merely because it distrusts its own ledger; if the request is refused
		 * after all, the failure classifier and `noteRefusal` decide what happens next.
		 */
		/**
		 * Which account a dispatch WOULD take, decided without claiming it.
		 *
		 * A read-only surface must never claim: an `amp_accounts` call that consumed an in-flight
		 * reservation would push the next real dispatch off the account it was told about — the
		 * preview would change what it previewed. Selection only; `choose()` is the claiming path.
		 */
		preview(options) {
			return this.select(options)
		},

		/**
		 * Selection plus claim. `select` decides; this records that the account is now in use, so a
		 * concurrent dispatch prefers a different one. Callers must use `pool.choose(...)`.
		 */
		async choose(options) {
			// Selection and the claim must be ATOMIC. Claiming after an await lets two dispatches
			// started in the same tick both finish `select` before either claim lands, so they pick
			// the same account — the exact collision this exists to prevent. The queue is cheap:
			// selection already awaits a ledger read at worst.
			const run = async () => {
				const wasClaimed = new Set([...inflight.keys()].filter((ref) => claimed(ref) === true))
				// `choose` is a method of the pool object, so `this` reaches its sibling.
				const picked = await this.select(options)
				if (picked !== undefined && picked !== null && typeof picked.ref === 'string') {
					if (wasClaimed.has(picked.ref)) {
						picked.state = `${String(picked.state)}-already-claimed`
						picked.detail = `${String(picked.detail ?? '')} (another run already claimed this account; nothing unclaimed qualified)`.trim()
					}
					// The lease token travels with the selection: whoever ends this run must present
					// it to release, so two runs sharing one ref cannot release each other's claim.
					picked.claimToken = randomUUID()
					claim(picked.ref, picked.claimToken)
				}
				return picked
			}
			const next = selectionQueue.then(run, run)
			selectionQueue = next.then(
				() => undefined,
				() => undefined,
			)
			return next
		},

		async select(options) {
			const refs = getResolved().accountRefs
			// Unclaimed first: this is what keeps two concurrent dispatches off one account, while
			// still falling back to a claimed account rather than refusing to run.
			const scan = [...refs.filter((ref) => claimed(ref) !== true), ...refs.filter((ref) => claimed(ref) === true)]
			// U3: the floor follows the MODE. `low` has none (measured: it starts on $0.90); `medium`
			// needs $1 (measured on the same account); high/ultra inherit $1 as CONSERVATIVE POLICY,
			// not as a measurement.
			const mode = options === undefined || options === null ? undefined : options.mode
			const floor = floorForMode(mode)
			// F26: the floor decides whether this mode may run; this decides whether it can FINISH.
			// Never below the start gate: a bar beneath it lets a doomed account win on config order,
			// which is exactly the regression the reviewer caught with a $0.60 leading account.
			const headroom = Math.max(headroomForMode(mode), MIN_START_CREDITS)
			const now = Date.now()
			const skipped = []
			/** Best candidate seen so far that sits below the preference floor. */
			let fallback
			/** Remote confirms spent by this dispatch. */
			let probes = 0
			// A PREVIEW must be free: `probe: false` forbids every `amp usage` round trip, so the pool
			// answers from the ledger alone (stale-positive readings and assumed grants included). The
			// settings page renders on every load and the model may ask at any time; neither should
			// wait ~3.4s per account, nor spend a read to answer a question about a *future* run.
			const probingAllowed = options === undefined || options === null || options.probe !== false
			/**
			 * First account whose balance could not be read. It stays a candidate — a failed
			 * reading is NOT evidence of an empty account — but it must never WIN over one we
			 * can confirm: returning it eagerly made an unreadable account monopolize every
			 * dispatch (and pay a remote read each time) while healthy accounts never got picked.
			 */
			let unreadable
			/**
			 * Above the floor but without healthy headroom. Measured today: an account at $0.90 was
			 * refused with a rate limit while one at $1.45 worked, and the pool still has dozens of
			 * untouched $5 accounts — so "technically runnable" must not outrank "actually funded".
			 * Preference only: this tier is still dispatched when nothing healthier exists.
			 */
			let acceptable
			/** Measured, startable, but probably not enough to finish. */
			let healthy
			/** First never-observed account: a documented guess, so it ranks below any reading. */
			let assumed
			/**
			 * A reading that came back OK but said nothing about money. It stays a candidate —
			 * an unreadable amount is not evidence of zero — but it must not beat an account we
			 * can actually MEASURE, or an upstream wording change makes every dispatch land here
			 * again: the same monopoly, one branch over.
			 */
			let unknownAmount
			for (const ref of scan) {
				const token = await tokenOf(ref)
				if (token.trim() === '') {
					skipped.push(`${ref}: no token`)
					continue
				}
				if (isCooling(ref, now)) {
					const left = Math.ceil(((cooling.get(ref) ?? now) - now) / 1000)
					skipped.push(`${ref}: throttled for another ${String(left)}s`)
					continue
				}
				let remaining = ledger.remaining(ref)
				let detail
				let state
				if (remaining === undefined || isStale(ref)) {
					if (probingAllowed !== true || probes >= MAX_CONFIRM_READS) {
						// Budget spent. Skipping EVERYTHING here is what starved the scan: a pool whose first
						// accounts are depleted then keeps returning a near-empty account while untouched ones
						// sit behind it. A never-observed account is a fresh one by this pool's own rule, so
						// it enters on the documented grant instead of a read.
						if (remaining === undefined && ledger.read(ref) === undefined) {
							// A candidate, NOT a winner: returning here let an assumed account preempt a
							// later CONFIRMED one, and a reading beats a guess.
							if (assumed === undefined) {
								assumed = {
								ref,
								token,
								remaining: FRESH_ACCOUNT_CREDITS,
								detail: `assumed ${String(FRESH_ACCOUNT_CREDITS)} (fresh account, no read needed)`,
								state: 'assumed',
								considered: skipped.length + 1,
								of: refs.length,
								}
							}
							continue
						}
						// A stale but KNOWN-positive reading is better evidence than a guess: this account
						// held $5 ten minutes ago. Skipping it here is what let the budget hide a funded
						// account and dispatch to a never-seen one instead (observed on the real machine).
						if (typeof remaining === 'number' && remaining >= MIN_START_CREDITS) {
							const stale = {
								ref,
								token,
								remaining,
								detail: `${String(detail ?? 'ledger')} (stale, not re-read: probe budget spent)`,
								state: `${String(state ?? 'ledger')}-stale`,
								considered: skipped.length + 1,
								of: refs.length,
							}
							if (remaining >= headroom) return stale
							if (healthy === undefined || remaining > healthy.remaining) healthy = stale
							continue
						}
						skipped.push(`${ref}: not read (probe budget spent)`)
						continue
					}
					probes += 1
					// Unobserved or stale: read THIS one instead of trusting a number that may be
					// ten minutes and one spent run out of date. Selection never reads the whole pool.
					try {
						const reading = await readOne(ref, token)
						if (reading.ok !== true) {
							if (unreadable === undefined) {
								unreadable = { ref, token, detail: reading.detail, state: 'unreadable', considered: skipped.length + 1 }
							}
							continue
						}
						remaining = remainingFrom(reading.usage)
						detail = reading.detail
						state = 'confirmed'
						if (remaining === undefined) {
							if (unknownAmount === undefined) {
								unknownAmount = {
									ref,
									token,
									detail,
									state: 'confirmed-no-amount',
									considered: skipped.length + 1,
								}
							}
							continue
						}
					} catch (error) {
						// Fail open, matching the parser's policy — as a FALLBACK, not as a winner.
						if (unreadable === undefined) {
							unreadable = {
								ref,
								token,
								detail: `read failed (${String(error?.message ?? error)}) — using it anyway`,
								state: 'unreadable',
								considered: skipped.length + 1,
							}
						}
						continue
					}
				} else {
					detail = ledger.read(ref)?.detail ?? `ledger says $${remaining.toFixed(2)} left`
					state = 'ledger'
				}
				if (remaining === 0) {
					skipped.push(`${ref}: $0 left`)
					continue
				}
				const candidate = { ref, token, remaining, detail, state, considered: skipped.length + 1, of: refs.length }
				// Health first, then the mode floor, then the rest. The floor still decides whether a
				// mode may run at all; this order decides which account is worth spending a run on.
				// Tier 1: enough to finish the run we are about to start.
				if (remaining >= headroom) return candidate
				// Tier 2: healthy enough to START, but a heavy run may outspend it.
				if (remaining >= MIN_START_CREDITS) {
					// Richest wins here, not configured-first: nothing clears the bar, so the best-funded
					// candidate is the best chance of finishing. Tier 1 keeps configured order (below).
					if (healthy === undefined || remaining > healthy.remaining) healthy = candidate
				} else if (remaining >= floor) {
					if (acceptable === undefined) acceptable = candidate
				} else if (fallback === undefined || remaining > fallback.remaining) {
					fallback = candidate
				}
			}
			// Tier 2 may start but probably cannot finish: say so, do not hand it out bare.
			if (healthy !== undefined) return { ...healthy, state: `${healthy.state}-below-headroom`, of: refs.length }
			if (assumed !== undefined) return { ...assumed, of: refs.length }
			if (acceptable !== undefined) {
				// Name the tier honestly: it clears this mode's floor, but it has no headroom — which
				// is exactly the state that produced today's rate limits.
				// Below the server's own start gate: a run from here can be refused mid-conversation.
				return { ...acceptable, state: `${acceptable.state}-below-start-gate`, of: refs.length }
			}
			if (unknownAmount !== undefined) {
				// Order of last resorts: an amount we could not read is a better bet than a known
				// small balance, which in turn beats an account that refused to answer at all.
				return { ...unknownAmount, of: refs.length }
			}
			if (fallback !== undefined) {
				return {
					ref: fallback.ref,
					token: fallback.token,
					detail:
						`${String(fallback.detail)} — below the $${String(floor)} floor this mode needs, ` +
						'dispatching anyway (it is the best candidate there is)',
					state: `${fallback.state}-below-floor`,
					considered: fallback.considered,
					of: refs.length,
				}
			}
			if (unreadable !== undefined) {
				// Nothing could be confirmed and nothing below the floor was known: last resort is
				// the account we could not read, because "unreadable" is not "empty".
				return { ...unreadable, of: refs.length }
			}
			const configured = []
			for (const ref of refs) {
				if ((await tokenOf(ref)).trim() !== '') configured.push(ref)
			}
			if (configured.length === 0) {
				throw new Error(
					`dsh-amp: none of the ${String(refs.length)} configured account refs resolves to a token. ` +
						'Refusing to run rather than let the Amp CLI fall back to this machine\'s `amp login` account.',
				)
			}
			throw new Error(
				`dsh-amp: no account can start a run right now (${skipped.join('; ')}). ` +
					'The pool waits out rate limits by itself, so this means every configured account is empty, throttled, unreadable, or beyond this dispatch\'s probe budget.',
			)
		},

		/** Record a dispatched run so the ledger knows this account is in use. */
		noteDispatch(ref, threadId) {
			ledger.noteDispatch(ref, threadId)
		},

		/**
		 * Release an in-flight claim WITHOUT touching the ledger.
		 *
		 * A claim is taken by {@link choose} before a run exists, so every path that fails
		 * between the claim and the run's publication must give it back — otherwise a
		 * refusal that never started a child still pushes the next dispatch off a healthy
		 * account for the whole TTL.
		 *
		 * `token` is the lease the caller holds. With it, exactly that run's claim is dropped;
		 * WITHOUT it every lease on the ref is dropped, which is only correct for a caller that
		 * owns the ref outright (nothing in the dispatch paths does — the fail-open path lets two
		 * runs share a ref, and a tokenless release would hand a busy account to a third).
		 */
		release(ref, token) {
			if (typeof ref !== 'string' || ref === '') return false
			const held = token === undefined ? inflight.has(ref) : inflight.get(ref)?.has(token) === true
			release(ref, token)
			return held
		},

		/**
		 * Confirm ONE account against the remote and fold it in. This is the only read
		 * the normal path performs, and only after a run, where ~3.4s is unobservable.
		 *
		 * `token` releases the CALLER's lease when this confirms a run's account. It is optional
		 * because `amp_accounts({refresh:true})` also re-reads balances without owning any claim —
		 * and that call must not drop somebody else's.
		 */
		async refresh(ref, token) {
			if (token !== undefined) release(ref, token)
			const accountToken = await tokenOf(ref)
			if (accountToken.trim() === '') return { ok: false, detail: `credential ref "${ref}" is not set` }
			try {
				return await readOne(ref, accountToken)
			} catch (error) {
				return { ok: false, detail: String(error?.message ?? error) }
			}
		},

		/** Whether one ledger entry is stale enough to be worth re-confirming. */
		stale(ref) {
			return isStale(ref)
		},

		/**
		 * Fold what an account just did back into the pool, so the next dispatch is better
		 * informed without the delegating agent ever seeing a balance question.
		 *
		 * A throttle is remembered for its own window; a credit refusal or a dead credential
		 * forces THIS account's balance to be re-read, replacing a stale guess with a fact.
		 */
		async noteRefusal(ref, classification, token) {
			// Only the lease of the run that produced this refusal: in the fail-open case another
			// live run may hold the SAME ref, and releasing it here would hand a busy account away.
			if (token !== undefined) release(ref, token)
			const kind = classification === undefined || classification === null ? undefined : classification.kind
			if (kind === 'rate-limit' || kind === 'credits') {
				const base =
					classification.retryAfterMs !== undefined &&
					Number.isFinite(classification.retryAfterMs) &&
					classification.retryAfterMs > 0
						? classification.retryAfterMs
						: 60_000
				const streak = (refusals.get(ref) ?? 0) + 1
				refusals.set(ref, streak)
				// 57s, 114s, 228s … capped. Consecutive refusals are evidence, not noise.
				// Honoured, not doubled: the capture showed the refusal carries an ACCURATE ~60s window
				// (57 -> 41 -> 25 -> 10, then reset), so doubling only idled a healthy account.
				const wait = Math.min(base, MAX_COOLDOWN_MS)
				cooling.set(ref, Date.now() + wait)
				if (kind === 'rate-limit') return { recorded: 'throttled', until: cooling.get(ref), streak }
				// A credit refusal still needs the ledger corrected; the cooldown rides along.
				const token = await tokenOf(ref)
				if (token.trim() === '') return { recorded: 'credits', until: cooling.get(ref), streak }
				try {
					return { ...(await readOne(ref, token)), recorded: 'credits', until: cooling.get(ref), streak }
				} catch (error) {
					return { ok: false, detail: String(error?.message ?? error), recorded: 'credits', streak }
				}
			}
			if (kind === 'auth') {
				const token = await tokenOf(ref)
				if (token.trim() === '') return { ok: false, detail: `credential ref "${ref}" is not set` }
				try {
					return await readOne(ref, token)
				} catch (error) {
					return { ok: false, detail: String(error?.message ?? error) }
				}
			}
			return undefined
		},

		/** A run worked: forget the refusal streak, so the account is trusted again. */
		noteSuccess(ref, token) {
			if (token !== undefined) release(ref, token)
			refusals.delete(ref)
			cooling.delete(ref)
		},

		/** How many refusals in a row this account has produced. Diagnostic surface. */
		refusalStreak(ref) {
			return refusals.get(ref) ?? 0
		},

		/** When a throttled account becomes usable again, or undefined. Diagnostic surface. */
		coolingUntil(ref) {
			return cooling.get(ref)
		},

		/** The configured ref list in order; the settings page edits it wholesale. */
		allRefs() {
			return [...getResolved().accountRefs]
		},

		ledgerPath: ledger.path,
	}
}
