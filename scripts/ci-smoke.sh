#!/usr/bin/env bash
# CI's UI smoke test: starts a test copy with empty data, drives it with scripts/ui-smoke.mjs and stops it again.
# Exits with the smoke test's code. On Linux CI runs it as `xvfb-run -a bash scripts/ci-smoke.sh`; it's a script
# rather than an exported bash function because xvfb-run is a /bin/sh script, and dash drops exported functions.
# Needs `npm run build` first. Locally: bash scripts/ci-smoke.sh (owner "ci", like CI).
set -euo pipefail
cd "$(dirname "$0")/.."

out=$(npm run -s test-instance -- start --owner ci --data empty) || exit 1
id=$(node -p 'JSON.parse(process.argv[1]).id' "$out")
node scripts/ui-smoke.mjs "$id" --owner ci && rc=0 || rc=$? # the copy is stopped either way
npm run -s test-instance -- stop "$id" --owner ci
exit "$rc"
