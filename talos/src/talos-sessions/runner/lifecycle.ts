// Starting a session, holding its terminal, and ending it.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { trustFolder } from "../claude/claude-trust";
import {
  HOOK_SCRIPT,
  READY_CHECK_MS,
  READY_QUIET_MS,
  SESSION_ENV_KEYS,
  TERMINAL_SIZE,
} from "../constants";
import type { StartSessionRequest } from "../client/runner-protocol";
import { buildSessionEnv, withOpenFileLimit } from "../claude/session-env";
import { buildHookSettings } from "../claude/session-hooks";
import { NO_LANE } from "../lanes/lane";
import { NO_OUTPUTS, NO_PLACING } from "../lanes/outputs";
import { appendOutput } from "../terminal";
import { claudeCommand, claudeConfigFile, log, paths, restoresTrust } from "./inputs";
import { refuse } from "./refuse";

const SESSION_EXIT_WAIT_MS = 5000;
import { typeIntoSession } from "./messages";
import { applyLaneEvent, setSessionState } from "./session-state";
import { broadcastSessions, heldSessions, sendToListeners, trustChanges, updateHeldSession, type HeldSession, type Terminal } from "./store";
import { SESSION_LIMITS } from "../limits";

const handleOutput = (sessionName: string, token: string, chunk: Uint8Array) => {
  const session = heldSessions.get(sessionName);
  if (session?.hookToken !== token) return;
  updateHeldSession(sessionName, token, { output: appendOutput(session.output, chunk, SESSION_LIMITS.maxOutputBytes), lastOutputAtMs: Date.now() });
  sendToListeners(session.outputListeners, chunk);
};

const forgetSession = (sessionName: string, token: string) => {
  const session = heldSessions.get(sessionName);
  if (session?.hookToken !== token) return;
  heldSessions.delete(sessionName);
  session.outputListeners.forEach((listener) => listener.close());
  void rm(join(paths().uploads, sessionName), { recursive: true, force: true }).catch((error: unknown) =>
    log.warn(`runner: couldn't delete ${sessionName}'s uploads: ${error}`),
  );
  log.event(`runner: session ${sessionName} ended`);
  broadcastSessions();
};

const refuseNewSession = (sessionName: string): Response | null => {
  if (heldSessions.has(sessionName)) return refuse("already-running", `${sessionName} is already running`);
  if (heldSessions.size >= SESSION_LIMITS.maxSessions) return refuse("too-many-sessions", "too many sessions", 429);
  return null;
};

export const startSession = async ({ sessionName, folderName, path }: StartSessionRequest): Promise<Response> => {
  const refusal = refuseNewSession(sessionName);
  if (refusal) return refusal;
  const trustChange = await trustFolder(path, claudeConfigFile());
  if (trustChange && restoresTrust()) trustChanges.push(trustChange);
  // Checked again after the wait: two starts of the same name can both pass the
  // first check, and the second would leave the first one's process running
  // with no record. Spawning and saving the record below happen in one step.
  const refusalAfterWait = refuseNewSession(sessionName);
  if (refusalAfterWait) return refusalAfterWait;

  const hookCommand = `"${process.execPath}" "${HOOK_SCRIPT}"`;
  const hookToken = crypto.randomUUID();
  // The hook reads these from its env to reach the session runner; pin them in --settings
  // (below) as well as the spawn env so a project's own settings can't poison them.
  const hookEnv = {
    [SESSION_ENV_KEYS.sessionName]: sessionName,
    [SESSION_ENV_KEYS.runnerSocket]: paths().hooksSocket,
    [SESSION_ENV_KEYS.hookToken]: hookToken,
  };
  // --mcp-config gives every session talos's structured tools (tools-server.ts);
  // the PreToolUse hook decides when each may be called.
  const claudeArgs = [...claudeCommand(), "--session-id", crypto.randomUUID(), "--settings", buildHookSettings(hookCommand, hookEnv), "--mcp-config", paths().mcpConfig];
  const child = Bun.spawn(
    [...withOpenFileLimit(SESSION_LIMITS.maxSessionOpenFiles), ...claudeArgs],
    {
      cwd: path,
      env: buildSessionEnv(process.env, hookEnv),
      terminal: { ...TERMINAL_SIZE, data: (_terminal: unknown, chunk: Uint8Array) => handleOutput(sessionName, hookToken, chunk) },
    } as Parameters<typeof Bun.spawn>[1],
  );
  // Bun's terminal option adds this to the spawned process; its types don't list it yet.
  const terminal = (child as unknown as { terminal: Terminal }).terminal;

  heldSessions.set(sessionName, {
    summary: { sessionName, folderName, state: "starting", asks: {}, openOutputs: [] },
    path,
    child,
    terminal,
    queuedMessages: [],
    transcripts: [],
    entries: [],
    lane: NO_LANE,
    outputs: NO_OUTPUTS,
    nextPosition: 0,
    placing: NO_PLACING,
    heldAnswers: [],
    hookToken,
    hasDraft: false,
    isTurnOver: false,
    isTalosTypedNext: false,
    output: new Uint8Array(),
    lastOutputAtMs: 0,
    outputListeners: new Set(),
    isBeingRead: false,
    isBecomingReady: false,
    isWaitingToAsk: false,
  });
  void child.exited.then(() => forgetSession(sessionName, hookToken)).catch((error: unknown) => log.warn(`runner: couldn't clean up ${sessionName}: ${error}`));
  log.event(`runner: started session ${sessionName} in ${path}`);
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
  if (hasQueuedMessages) applyLaneEvent(sessionName, { type: "person-typed", isTurnChanging: true });
  setSessionState(sessionName, hasQueuedMessages ? "working" : "idle");
  for (const message of session.queuedMessages) await typeIntoSession(session, message);
};

// Ends a session and waits until its Claude process is gone, so whatever comes
// after (like putting trust back) can't be undone by a session still closing.
// One that won't go within the wait is killed outright.
export const endSession = async (session: HeldSession): Promise<void> => {
  session.child.kill();
  const hasExited = await Promise.race([session.child.exited.then(() => true), Bun.sleep(SESSION_EXIT_WAIT_MS).then(() => false)]);
  if (!hasExited) {
    session.child.kill("SIGKILL");
    await session.child.exited;
  }
};
