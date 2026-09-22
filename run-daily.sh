#!/bin/sh
# Daily Orion tick, for a scheduler (cron, or an agent's cron) to call. Usage: ./run-daily.sh [asset]
#
#   stdout     the tick report, one JSON line (nothing only when orion itself could not start)
#   stderr     the fetch and signal summaries, the agent run's progress, or the error
#   exit code  orion tick's own: 0 completed (signal ok or degraded) or run_in_progress, 2 signal blocked, 1 no signal
#
# orion tick keeps the report in <ORION_HOME>/ticks.jsonl and every signal in <ORION_HOME>/signals.jsonl itself;
# this script keeps stderr in <ORION_HOME>/tick.log. Needs no environment. ORION_HOME defaults to this directory;
# secrets (RPC, CoinGecko, ANTHROPIC_API_KEY for the agent) belong in <ORION_HOME>/.env, which orion reads itself.
# Set ORION_NODE to node's absolute path when the scheduler's PATH does not have it.

asset="${1:-vvv}"
here="$(cd "$(dirname "$0")" && pwd)" || exit 1
ORION_HOME="${ORION_HOME:-$here}"
export ORION_HOME
node="${ORION_NODE:-node}"
cli="$here/dist/cli/index.js"

if ! command -v "$node" >/dev/null 2>&1; then
  echo "error: node not found on PATH ($PATH); set ORION_NODE to its absolute path" >&2
  exit 1
fi
if [ ! -f "$cli" ]; then
  echo "error: $cli is missing; run 'npm install && npm run build' in $here" >&2
  exit 1
fi

cd "$ORION_HOME" || exit 1
err="$(mktemp)" || exit 1
trap 'rm -f "$err"' EXIT

"$node" "$cli" tick "$asset" 2>"$err"
code=$?

{
  echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) tick $asset exit $code"
  cat "$err"
} >>tick.log
cat "$err" >&2
exit "$code"
