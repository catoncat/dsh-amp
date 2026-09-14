/**
 * dsh-amp deploy-drift tests.
 *
 * One entry hash cannot prove a change to a sibling module is live: editing accounts.js and
 * forgetting to deploy leaves index.js/live.js untouched. So the check walks the UNION of both
 * directories, and these tests pin the three answers it may give: in-sync, STALE, unknown.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

const { describePackageDrift } = await import("../lib/source.js")

function layout({ running, source }) {
	const dir = mkdtempSync(join(tmpdir(), "dsh-amp-drift-"))
	const home = join(dir, "home")
	const runningFile = join(dir, "profile", "node_modules", "dsh-amp", "lib", "live.js")
	mkdirSync(dirname(runningFile), { recursive: true })
	writeFileSync(runningFile, running)
	if (source !== undefined) {
		const sourceFile = join(home, "plugins", "dsh-amp", "lib", "live.js")
		mkdirSync(dirname(sourceFile), { recursive: true })
		writeFileSync(sourceFile, source)
	}
	return {
		home,
		runningFile,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	}
}

function withHome(home, run) {
	const previous = process.env.DSH_HOME
	process.env.DSH_HOME = home
	try {
		return run()
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = previous
	}
}

test("an installed copy that matches its source is in-sync", () => {
	const l = layout({ running: "same bytes\n", source: "same bytes\n" })
	try {
		const drift = withHome(l.home, () => describePackageDrift(l.runningFile))
		assert.equal(drift.status, "in-sync")
		assert.deepEqual(drift.changed, [])
	} finally {
		l.cleanup()
	}
})

test("a packaged install with no source tree answers unknown instead of throwing", () => {
	const l = layout({ running: "anything\n" })
	try {
		const drift = withHome(l.home, () => describePackageDrift(l.runningFile))
		assert.equal(drift.status, "unknown")
	} finally {
		l.cleanup()
	}
})

test("drift is STALE when a NON-entry file is out of date (the case that matters)", () => {
	const l = layout({ running: "same\n", source: "same\n" })
	try {
		writeFileSync(join(l.home, "plugins", "dsh-amp", "lib", "accounts.js"), "edited, never deployed\n")
		const drift = withHome(l.home, () => describePackageDrift(l.runningFile))
		assert.equal(drift.status, "STALE")
		assert.deepEqual(drift.added, ["accounts.js"], "the source gained a file the install lacks")
	} finally {
		l.cleanup()
	}
})

test("drift is STALE when a sibling exists on both sides with different bytes", () => {
	const l = layout({ running: "same\n", source: "same\n" })
	try {
		writeFileSync(join(l.home, "plugins", "dsh-amp", "lib", "ledger.js"), "new\n")
		writeFileSync(join(l.runningFile, "..", "ledger.js"), "old\n")
		const drift = withHome(l.home, () => describePackageDrift(l.runningFile))
		assert.equal(drift.status, "STALE")
		assert.deepEqual(drift.changed, ["ledger.js"])
	} finally {
		l.cleanup()
	}
})
