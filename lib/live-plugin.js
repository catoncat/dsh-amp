/**
 * dsh-amp live tools — the AGENT-plane row.
 *
 * The providers stay host-plane, because the `subagents` registry is a process
 * singleton. Model-facing tools are different: every one of them belongs to the
 * preset that grants it, exactly like the shipped `dsh-tool-subagent` rows.
 * Registering these from the host row instead would put `amp_run`,
 * `amp_send_message` and `amp_stop` in front of every preset in the profile —
 * including `minimal`, whose whole point is two tools.
 */
import { resolveConfig, SETTINGS_SERVICE } from './index.js'
import { registerLiveTools } from './live.js'

export const name = 'dsh-amp-live'
export const inject = ['subprocess', 'credentials']

export function apply(ctx, config) {
	const compositionConfig = config ?? {}
	// Prefer the resolved settings namespace, which the host-plane `dsh-amp` row
	// registers and which is the single source of truth for the account list. This
	// row must NOT register it again — a namespace may only be registered once.
	let userLayer = {}
	try {
		const section = ctx.get('settings')?.get?.('dsh-amp')
		if (section !== undefined && section !== null && typeof section === 'object') userLayer = section
	} catch {
		/* the namespace is not registered yet; the composition config stands alone */
	}
	const resolved = resolveConfig({ ...compositionConfig, ...userLayer })
	registerLiveTools(ctx, resolved)

	// Live settings. The registered tools close over `resolved`, so a settings change must mutate
	// THAT object: assigning a fresh one would leave every tool reading the values it mounted with
	// — which is exactly how `ampBin`/`visibility`/`keepThreads`/`grace` came to be fields the
	// settings page displayed but nothing honoured. (The idle timeout needed its own fix: the sweep
	// re-reads it every tick.) The mode LIST still belongs to
	// the mount (the tool schema enumerates it), so that one is documented as restart-scoped.
	// `inject` (not a single `get`) so a host row that provides the service a moment later is still
	// picked up: reading it once meant the row silently froze at its mount snapshot — the failure
	// mode this whole change exists to remove — with nothing in the log to say so.
	ctx.inject([SETTINGS_SERVICE], (settingsCtx) => {
		// Defensive: a service object that is not fully shaped must not take the row down.
		const live = typeof settingsCtx?.get === 'function' ? settingsCtx.get(SETTINGS_SERVICE) : undefined
		if (live === undefined || typeof live.subscribe !== 'function' || typeof live.current !== 'function') {
			ctx.logger?.warn?.(`${name}: the ${SETTINGS_SERVICE} service is unavailable, so live settings stay frozen at mount`)
			return
		}
		// Reconcile first: a change between mount and subscribe would otherwise be lost forever.
		const now = live.current()
		if (now !== undefined && now !== null) {
			for (const key of Object.keys(resolved)) delete resolved[key]
			Object.assign(resolved, now)
		}
		ctx.effect(
			() => live.subscribe((nextResolved) => {
				for (const key of Object.keys(resolved)) delete resolved[key]
				Object.assign(resolved, nextResolved)
			}),
			'dsh-amp-live: follow the settings subscription',
		)
	})
}
