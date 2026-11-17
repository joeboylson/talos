// Claude Code runs this on each hook event (see buildHookSettings) and passes
// the event's details on stdin. It hands them to the session host and exits.
// It always exits cleanly and prints nothing, so it can never hold Claude up
// or change what Claude does.
import { HOOK_TIMEOUT_MS, SESSION_ENV_KEYS } from "./constants";

const sessionName = process.env[SESSION_ENV_KEYS.sessionName];
const hostSocket = process.env[SESSION_ENV_KEYS.hostSocket];

if (sessionName && hostSocket) {
  const hookDetails = await Bun.stdin.text();
  await fetch(`http://talos-host/hooks/${encodeURIComponent(sessionName)}`, {
    method: "POST",
    body: hookDetails,
    unix: hostSocket,
    signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
  } as RequestInit).catch(() => undefined);
}
process.exit(0);
