/**
 * dsh-amp failure-classifier tests.
 *
 * Every string asserted here is a REAL error this deployment produced, quoted verbatim.
 * The classifier decides what the mechanism does next — retry elsewhere, remember a
 * throttle window, or hand the failure to the caller — so a wrong verdict is not a
 * cosmetic bug. No DSH dependency: this file runs with plain `node --test`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { classifyAmpError, describeFailure, isNoWorkFailure } = await import('../lib/outcome.js')

test('the real credit refusal is classified as credits', () => {
	const verdict = classifyAmpError('You must have at least $1 in available credits to start this request.')
	assert.equal(verdict.kind, 'credits')
	assert.equal(verdict.retryAfterMs, undefined)
	assert.equal(isNoWorkFailure(verdict.kind), true, 'nothing ran, so retrying elsewhere loses nothing')
})

test('the real rate-limit refusal carries its own wait', () => {
	const verdict = classifyAmpError('Rate limit exceeded. Please try again in 57 seconds.')
	assert.equal(verdict.kind, 'rate-limit')
	assert.equal(verdict.retryAfterMs, 57_000)
	assert.equal(isNoWorkFailure(verdict.kind), true)
})

test('a rate limit without a stated window still yields a usable default', () => {
	const verdict = classifyAmpError('Rate limit exceeded.')
	assert.equal(verdict.kind, 'rate-limit')
	assert.equal(verdict.retryAfterMs, 60_000)
})

test('credential failures are separated from money failures', () => {
	assert.equal(classifyAmpError('Unauthorized: invalid API key').kind, 'auth')
	assert.equal(classifyAmpError('Authentication failed').kind, 'auth')
})

test('an unrelated mention of money or limits stays unclassified (no false retry)', () => {
	// The dangerous direction is a FALSE POSITIVE: a generic failure misread as
	// "harmless, retry elsewhere" would silently rerun work that may have partially happened.
	assert.equal(classifyAmpError('Failed to load the credits page: HTTP 500').kind, 'other')
	assert.equal(classifyAmpError('the agent produced no output').kind, 'other')
	assert.equal(classifyAmpError('').kind, 'other')
	assert.equal(classifyAmpError(undefined).kind, 'other')
	assert.equal(isNoWorkFailure('other'), false, 'an unknown failure must NOT be retried blind')
})

test('only the known no-work kinds are marked retryable', () => {
	assert.deepEqual(['credits', 'rate-limit', 'auth', 'other'].map(isNoWorkFailure), [true, true, true, false])
})

test('describeFailure prefixes the raw text without replacing it', () => {
	const credits = describeFailure('credits')
	assert.match(credits, /failure=credits/)
	assert.match(credits, /another account may still run it/)

	const throttled = describeFailure('rate-limit', 57_000)
	assert.match(throttled, /failure=rate-limit/)
	assert.match(throttled, /retryAfter=57s/)

	const unknown = describeFailure('other')
	assert.match(unknown, /not safe to retry blind/)
	assert.equal(unknown.includes('retryAfter'), false)
})
