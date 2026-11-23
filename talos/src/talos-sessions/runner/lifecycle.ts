// Starting a session, holding its terminal, and ending it.
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { trustFolder, type TrustChange } from "../claude/claude-trust";
import { LINK_ENV_KEYS } from "../link/link-protocol";
import { NO_FACTS } from "../link/fact-state";
import { HOOK_SCRIPT, SESSION_ENV_KEYS, TERMINAL_SIZE } from "../constants";
import type { StartSessionRequest } from "../client/runner-protocol";
import { buildSessionEnv, withOpenFileLimit } from "../claude/session-env";
import { buildHookSettings } from "../claude/session-hooks";
import { NO_LANE } from "../lanes/lane";
import { NO_OUTPUTS, NO_PLACING } from "../lanes/outputs";
import { appendOutput } from "../terminal";
import { claudeCommand, claudeConfigFile, isAllowedFolder, log, paths, restoresTrust, startLongestWaitMs } from "./inputs";
import { refuse } from "./refuse";

const SESSION_EXIT_WAIT_MS = 5000;
import { forgetTypedImages, typeIntoSession } from "./messages";
import { applyLaneEvent, setSessionState } from "./session-state";
import { writeWhole } from "./write-whole";
import { broadcastSessions, heldSessions, runnerState, sendToListeners, startingSessions, trustChanges, updateHeldSession, type HeldSession, type Terminal } from "./store";
import { SESSION_LIMITS } from "../limits";

const handleOutput = (sessionName: string, token: string, chunk: Uint8Array) => {
  const session = heldSessions.get(sessionName);
  if (session?.hookToken !== token) return;
  updateHeldSession(sessionName, token, { output: appendOutput(session.output, chunk, SESSION_LIMITS.maxOutputBytes) });
  sendToListeners(session.outputListeners, chunk);
};

// Written on every start and end, so it lists the groups of the sessions held now.
// A failed write (a full disk) is only logged: thrown mid-start or mid-end, it
// would leave a session listed forever.
const saveSessionGroups = (): void => {
  const groups = [...heldSessions.values()].map(({ child, startedAtMs }) => ({ groupId: child.pid, atMs: startedAtMs }));
  try {
    writeWhole(paths().sessionGroups, JSON.stringify(groups));
  } catch (error) {
    log.warn(`runner: couldn't save the session groups: ${error}`);
  }
};

const forgetSession = (sessionName: string, token: string) => {
  const session = heldSessions.get(sessionName);
  if (session?.hookToken !== token) return;
  heldSessions.delete(sessionName);
  forgetTypedImages(sessionName);
  saveSessionGroups();
  session.outputListeners.forEach((listener) => listener.close());
  void rm(join(paths().uploads, sessionName), { recursive: true, force: true }).catch((error: unknown) =>
    log.warn(`runner: couldn't delete ${sessionName}'s uploads: ${error}`),
  );
  log.event(`runner: session ${sessionName} ended`);
  broadcastSessions();
};

// Not a refusal: a runner that's going away is like one that isn't there.
const STOPPING = () => new Response("the session runner is stopping", { status: 503 });

const refuseNewSession = (sessionName: string): Response | null => {
  if (runnerState.isStopping) return STOPPING();
  if (runnerState.cannotStartWhy) return refuse("no-claude-code", runnerState.cannotStartWhy, 503);
  if (heldSessions.has(sessionName) || startingSessions.has(sessionName)) return refuse("already-running", `${sessionName} is already running`);
  if (heldSessions.size + startingSessions.size >= SESSION_LIMITS.maxSessions) return refuse("too-many-sessions", "too many sessions", 429);
  return null;
};

// Saved before Claude starts, so a runner that dies still leaves them to put back.
const keepTrustChange = (trustChange: TrustChange): void => {
  trustChanges.push(trustChange);
  writeWhole(paths().trustChanges, JSON.stringify(trustChanges));
};

// The name is held from the first check until the session is recorded, so a
// second start can't take it and a stop can wait for it (see waitForStart).
export const startSession = (request: StartSessionRequest): Promise<Response> => {
  const refusal = refuseNewSession(request.sessionName);
  if (refusal) return Promise.resolve(refusal);
  const starting = startHeldSession(request).finally(() => startingSessions.delete(request.sessionName));
  startingSessions.set(request.sessionName, starting);
  return starting;
};

export const waitForStart = async (sessionName: string): Promise<void> => {
  await startingSessions.get(sessionName)?.catch(() => {});
};

const startHeldSession = async ({ sessionName, folderName, path }: StartSessionRequest): Promise<Response> => {
  // The session runner checks the folder list itself, so nothing that reaches its
  // socket can start Claude (and mark it trusted) in any other folder.
  if (!(await isAllowedFolder(folderName, path))) return refuse("folder-not-allowed", `${path} isn't one of the allowed folders`, 403);
  // An allowed folder can be gone since it was added.
  if (!existsSync(path)) return refuse("folder-not-allowed", `${folderName} isn't there any more`, 403);
  const trustChange = await trustFolder(path, claudeConfigFile());
  if (trustChange && restoresTrust()) keepTrustChange(trustChange);
  if (runnerState.isStopping) return STOPPING();

  const hookCommand = `"${process.execPath}" "${HOOK_SCRIPT}"`;
  const hookToken = crypto.randomUUID();
  // The hook reads these from its env to reach the session runner; pin them in --settings
  // (below) as well as the spawn env so a project's own settings can't poison them.
  const hookEnv = {
    [SESSION_ENV_KEYS.sessionName]: sessionName,
    [SESSION_ENV_KEYS.runnerSocket]: paths().hooksSocket,
    [SESSION_ENV_KEYS.hookToken]: hookToken,
    [LINK_ENV_KEYS.socket]: paths().linkSocket,
    [LINK_ENV_KEYS.bun]: process.execPath,
    // An edit to the mod never reloads it mid-session (the snapshot can't
    // change anyway), and the pinned Claude Code never updates itself.
    CLAUDE_CODE_PLUGIN_DIR_WATCH: "0",
    DISABLE_AUTOUPDATER: "1",
  };
  // In the spawn env only: the mod unsets it once it has checked in.
  const linkToken = crypto.randomUUID();
  // --mcp-config gives every session talos's structured tools (tools-server.ts);
  // the PreToolUse hook decides when each may be called.
  // --permission-mode default: a fresh Claude Code config starts in auto mode.
  const claudeArgs = [
    ...claudeCommand(),
    "--session-id",
    crypto.randomUUID(),
    "--settings",
    buildHookSettings(hookCommand, hookEnv),
    "--mcp-config",
    paths().mcpConfig,
    "--plugin-dir",
    runnerState.modSnapshotFolder,
    "--permission-mode",
    "default",
  ];
  const child = Bun.spawn(
    [...withOpenFileLimit(SESSION_LIMITS.maxSessionOpenFiles), ...claudeArgs],
    {
      cwd: path,
      env: buildSessionEnv(process.env, { ...hookEnv, [LINK_ENV_KEYS.token]: linkToken }),
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
    link: { token: linkToken, isCheckedIn: false, secret: null, lastSeq: 0, commands: null, factView: NO_FACTS, lastHeardAtMs: 0 },
    startedAtMs: Date.now(),
    hasDraft: false,
    draftAtMs: 0,
    isTurnOver: false,
    isTalosTypedNext: false,
    output: new Uint8Array(),
    outputListeners: new Set(),
    isBeingRead: false,
    isWaitingToAsk: false,
  });
  saveSessionGroups();
  setTimeout(() => showStuckStart(sessionName, hookToken), startLongestWaitMs()).unref();
  void child.exited.then(() => forgetSession(sessionName, hookToken)).catch((error: unknown) => log.warn(`runner: couldn't clean up ${sessionName}: ${error}`));
  log.event(`runner: started session ${sessionName} in ${path}`);
  broadcastSessions();
  return new Response(null, { status: 201 });
};

// A session whose mod never reported its start is on a screen only the person
// can get past (a dialog before its hooks run), or its mod didn't load: it
// needs them, mid-turn, so nothing is typed into it (what was sent waits, and
// goes in once it starts) and the page says to answer in the terminal.
const showStuckStart = (sessionName: string, token: string): void => {
  const session = heldSessions.get(sessionName);
  if (session?.hookToken !== token || session.link.factView.activity !== "starting") return;
  log.warn(`runner: ${sessionName} hasn't started; it may be showing a screen only its terminal can answer`);
  setSessionState(sessionName, "needs-you", false);
};

// Claude leads its own process group (its terminal's), so signalling the group
// reaches what it started too, like a `nohup cmd &` from a Bash call. One that
// left the group (setsid) is out of reach.
const signalSession = (session: HeldSession, signal: NodeJS.Signals): void => {
  try {
    process.kill(-session.child.pid, signal);
  } catch {
    session.child.kill(signal);
  }
};

// Ends a session and waits until its Claude process is gone, so whatever comes
// after (like putting trust back) can't be undone by a session still closing.
// One that won't go within the wait is killed outright.
export const endSession = async (session: HeldSession): Promise<void> => {
  signalSession(session, "SIGTERM");
  const hasExited = await Promise.race([session.child.exited.then(() => true), Bun.sleep(SESSION_EXIT_WAIT_MS).then(() => false)]);
  if (!hasExited) signalSession(session, "SIGKILL");
  await session.child.exited;
  // What it started may outlive Claude by a moment, or ignore SIGTERM.
  signalSession(session, "SIGKILL");
};
