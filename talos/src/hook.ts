// Claude Code runs this on each hook event (see buildHookSettings) and passes
// the event's details on stdin. It hands them to the session host and prints
// back whatever decision the host returns (empty for most events). For the
// status lane the host returns a PreToolUse allow/deny or a Stop block, which
// Claude Code then enforces. If the host is slow or unreachable it denies
// report_status (nothing would record it) and lets everything else through, so
// it can never hold Claude up.
import { parseJsonOrNull } from "talos-shared";
import { HOOK_TOKEN_HEADER, SESSION_ENV_KEYS } from "./constants";
import { hookReplyWhenHostUnreachable } from "./status-lane";
import { TALOS_LIMITS } from "./limits";

const sessionName = process.env[SESSION_ENV_KEYS.sessionName];
const hostSocket = process.env[SESSION_ENV_KEYS.hostSocket];
const hookToken = process.env[SESSION_ENV_KEYS.hookToken];

if (sessionName && hostSocket) {
  const hookDetails = await Bun.stdin.text();
  const decision = await fetch(`http://talos-host/hooks/${encodeURIComponent(sessionName)}`, {
    method: "POST",
    body: hookDetails,
    headers: hookToken ? { [HOOK_TOKEN_HEADER]: hookToken } : {},
    unix: hostSocket,
    signal: AbortSignal.timeout(TALOS_LIMITS.hookTimeoutMs),
  } as RequestInit)
    .then((response) => response.text())
    .catch(() => hookReplyWhenHostUnreachable(parseJsonOrNull(hookDetails)));
  if (decision) process.stdout.write(decision);
}
process.exit(0);
