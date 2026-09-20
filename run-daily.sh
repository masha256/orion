#!/bin/sh
# Daily Orion run, for a scheduler (cron, or an agent's cron) to call. Usage: ./run-daily.sh [asset]
#
#   stdout     the signal, one JSON line (nothing on exit 1)
#   stderr     the fetch summary, or the error
#   exit code  orion update's own: 0 ok or degraded, 2 blocked, 1 error
#
# Both streams are also kept: the signal in <ORION_HOME>/signals.jsonl, stderr in <ORION_HOME>/update.log.
# Needs no environment. ORION_HOME defaults to this directory; secrets belong in <ORION_HOME>/.env, which
# orion reads itself. Set ORION_NODE to node's absolute path when the scheduler's PATH does not have it.

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

"$node" "$cli" update "$asset" --out signals.jsonl 2>"$err"
code=$?

{
  echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) update $asset exit $code"
  cat "$err"
} >>update.log
cat "$err" >&2
exit "$code"
