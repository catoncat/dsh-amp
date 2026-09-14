/**
 * dsh-amp local Web view.
 *
 * The settings UI cannot read a host plugin's data on its own: a card or page is
 * handed empty owner props, and the settings RPC only speaks the settings document.
 * The established pattern in this deployment (see `@arcships/dsh-dim-oauth`) is a
 * small loopback-only JSON route on the Harness web server, which the browser half
 * then fetches for itself.
 *
 * The route is not a security boundary by obscurity: it refuses anything that is not
 * a loopback connection carrying the plugin's own header with a matching Host and
 * Origin, so another origin in the same browser cannot read the account list.
 */

const ROUTE = '/api/dsh-amp'
const HEADER = 'x-dsh-amp'

/** Loopback + plugin header + matching Host/Origin, mirroring the shipped pattern. */
function isLocalUiRequest(req) {
	const remote = req.socket?.remoteAddress
	if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false
	if (req.headers[HEADER] !== '1') return false
	const host = req.headers.host
	if (host === undefined) return false
	try {
		const parsed = new URL(`http://${host}`)
		if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]') return false
		const origin = req.headers.origin
		if (origin === undefined) return true
		const parsedOrigin = new URL(origin)
		return (parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:') && parsedOrigin.host === host
	} catch {
		return false
	}
}

function send(res, code, payload) {
	res.writeHead(code, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
	res.end(JSON.stringify(payload))
}

/**
 * Which account a real dispatch would take right now, per mode — answered by the POOL.
 *
 * The page used to re-derive this from "first not exhausted", which is a third rule: it drifted the
 * moment the pool gained floors, headroom, cooling and assumed grants. Only the pool may answer;
 * the page only renders. A function declaration so call order cannot matter.
 */
async function nextUp(pool) {
	const byMode = {}
	for (const mode of ['low', 'medium']) {
		try {
			// NEVER `choose()` here. `choose` records an in-flight claim, so rendering the settings
			// page would reserve accounts and push real dispatches off them — the preview would be
			// changing the thing it previews. `preview` decides without claiming; a pool that has no
			// preview reports nothing instead of taking a claim.
			const picked = typeof pool.preview === 'function' ? await pool.preview({ mode, probe: false }) : undefined
			if (picked !== undefined && picked !== null) {
				byMode[mode] = { ref: picked.ref, state: picked.state, remaining: picked.remaining }
			}
		} catch {
			/* the page must still render when the pool cannot answer */
		}
	}
	return { byMode }
}

export function registerAccountRoutes(ctx, pool) {
	ctx.inject(['webServer'], (serverCtx) => {
		serverCtx.effect(
			() =>
				serverCtx.webServer.register({
					kind: 'prefix',
					path: ROUTE,
					handler: async (req, res) => {
						if (!isLocalUiRequest(req)) {
							send(res, 403, { ok: false, error: 'the Amp account view is available only from the local Harness UI' })
							return
						}
						let url
						try {
							url = new URL(req.url ?? '/', 'http://localhost')
						} catch {
							send(res, 400, { ok: false, error: 'bad request' })
							return
						}
						try {
							if (url.pathname === `${ROUTE}/accounts` && req.method === 'GET') {
								const raw = url.searchParams.get('limit')
								// No limit parameter means the page's default view; an explicit 0
								// means "every account". This reads the LOCAL ledger, so it is
								// instant; `refresh=1` is the only path that spends a round trip
								// per shown account.
								const parsed = raw === null ? 12 : Number(raw)
								// Explicit 0 means EVERY account and is passed through as 0: `pool.list`
								// reads it as unlimited, while an absent field means its 12-row default.
								// Normalising 0 to "omit" made the documented "0 = all" return 12 rows.
								const limit = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 12
								const reading = await pool.list({
									limit,
									refresh: url.searchParams.get('refresh') === '1',
								})
								const allRefs = typeof pool.allRefs === 'function' ? pool.allRefs() : []
								send(res, 200, {
									ok: true,
									total: reading.total,
									shown: reading.shown,
									accounts: reading.rows,
									// U6: the page says whether the build it is looking at is current.
									// "Edited the source, restarted, nothing changed" is a silent,
									// repeatable failure; the user should never have to guess.
									source: pool.source,
									// The FULL ordered list. The page shows only a slice, and an edit
									// must never drop the refs it did not display.
									allRefs,
									// ...and this flag says whether that list is the WHOLE set. The
									// browser half gates every edit on it, so omitting it made the page
									// permanently read-only while blaming the session. Only this side
									// can judge trustworthiness, so only this side may answer.
									allRefsAvailable: Array.isArray(allRefs) && allRefs.length === reading.total,
									// A namespace this row could not register means an edit here would
									// not reach the configuration a run uses. The page turns read-only
									// and says why, instead of accepting a save that silently does
									// nothing.
									settingsError: pool.settingsError ?? undefined,
									// Answered by the pool, not re-derived by the browser half.
									next: await nextUp(pool),
								})
								return
							}
							send(res, 404, { ok: false, error: 'not found' })
						} catch (error) {
							send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
						}
					},
				}),
			'dsh-amp: local Web account view',
		)
	})
}
