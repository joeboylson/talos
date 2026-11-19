// Starting a session, holding its terminal, and ending it.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { trustFolder } from "../claude-trust";
import {
  CLAUDE_COMMAND,
  HOOK_SCRIPT,
  HOST_HOOKS_SOCKET,
  MCP_CONFIG_FILE,
  READY_CHECK_MS,
  READY_QUIET_MS,
  SESSION_ENV_KEYS,
  TERMINAL_SIZE,
  UPLOADS_FOLDER,
} from "../constants";
import type { StartSessionRequest } from "../host-protocol";
import { buildSessionEnv } from "../session-env";
import { buildHookSettings } from "../session-hooks";
import { NO_STATUS_LANE } from "../status-lane";
import { appendOutput } from "../terminal";
import { log } from "./log";
import { typeIntoSession } from "./messages";
import { applyStatusLaneEvent, setSessionState } from "./session-state";
import { broadcastSessions, heldSessions, updateHeldSession, type Terminal } from "./store";
import { LIMITS } from "talos-shared";
import { TALOS_LIMITS } from "../limits";

const handleOutput = (sessionName: string, token: string, chunk: Uint8Array) => {
  const session = heldSessions.get(sessionName);
  if (session?.hookToken !== token) return;
  updateHeldSession(sessionName, token, { output: appendOutput(session.output, chunk, TALOS_LIMITS.maxOutputBytes), lastOutputAtMs: Date.now() });
  session.outputListeners.forEach((listener) => listener.enqueue(chunk));
};

const forgetSession = (sessionName: string, token: string) => {
  const session = heldSessions.get(sessionName);
  if (session?.hookToken !== token) return;
  heldSessions.delete(sessionName);
  session.outputListeners.forEach((listener) => listener.close());
  void rm(join(UPLOADS_FOLDER, sessionName), { recursive: true, force: true }).catch((error: unknown) =>
    log.warn(`host: couldn't delete ${sessionName}'s uploads: ${error}`),
  );
  log.event(`host: session ${sessionName} ended`);
  broadcastSessions();
};

const refuseNewSession = (sessionName: string): Response | null => {
  if (heldSessions.has(sessionName)) return new Response(`${sessionName} is already running`, { status: 409 });
  if (heldSessions.size >= LIMITS.maxSessions) return new Response("too many sessions", { status: 429 });
  return null;
};

export const startSession = async ({ sessionName, folderName, path }: StartSessionRequest): Promise<Response> => {
  const refusal = refuseNewSession(sessionName);
  if (refusal) return refusal;
  await trustFolder(path);
  // Checked again after the wait: two starts of the same name can both pass the
  // first check, and the second would leave the first one's process running
  // with no record. Spawning and saving the record below happen in one step.
  const refusalAfterWait = refuseNewSession(sessionName);
  if (refusalAfterWait) return refusalAfterWait;

  const hookCommand = `"${process.execPath}" "${HOOK_SCRIPT}"`;
  const hookToken = crypto.randomUUID();
  // The hook reads these from its env to reach the host; pin them in --settings
  // (below) as well as the spawn env so a project's own settings can't poison them.
  const hookEnv = {
    [SESSION_ENV_KEYS.sessionName]: sessionName,
    [SESSION_ENV_KEYS.hostSocket]: HOST_HOOKS_SOCKET,
    [SESSION_ENV_KEYS.hookToken]: hookToken,
  };
  const child = Bun.spawn(
    // --mcp-config gives every session the report_status tool (status-tool.ts);
    // the PreToolUse hook decides when it may be called.
    [CLAUDE_COMMAND, "--session-id", crypto.randomUUID(), "--settings", buildHookSettings(hookCommand, hookEnv), "--mcp-config", MCP_CONFIG_FILE],
    {
      cwd: path,
      env: buildSessionEnv(process.env, hookEnv),
      terminal: { ...TERMINAL_SIZE, data: (_terminal: unknown, chunk: Uint8Array) => handleOutput(sessionName, hookToken, chunk) },
    } as Parameters<typeof Bun.spawn>[1],
  );
  // Bun's terminal option adds this to the spawned process; its types don't list it yet.
  const terminal = (child as unknown as { terminal: Terminal }).terminal;

  heldSessions.set(sessionName, {
    summary: { sessionName, folderName, state: "starting" },
    path,
    child,
    terminal,
    queuedMessages: [],
    transcript: null,
    entries: [],
    statusLane: NO_STATUS_LANE,
    hookToken,
    hasDraft: false,
    output: new Uint8Array(),
    lastOutputAtMs: 0,
    outputListeners: new Set(),
    isBeingRead: false,
    isBecomingReady: false,
    isWaitingToAsk: false,
  });
  void child.exited.then(() => forgetSession(sessionName, hookToken)).catch((error: unknown) => log.warn(`host: couldn't clean up ${sessionName}: ${error}`));
  log.event(`host: started session ${sessionName} in ${path}`);
  broadcastSessions();
  return new Response(null, { status: 201 });
};

// Once Claude Code's screen settles after it starts, the session is ready:
// type anything sent while it was starting.
export const becomeReadyWhenQuiet = async (sessionName: string, token: string, giveUpAtMs: number): Promise<void> => {
  // Bail if the session is gone, or was replaced by a new instance with the same
  // name, so a stale loop never drives the replacement.
  const startingSession = heldSessions.get(sessionName);
  if (startingSession?.hookToken !== token) return;
  const quietForMs = Date.now() - startingSession.lastOutputAtMs;
  if (quietForMs < READY_QUIET_MS && Date.now() < giveUpAtMs) {
    await Bun.sleep(READY_CHECK_MS);
    return becomeReadyWhenQuiet(sessionName, token, giveUpAtMs);
  }
  const session = heldSessions.get(sessionName);
  if (!session || session.hookToken !== token) return;
  heldSessions.set(sessionName, { ...session, queuedMessages: [] });
  // Messages sent during startup are the person typing, so they end any ask.
  // The session is then working, not idle, so a new ask waits for their Stop
  // instead of landing on top of them.
  const hasQueuedMessages = session.queuedMessages.length > 0;
  if (hasQueuedMessages) applyStatusLaneEvent(sessionName, { type: "person-typed", isTurnChanging: true });
  setSessionState(sessionName, hasQueuedMessages ? "working" : "idle");
  for (const message of session.queuedMessages) await typeIntoSession(session, message);
};
