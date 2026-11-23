#!/bin/sh
# talos-sessions' own check: typecheck the module on its own, then run its tests
# and every example's free tests. Everything that tests talos calls this, and
# the module's own repo would too. (The boundary test, in talos, is what proves
# the module stands alone.)
set -e
cd "$(dirname "$0")"
bunx tsc --noEmit -p tsconfig.json
# CI=true: a stray test.only fails instead of skipping the tests beside it.
CI=true bun test .
