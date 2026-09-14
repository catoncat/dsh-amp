/**
 * Classify an Amp run's terminal error into what the MECHANISM must do next.
 *
 * Two failures observed on this deployment, both with `subtype=error_during_execution`:
 *
 *   `You must have at least $1 in available credits to start this request.`
 *   `Rate limit exceeded. Please try again in 57 seconds.`
 *
 * Neither did any work, and both are recoverable — by another account, or by the same
 * account after a wait. A delegating agent must not have to know any of that: the pool
 * consumes this verdict, records it, and picks differently next time.
 *
 * The classification is deliberately shape-based on the raw text: the CLI reports these
 * as prose with no error code, and prose is what we have.
 */

/** What one failure means for the next dispatch. */
// 'credits'   — this account cannot start this request; another one may.
// 'rate-limit'— this account is throttled for a known window; it works again after it.
// 'auth'      — the credential itself is bad; only a human can fix it.
// 'other'     — unknown; do NOT retry blind, the caller must see it.
export const FAILURE_KINDS = ['credits', 'rate-limit', 'auth', 'other']

/**
 * @param text - the raw error text from the run (`result.error`, a `system` error, or stderr).
 * @returns `{ kind, retryAfterMs }`; `retryAfterMs` is set only when the text names a wait.
 */
export function classifyAmpError(text) {
	const clean = typeof text === 'string' ? text : ''
	if (/at least \$[0-9.]+\s+in available credits|insufficient credits|out of credits|no credits/iu.test(clean)) {
		return { kind: 'credits', retryAfterMs: undefined }
	}
	if (/rate ?limit/iu.test(clean)) {
		const seconds = /try again in ([0-9]+)\s*seconds?/iu.exec(clean)
		const parsed = seconds === null ? Number.NaN : Number(seconds[1])
		return { kind: 'rate-limit', retryAfterMs: Number.isFinite(parsed) ? parsed * 1000 : 60_000 }
	}
	if (/unauthorized|invalid api key|authentication failed|not signed in/iu.test(clean)) {
		return { kind: 'auth', retryAfterMs: undefined }
	}
	return { kind: 'other', retryAfterMs: undefined }
}

/** Whether a failure kind is safe to retry elsewhere WITHOUT losing work. */
export function isNoWorkFailure(kind) {
	return kind === 'credits' || kind === 'rate-limit' || kind === 'auth'
}

/**
 * One line a delegating agent can act on, with the attribution the bare CLI banner
 * lacks. The raw text is never replaced — this is a prefix, not a rewrite.
 */
export function describeFailure(kind, retryAfterMs) {
	const wait = typeof retryAfterMs === 'number' && retryAfterMs > 0 ? ` retryAfter=${String(Math.round(retryAfterMs / 1000))}s` : ''
	switch (kind) {
		case 'credits':
			return `failure=credits (this account is below Amp's floor for this request; another account may still run it)${wait}`
		case 'rate-limit':
			return `failure=rate-limit (transient; the account works again after the window)${wait}`
		case 'auth':
			// Reviewed: this used to say "retrying elsewhere is pointless", which contradicted
			// `isNoWorkFailure('auth') === true`. A rejected credential is per-ACCOUNT, so the
			// useful next move is exactly to try another account — the text must say so.
			return `failure=auth (this credential is not accepted; another account may still run it)${wait}`
		default:
			return 'failure=other (unclassified; not safe to retry blind)'
	}
}
