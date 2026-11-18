#!/bin/sh
# Talos's security checks, the same everywhere: `make security` on a laptop,
# GitHub on every push, and AWS CodeBuild before each publish (a failure there
# stops the publish). Fails only on high and critical problems.
#
#   sh dev/security/check.sh               the repo
#   sh dev/security/check.sh <image>       the repo, then a built server image
#
# Each tool runs from its official image, pinned to an exact digest, so nothing
# here can change under us. To update one, change its line below.
set -u

GITLEAKS="ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"
SEMGREP="semgrep/semgrep:1.183.0@sha256:2e45517a85e13a9cca14a2a00df6bb48affd66b8ebfae1b0991cd57578362fb0"
TRIVY="aquasec/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c"
ZIZMOR="ghcr.io/zizmorcore/zizmor:1.32.0@sha256:3014cc8f68f663935f69b3c3e0e41f5ce102b268d97db13db0f62208747f860d"

IMAGE="${1:-}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 1
FAILED=""

check() {
  name="$1"
  shift
  printf '\n== %s\n' "$name"
  if "$@"; then echo "ok"; else FAILED="$FAILED\n  - $name"; fi
}

# Packages with known holes.
check "Packages (bun audit)" bun audit --audit-level=high

# Keys, passwords or tokens committed by accident, anywhere in the history.
check "Leaked secrets (gitleaks)" \
  docker run --rm -v "$REPO:/repo:ro" "$GITLEAKS" git /repo --redact --no-banner --log-level warn

# Risky code: HTML built from input, shell commands, weak crypto and so on.
check "Risky code (Semgrep)" \
  docker run --rm -v "$REPO:/src:ro" -w /src "$SEMGREP" semgrep scan \
    --config p/javascript --config p/typescript --config p/react \
    --metrics off --severity ERROR --error --quiet --exclude node_modules --exclude docs

# Mistakes in the GitHub workflows themselves (they run with this repo's access).
check "Workflow setup (zizmor)" \
  docker run --rm -v "$REPO:/src:ro" "$ZIZMOR" --offline --min-severity high /src/.github/workflows

# Known holes in the server image's own system packages.
# Trivy reads the image straight from Docker, through Docker's own socket.
if [ -n "$IMAGE" ]; then
  check "Server image (Trivy)" \
    docker run --rm -v /var/run/docker.sock:/var/run/docker.sock:ro "$TRIVY" image --quiet --image-src docker --table-mode detailed \
      --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 "$IMAGE"
fi

if [ -n "$FAILED" ]; then
  printf '\nSecurity checks failed:%b\n' "$FAILED"
  exit 1
fi
printf '\nAll security checks passed.\n'
