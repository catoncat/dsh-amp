/**
 * dsh-amp local spend ledger.
 *
 * The rule this implements: DO NOT read every account's balance from `amp usage`.
 * This process already knows which accounts it dispatched to, so the local ledger is
 * the first source of truth and a remote read is needed only when the ledger cannot
 * answer. An account that was never dispatched to is assumed to hold the standard
 * fresh-account grant of $5, so it needs no read either.
 *
 * That also removes the concurrency problem at its root. Selection now costs no
 * network call in the common case, instead of 48 parallel `amp usage` processes; the
 * remote read becomes a per-run confirmation of the ONE account that was just used,
 * which is cheap and keeps the ledger honest.
 *
 * Storage is one JSON file replaced atomically (temp file + rename), so a crash or a
 * full disk cannot leave a half-written ledger behind. It is deliberately a plain
 * file rather than a service: it must survive restarts, stay inspectable by a human,
 * and add no dependency to a plugin whose whole point is being a thin adapter.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The grant a brand-new Amp account starts with, per the deployment's own rule. */
export const FRESH_ACCOUNT_CREDITS = 5

/**
 * The balance below which a request can be refused.
 *
 * NOT a hard floor: measured on this deployment, a `low` run STARTED fine on an account
 * holding $0.90 while a `medium` run on the same account was refused with
 * "must have at least $1 in available credits". So this number is a PREFERENCE used to
 * order candidates, never a reason to refuse to dispatch — the pool dispatches, and the
 * failure classifier decides what to do next. Treating it as a hard gate would refuse
 * work that Amp would have accepted.
 */
export const MIN_START_CREDITS = 1

/**
 * The balance a request of each mode needs before Amp will start it at all.
 *
 * PARTLY measured. On this deployment a `medium` request on an account holding $0.90
 * was refused with "must have at least $1 in available credits to start this request",
 * while a `low` request on the SAME account was accepted and ran. So the floor is
 * mode-dependent and `low` needs none: a flat $1 gate would refuse work Amp accepts, and
 * no gate at all would send medium runs at accounts that cannot start them.
 */
export const MODE_FLOORS = {
	low: 0,
	medium: MIN_START_CREDITS,
	high: MIN_START_CREDITS,
	ultra: MIN_START_CREDITS,
}

/**
 * What a run of each mode is expected to SPEND. These are POLICY values: only `medium` has
 * samples on this deployment (two long reviews, ~$2.2 and ~$4.1); low/high/ultra are estimates.
 *
 * The floor above answers "may this mode start at all"; this answers "is there enough left to
 * finish". Measured: a 25-turn medium review took an account from $5.00 to ~$1, and a 27-turn
 * one burned ~$4. Dispatching a medium run at an account holding $1.30 therefore passes the
 * floor and dies in the middle — the exact failure mode this table exists to avoid.
 */
export const MODE_HEADROOM = {
	// `low` is not 0.5: a run that STARTS at $0.90 keeps making requests, and the server refuses
	// once the balance is under $1 mid-conversation (policy inference from the $1 start refusal). The
	// bar clears that gate on purpose.
	low: 1.5,
	// The one measured long task (27 turns) burned ~$4.1; the previous $3 under-bid it.
	medium: 4,
	high: 6,
	ultra: 10,
}

/** The spend a mode is expected to need. An unknown mode takes the conservative default. */
export function headroomForMode(mode) {
	return typeof mode === 'string' && Object.hasOwn(MODE_HEADROOM, mode) ? MODE_HEADROOM[mode] : MODE_HEADROOM.medium
}

/** The floor for one mode. An unknown mode takes the conservative default. */
export function floorForMode(mode) {
	return typeof mode === 'string' && Object.hasOwn(MODE_FLOORS, mode) ? MODE_FLOORS[mode] : MIN_START_CREDITS
}

const VERSION = 1

export function defaultLedgerPath() {
	const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
	return join(home, 'state', 'dsh-amp', 'ledger.json')
}

/**
 * Remaining spendable amount from one parsed reading, or `undefined` when the reading
 * says nothing about it. Credits and a tier bucket are alternative purses; an account
 * uses whichever it is on, so the larger of the two known numbers is the answer.
 */
export function remainingFrom(usage) {
	const credit = typeof usage.credits === 'number' ? usage.credits : undefined
	const tier = typeof usage.tierRemaining === 'number' ? usage.tierRemaining : undefined
	if (credit === undefined && tier === undefined) return undefined
	return Math.max(credit ?? Number.NEGATIVE_INFINITY, tier ?? Number.NEGATIVE_INFINITY)
}

export function createLedger(file, logger) {
	let state = { version: VERSION, accounts: {} }

	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8'))
		if (parsed !== null && typeof parsed === 'object' && parsed.accounts !== null && typeof parsed.accounts === 'object') {
			state = { version: VERSION, accounts: parsed.accounts }
		}
	} catch {
		/* absent, unreadable, or corrupt: start empty rather than refuse to run */
	}

	const save = () => {
		try {
			mkdirSync(dirname(file), { recursive: true })
			const tmp = `${file}.tmp-${String(process.pid)}`
			writeFileSync(tmp, JSON.stringify({ version: VERSION, accounts: state.accounts }, null, 2), { mode: 0o600 })
			renameSync(tmp, file)
		} catch (error) {
			// A ledger that cannot persist still works for this process; losing it costs
			// one extra remote read later, which is not worth failing a run over.
			logger?.warn?.(`dsh-amp: could not persist the account ledger at ${file}: ${String(error?.message ?? error)}`)
		}
	}

	return {
		path: file,

		/** The raw record, or undefined when this account was never observed. */
		read(ref) {
			const record = state.accounts[ref]
			return record !== null && typeof record === 'object' ? record : undefined
		},

		/**
		 * What the local ledger believes is left. `undefined` means "never observed",
		 * which the caller resolves to the fresh-account grant — not to zero and not by
		 * going out to read it.
		 */
		remaining(ref) {
			const record = this.read(ref)
			if (record === undefined) return undefined
			if (record.exhausted === true) return 0
			return typeof record.remaining === 'number' ? record.remaining : undefined
		},

		/** Fold one authoritative remote reading into the ledger. */
		observe(ref, usage, detail) {
			const remaining = remainingFrom(usage)
			state.accounts[ref] = {
				email: typeof usage.email === 'string' ? usage.email : undefined,
				credits: typeof usage.credits === 'number' ? usage.credits : undefined,
				tierRemaining: typeof usage.tierRemaining === 'number' ? usage.tierRemaining : undefined,
				remaining,
				// A reading that says nothing about money is not evidence of zero; mark it
				// unreadable so it is treated as usable (fail open), never as spent.
				exhausted: remaining === 0,
				readable: remaining !== undefined,
				detail: typeof detail === 'string' ? detail : undefined,
				checkedAt: Date.now(),
				runs: typeof this.read(ref)?.runs === 'number' ? this.read(ref).runs : 0,
				lastRunAt: this.read(ref)?.lastRunAt,
			}
			save()
			return state.accounts[ref]
		},

		/** Record that a run was dispatched, so the ledger knows this account is in use. */
		noteDispatch(ref, threadId) {
			const previous = this.read(ref)
			state.accounts[ref] = {
				...previous,
				runs: (typeof previous?.runs === 'number' ? previous.runs : 0) + 1,
				lastRunAt: Date.now(),
				lastThreadId: typeof threadId === 'string' ? threadId : previous?.lastThreadId,
			}
			save()
		},

		/** Every known account, in the given order, with its ledger view. */
		snapshot(refs) {
			const rows = []
			for (const ref of refs) {
				const record = this.read(ref)
				const remaining = this.remaining(ref)
				rows.push({
					ref,
					observed: record !== undefined,
					remaining: remaining === undefined ? (record === undefined ? FRESH_ACCOUNT_CREDITS : undefined) : remaining,
					assumed: record === undefined,
					readable: record?.readable === true,
					exhausted: record?.exhausted === true,
					// What the settings page needs to answer "will this one be picked?" in the
					// same terms the pool uses: below the preference floor, not "spent".
					usable: remaining === undefined ? true : remaining >= MIN_START_CREDITS,
					email: record?.email,
					detail: record?.detail,
					checkedAt: record?.checkedAt,
					runs: typeof record?.runs === 'number' ? record.runs : 0,
				})
			}
			return rows
		},

		/** Drop everything. Used by an explicit "forget the local ledger" action. */
		reset() {
			state = { version: VERSION, accounts: {} }
			try {
				unlinkSync(file)
			} catch {
				/* already gone */
			}
		},
	}
}
