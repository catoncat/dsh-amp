#!/usr/bin/env bash
# One-command acceptance for dsh-amp.
#
#   bash verify.sh
#
# It answers the only two questions that matter before trusting the plugin: do the behaviour tests
# pass, and is the build the host LOADED the same one sitting in this tree? The second question has
# a trap this script exists to close: `deploy.sh --check` compares the installed copy with the
# source, which says nothing about the process that is already running. Only the runtime-reported
# per-file hashes can answer that, so the expected table is printed for the post-restart comparison.
set -uo pipefail
cd "$(dirname "$0")"

fail=0

echo "== 1/3 behaviour tests =="
if bash test/run.sh; then
	echo "   ok: suite green"
else
	echo "   FAIL: suite red"
	fail=1
fi

echo
echo "== 2/3 installed copy vs source =="
if bash deploy.sh --check; then
	echo "   ok: in sync"
else
	echo "   FAIL: drift — run deploy.sh, then restart the host"
	fail=1
fi

echo
echo "== 3/3 the runtime must report EXACTLY these hashes =="
for path in lib/*.js; do
	printf '   %-16s %s\n' "$(basename "$path")" "$(shasum -a 256 "$path" | cut -c1-12)"
done
cat <<'EOF'

Compare the table above against, in a session:
  amp_accounts -> source.modules  (+ source.hash / source.drift)
  amp_run      -> source.hash     (the agent-plane live.js)

If a hash differs, the host is running an older build: restart it. `drift: in-sync` alone is NOT
proof that a restart happened.
EOF

exit "$fail"
