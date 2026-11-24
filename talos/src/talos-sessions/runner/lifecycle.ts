// Starting a session, holding it, and ending it.
import { existsSync } from "node:fs";
import { trustFolder, type TrustChange } from "../claude/claude-trust";
import { LINK_ENV_KEYS } from "../link/link-protocol";
import type { StartSessionRequest } from "../client/runner-protocol";
import { buildSessionEnv, withOpenFileLimit } from "../claude/session-env";
import { buildSessionSettings } from "../claude/session-settings";
import { NO_LANE } from "../lanes/lane";
import { NO_OUTPUTS, NO_PLACING } from "../lanes/outputs";
import { claudeCommand, claudeConfigFile, isAllowedFolder, log, paths, restoresTrust, startLongestWaitMs } from "./inputs";
import { refuse } from "./refuse";

const SESSION_EXIT_WAIT_MS = 5000;
import { setSessionState } from "./session-state";
import { START_REQUEST_ID, followErrors, followStream } from "./stream";
import { writeLine } from "./submit";
import { writeWhole } from "./write-whole";
import { broadcastSessions, heldSessions, runnerState, startingSessions, trustChanges, type HeldSession } from "./store";
import { SESSION_LIMITS } from "../limits";

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
  if (session?.heldId !== token) return;
  heldSessions.delete(sessionName);
  saveSessionGroups();
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

  const heldId = crypto.randomUUID();
  // The mod reads these from its env to reach the session runner; pinned in
  // --settings (below) as well as the spawn env so a project's own settings
  // can't change them.
  const sessionEnv = {
    [LINK_ENV_KEYS.socket]: paths().linkSocket,
    // An edit to the mod never reloads it mid-session (the snapshot can't
    // change anyway), and the pinned Claude Code never updates itself.
    CLAUDE_CODE_PLUGIN_DIR_WATCH: "0",
    DISABLE_AUTOUPDATER: "1",
  };
  // In the spawn env only: the mod unsets it once it has checked in.
  const linkToken = crypto.randomUUID();
  // Headless: no terminal, JSON lines both ways (see stream/stream-lines.ts).
  // Its own messages come back too, so the conversation has them in order;
  // permission questions come on the stream. Auto mode: Claude Code approves
  // what it judges safe itself, and asks the person on the page about the rest.
  const claudeArgs = [
    ...claudeCommand(),
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--permission-prompt-tool",
    "stdio",
    "--session-id",
    crypto.randomUUID(),
    "--settings",
    buildSessionSettings(sessionEnv),
    "--plugin-dir",
    runnerState.modSnapshotFolder,
    "--permission-mode",
    "auto",
  ];
  const child = Bun.spawn(
    [...withOpenFileLimit(SESSION_LIMITS.maxSessionOpenFiles), ...claudeArgs],
    {
      cwd: path,
      env: buildSessionEnv(process.env, { ...sessionEnv, [LINK_ENV_KEYS.token]: linkToken }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Its own process group, as a terminal gave it, so ending the session
      // reaches what it started too.
      detached: true,
    },
  );

  heldSessions.set(sessionName, {
    summary: { sessionName, folderName, state: "starting", asks: {}, openOutputs: [] },
    path,
    child,
    queuedMessages: [],
    entries: [],
    runningTools: new Map(),
    waitingPermissions: [],
    lane: NO_LANE,
    outputs: NO_OUTPUTS,
    nextPosition: 0,
    placing: NO_PLACING,
    heldAnswers: [],
    heldId,
    link: { token: linkToken, isCheckedIn: false, secret: null, lastHeardAtMs: 0 },
    startedAtMs: Date.now(),
    isTurnOver: false,
    isInterrupting: false,
  });
  saveSessionGroups();
  void followStream(sessionName, heldId, child.stdout).catch((error: unknown) => log.warn(`runner: couldn't read ${sessionName}'s stream: ${error}`));
  void followErrors(sessionName, child.stderr).catch(() => {});
  // The Agent SDK's first line too: Claude Code answers it once it's ready.
  writeLine(heldSessions.get(sessionName)!, `${JSON.stringify({ type: "control_request", request_id: START_REQUEST_ID, request: { subtype: "initialize" } })}\n`);
  setTimeout(() => showStuckStart(sessionName, heldId), startLongestWaitMs()).unref();
  void child.exited.then(() => forgetSession(sessionName, heldId)).catch((error: unknown) => log.warn(`runner: couldn't clean up ${sessionName}: ${error}`));
  log.event(`runner: started session ${sessionName} in ${path}`);
  broadcastSessions();
  return new Response(null, { status: 201 });
};

// A session whose Claude Code never said it's ready is stuck: it needs the
// person, mid-turn, so nothing goes into it (what was sent waits, and goes in
// once it starts).
const showStuckStart = (sessionName: string, token: string): void => {
  const session = heldSessions.get(sessionName);
  if (session?.heldId !== token || session.summary.state !== "starting") return;
  log.warn(`runner: ${sessionName} hasn't started`);
  setSessionState(sessionName, "needs-you", false);
};

// Claude leads its own process group (spawned detached), so signalling the group
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
