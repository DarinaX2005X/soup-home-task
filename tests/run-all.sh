#!/usr/bin/env bash
# Runs every test suite and keeps the raw output. A failing suite does not stop
# the next one: the point is a complete record, including what failed.
set -uo pipefail
out="${EVIDENCE_DIR:-.}"
mkdir -p "$out"
failed=0

echo "== API tests =="
npx vitest run --config vitest.config.ts 2>&1 | tee "$out/api-tests.txt" || failed=1

echo "== Browser tests =="
npx playwright test 2>&1 | tee "$out/e2e-tests.txt" || failed=1

exit $failed
