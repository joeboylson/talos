// Claude Code runs this on each hook event (see buildHookSettings) and passes
// the event's details on stdin. It hands them to the session host and prints
// back whatever decision the host returns (empty for most events). For the
// status lane the host returns a PreToolUse allow/deny or a Stop block, which
// Claude Code then enforces. If the host is slow or unreachable it denies the
// structured tools (nothing would record them) and lets everything else through,
// so it can never hold Claude up. A tool call too big for the host to read is
// denied outright, since talos can't check it.
import { parseJsonOrNull } from "talos-shared";
import { HOOK_TOKEN_HEADER, HTTP_PAYLOAD_TOO_LARGE, SESSION_ENV_KEYS } from "./constants";
import { hookReplyWhenHostUnreachable, hookReplyWhenTooBig } from "./status-lane";
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
    .then((response) => {
      if (response.status === HTTP_PAYLOAD_TOO_LARGE) return hookReplyWhenTooBig(parseJsonOrNull(hookDetails));
      return response.ok ? response.text() : hookReplyWhenHostUnreachable(parseJsonOrNull(hookDetails));
    })
    .catch(() => hookReplyWhenHostUnreachable(parseJsonOrNull(hookDetails)));
  if (decision) process.stdout.write(decision);
}
process.exit(0);
