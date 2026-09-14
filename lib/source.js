/**
 * Which copy of this plugin is actually loaded.
 *
 * This module exists because of a real incident: `dsh-amp` is declared in the profile
 * as a `file:` dependency, which the package manager installs as a real COPY under
 * `profiles/<name>/node_modules/dsh-amp`. Editing the source directory therefore
 * changes NOTHING until that copy is refreshed, and three restarts were spent
 * "verifying" a build that was never loaded. A run that reports its own absolute path
 * and content hash can no longer be attributed to a build nobody meant to run.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Describe one loaded module: its absolute path and a short content hash.
 * @param moduleUrl - the caller's `import.meta.url`.
 * @returns `{ file, hash }`, each `'unknown'` when it cannot be determined.
 */
export function describeSource(moduleUrl) {
	let file = 'unknown'
	try {
		file = fileURLToPath(moduleUrl)
	} catch {
		/* not a file URL */
	}
	let hash = 'unknown'
	try {
		hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
	} catch {
		/* unreadable: the path is still the useful half */
	}
	return { file, hash }
}


/** Hash one file, or undefined when it cannot be read. */
function hashOf(file) {
	try {
		return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12)
	} catch {
		return undefined
	}
}

/**
 * Drift between the INSTALLED package ON DISK and the SOURCE package.
 *
 * Scope, stated precisely because this is easy to over-read: this re-reads files from the loaded
 * module's directory path. It therefore cannot tell whether the already-running process loaded
 * them — deploy over the copy while the host is up and this still says `in-sync` while memory
 * holds the old build. Only the runtime-reported hashes prove what is loaded.
 *
 * Hashing one entry file is NOT enough. Editing `accounts.js` and forgetting to deploy leaves
 * `index.js` and `live.js` untouched, so a single-file comparison still reports `in-sync` —
 * and "forgot to deploy" is exactly when that lie is most expensive. This walks every `.js` in
 * the installed module's directory and compares it against the same name in the source tree.
 *
 * @param runningFile - the loaded module's absolute path (from `describeSource`).
 * @returns `{ status, changed, missing, sourceDir }`; status is `in-sync`, `STALE`, or `unknown`
 *   when there is no source tree to compare against (a packaged install legitimately has none).
 */
export function describePackageDrift(runningFile) {
	const home =
		typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
	const parts = String(runningFile).split(sep)
	const runningDir = parts.slice(0, -1).join(sep)
	const sourceDir = join(home, 'plugins', 'dsh-amp', parts.slice(-2)[0] ?? 'lib')
	let names
	try {
		names = readdirSync(runningDir)
			.filter((name) => name.endsWith('.js'))
			.sort()
	} catch {
		return { status: 'unknown', changed: [], missing: [], added: [], sourceDir }
	}
	let sourceNames
	try {
		sourceNames = readdirSync(sourceDir)
			.filter((name) => name.endsWith('.js'))
			.sort()
	} catch {
		// No source tree at all: a packaged install, not a stale one. Silence is honest here.
		return { status: 'unknown', changed: [], missing: [], added: [], sourceDir }
	}
	const changed = []
	const missing = []
	const added = []
	// Walk the UNION. Iterating only the running copy would miss a file the source tree gained
	// and the installed copy never received — which is half of every "forgot to deploy".
	for (const name of [...new Set([...names, ...sourceNames])].sort()) {
		const runningHash = hashOf(join(runningDir, name))
		const sourceHash = hashOf(join(sourceDir, name))
		if (sourceHash === undefined) missing.push(name)
		else if (runningHash === undefined) added.push(name)
		else if (sourceHash !== runningHash) changed.push(name)
	}
	const stale = changed.length > 0 || missing.length > 0 || added.length > 0
	return { status: stale ? 'STALE' : 'in-sync', changed, missing, added, sourceDir }
}
