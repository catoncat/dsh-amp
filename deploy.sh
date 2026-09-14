#!/bin/bash
#
# dsh-amp deployment helper.
#
# WHY THIS EXISTS: the profile declares this plugin as a `file:` dependency, which the
# package manager installs as a real COPY under `profiles/<name>/node_modules/dsh-amp`.
# Editing this source tree therefore changes NOTHING until that copy is refreshed — and
# restarting an unchanged copy looks exactly like a successful deploy. Three restarts
# were once spent "verifying" a build that was never loaded (see docs/reviews/USAGE-FINDINGS.md F20).
#
# Usage:
#   bash deploy.sh                     deploy this source into the installed copy
#   bash deploy.sh --check             report drift only; exit 1 when the copy is stale
#   bash deploy.sh --list              show the install targets found
#   DSH_AMP_INSTALL=/path/bash/to/dsh-amp bash deploy.sh    target one explicitly
#
# After a deploy a HOST RESTART is still required (the plugin is loaded in-process).
# Verify the loaded build for free, without starting an agent:
#   amp_accounts  ->  source.hash must equal the fingerprint printed below
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
PROFILES_DIR="${DSH_HOME:-$HOME/.dsh}/profiles"
MODE="${1:-deploy}"

fingerprint() {
	node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex").slice(0,12))' "$1"
}

candidates() {
	local path
	for path in "$PROFILES_DIR"/*/node_modules/dsh-amp; do
		[ -d "$path" ] && printf '%s\n' "$path"
	done
	return 0
}

if [ "$MODE" = "--list" ]; then
	found="$(candidates || true)"
	if [ -z "$found" ]; then
		echo "deploy: no installed copy under $PROFILES_DIR/*/node_modules/dsh-amp"
	else
		printf '%s\n' "$found"
	fi
	exit 0
fi

# ---- resolve the target ----------------------------------------------------
if [ -n "${DSH_AMP_INSTALL:-}" ]; then
	TARGET="$DSH_AMP_INSTALL"
else
	found="$(candidates || true)"
	count="$(printf '%s\n' "$found" | grep -c . || true)"
	if [ "$count" -eq 0 ]; then
		echo "deploy: no installed copy found under $PROFILES_DIR/*/node_modules/dsh-amp" >&2
		echo "        install the bundle first, or pass DSH_AMP_INSTALL=/path/to/dsh-amp" >&2
		exit 2
	fi
	if [ "$count" -gt 1 ]; then
		echo "deploy: several installed copies exist; choose one with DSH_AMP_INSTALL:" >&2
		printf '  %s\n' $found >&2
		exit 2
	fi
	TARGET="$found"
fi
[ -d "$TARGET" ] || { echo "deploy: $TARGET is not a directory" >&2; exit 2; }

# ---- drift check -----------------------------------------------------------
drifted=""
for path in "$SRC"/lib/*.js; do
	name="$(basename "$path")"
	cmp -s "$path" "$TARGET/lib/$name" || drifted="$drifted $name"
done

if [ "$MODE" = "--check" ]; then
	if [ -z "$drifted" ]; then
		echo "deploy --check: in sync ($TARGET)"
		echo "  index.js $(fingerprint "$SRC/lib/index.js")  live.js $(fingerprint "$SRC/lib/live.js")"
		exit 0
	fi
	echo "deploy --check: STALE — the installed copy does not match this source" >&2
	printf '  differs:%s\n' "$drifted" >&2
	exit 1
fi

# ---- deploy ----------------------------------------------------------------
# Never ship code that does not even parse: the host would load it at next start.
for path in "$SRC"/lib/*.js; do
	node --check "$path" || { echo "deploy: refusing to deploy, $path does not parse" >&2; exit 3; }
done

backup="$TMPDIR/dsh-amp-installed-$(date +%Y%m%d-%H%M%S)"
rm -rf "$backup"
cp -R "$TARGET" "$backup"

rm -rf "$TARGET/lib" "$TARGET/test"
cp -R "$SRC/lib" "$TARGET/lib"
[ -d "$SRC/test" ] && cp -R "$SRC/test" "$TARGET/test"
cp "$SRC/package.json" "$SRC/cordis.patch.yml" "$TARGET/"

failed=""
for path in "$SRC"/lib/*.js; do
	name="$(basename "$path")"
	cmp -s "$path" "$TARGET/lib/$name" || failed="$failed $name"
done

echo "deploy: target $TARGET"
echo "deploy: backup $backup"
if [ -n "$failed" ]; then
	echo "deploy: FAILED verification, these files still differ:$failed" >&2
	exit 4
fi
echo "deploy: $(ls "$SRC"/lib/*.js | wc -l | tr -d ' ') files byte-identical"
echo
echo "Expected hashes of the deployed lib/ (compare against amp_accounts.source.modules):"
for path in "$SRC"/lib/*.js; do
	printf '  %-16s %s\n' "$(basename "$path")" "$(fingerprint "$path")"
done
echo
echo "A HOST RESTART IS STILL REQUIRED. Then verify the loaded build for free:"
echo "  index.js (amp_accounts.source.hash) = $(fingerprint "$SRC/lib/index.js")"
echo "  live.js  (amp_run.source.hash)      = $(fingerprint "$SRC/lib/live.js")"
