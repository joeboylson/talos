#!/bin/sh
# talos-sessions' own check: typecheck the module on its own, then run its tests
# and every example's free tests. Everything that tests talos calls this, and
# the module's own repo would too. (The boundary test, in talos, is what proves
# the module stands alone.)
set -e
cd "$(dirname "$0")"
bun x tsc --noEmit -p tsconfig.json
# CI=true: a stray test.only fails instead of skipping the tests beside it.
# The mod's own tests run under Claude Code's kit, not bun (below).
CI=true bun test --path-ignore-patterns 'mod/**' .
# The mod is checked by Claude Code itself, so only where it's installed (not CI).
if command -v claude >/dev/null 2>&1; then
  claude plugin validate mod >/dev/null
  claude plugin test mod
fi
