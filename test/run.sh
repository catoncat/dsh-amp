#!/bin/bash
#
# dsh-amp behavioural test runner.
#
# Why a runner instead of plain `node --test`: `lib/*.js` imports `@deepseek-ai/*`
# packages that resolve from the DSH installation, and this plugin deliberately ships
# no node_modules of its own. So the runner builds a throwaway harness — a temp dir
# with a symlink to the DSH node_modules and a copy of lib/ — and runs the tests
# there. The plugin tree stays free of dependencies it does not ship, and a test run
# can never write into the real ledger (DSH_HOME points at the harness).
#
# Usage:   bash test/run.sh
# Override the resolution root when DSH is installed somewhere unusual:
#          DSH_NODE_MODULES=/path/to/node_modules bash test/run.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"

# What the plugin (and these tests) actually resolve from the host install. A candidate root is
# only accepted when every one is present, so a wrong directory fails loudly instead of producing
# a misleading "module not found" from deep inside a test file.
REQUIRED_PACKAGES=(
	'@deepseek-ai/dsh-tools'
	'@deepseek-ai/dsh-llm'
	'@deepseek-ai/dsh-subagent'
	'@deepseek-ai/schemastery'
)

has_required() {
	local root="$1" name
	[ -n "$root" ] && [ -d "$root" ] || return 1
	for name in "${REQUIRED_PACKAGES[@]}"; do
		[ -e "$root/$name" ] || return 1
	done
}

find_modules() {
	if [ -n "${DSH_NODE_MODULES:-}" ]; then
		if has_required "$DSH_NODE_MODULES"; then echo "$DSH_NODE_MODULES"; else echo ""; fi
		return
	fi
	local global_root
	global_root="$(npm root -g 2>/dev/null || true)"
	# Both layouts npm produces are covered: a global install hoists the DSH packages beside
	# `@deepseek-ai/dsh` (flat), while a locally bundled install nests them under it. Probing for
	# the packages themselves — rather than assuming a layout — is what makes this work in CI,
	# where only `npm install -g @deepseek-ai/dsh` has run.
	local candidates=(
		"$SRC/node_modules"
		"$global_root/@deepseek-ai/dsh/node_modules"
		"$global_root"
		"$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules"
		"$HOME/.npm-global/lib/node_modules"
	)
	local candidate
	for candidate in "${candidates[@]}"; do
		if has_required "$candidate"; then
			echo "$candidate"
			return
		fi
	done
	echo ""
}

MODULES="$(find_modules)"
if [ ! -d "$MODULES" ]; then
	echo "dsh-amp tests: cannot locate a node_modules containing: ${REQUIRED_PACKAGES[*]}" >&2
	echo "               install the harness (npm install -g @deepseek-ai/dsh), or point at an" >&2
	echo "               existing install with DSH_NODE_MODULES=/path/to/node_modules" >&2
	exit 2
fi

HARNESS="$(mktemp -d "${TMPDIR:-/tmp}/dsh-amp-test.XXXXXX")"
trap 'rm -rf "$HARNESS"' EXIT

ln -sfn "$MODULES" "$HARNESS/node_modules"
cp -R "$SRC/lib" "$HARNESS/lib"
mkdir -p "$HARNESS/test"
cp "$SRC"/test/*.test.mjs "$HARNESS/test/"

cd "$HARNESS"
DSH_HOME="$HARNESS/home" node --test test/*.test.mjs
