// The session runner: a background program that starts Claude Code sessions in
// terminals it holds, so they keep running when talos restarts. talos starts
// it (see runner-client.ts) and talks to it through a file socket only this
// user can open. `talos runner stop` ends it and every session it holds.
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import type { TrustChange } from "../claude/claude-trust";
import { checkCatalog } from "../kinds";
import { parseJsonOrNull } from "../json";
import { join } from "node:path";
import {
  ASK_CHECK_MS,
  CLAUDE_COMMAND,
  CLAUDE_VERSIONS_FOLDER,
  HOME_MODE,
  MOD_FOLDER,
  PINNED_CLAUDE_CODE_VERSION,
  RUNNER_SOCKET_MODE,
  steadyNow,
  TALOS_MCP_SERVER_KEY,
  TOOLS_SERVER_SCRIPT,
  TRANSCRIPT_CHECK_MS,
} from "../constants";
import { pinClaudeCode } from "../claude/pinned-claude";
import { linkServeOptions, sendHeartbeats } from "./link-server";
import { snapshotMod } from "./mod-snapshot";
import { controlServeOptions, forgetTrustChanges, putTrustBack, stopRunner } from "./control-server";
import { startHookServer } from "./hook-server";
import { log, paths, useRunnerInputs, type RunnerInputs } from "./inputs";
import { applyLaneEvent } from "./session-state";
import { heldSessions, runnerState, trustChanges as keptTrustChanges, updateHeldSession } from "./store";
import { SESSION_LIMITS } from "../limits";
import { readAllNewEntries } from "./transcript";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// Process ids start over at boot, so one recorded before it means nothing now.
// shortcut: the boot time comes from the wall clock, so a clock moved forward by
// more than the time since boot makes records look older than the boot; that
// needs the jump and a second runner start together.
const BOOT_SLACK_MS = 60_000;
const bootAtMs = (): number => Date.now() - uptime() * 1000 - BOOT_SLACK_MS;

// Only one runner holds a home: a second one started at the same moment (two
// programs calling ensureRunning) would delete the first one's sockets. A lock
// left by a runner that died is taken over, and so is one whose number another
// process has since: that one started after the lock was written.
// shortcut: two runners taking over the same dead lock at the same moment can
// both get it; that needs a crash and a double start together.
const takeRunnerLock = (lockFile: string, isRetry = false): boolean => {
  try {
    writeFileSync(lockFile, String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    // Only a lock already there is worth looking at; anything else (a home it
    // can't write) is the real problem, and says so.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const holder = Number(readFileSync(lockFile, "utf8"));
    const isHolderAlive = Number.isInteger(holder) && holder > 0 && isAlive(holder);
    const holderStartedAtMs = isHolderAlive ? startedAtMsOf(holder) : null;
    const isLockHolders = holderStartedAtMs === null || holderStartedAtMs <= statSync(lockFile).mtimeMs + LEADER_START_SLACK_MS;
    if (isRetry || (isHolderAlive && isLockHolders)) return false;
    rmSync(lockFile, { force: true });
    return takeRunnerLock(lockFile, true);
  }
};

// Trust answers a runner that crashed or was killed left behind, put back now
// that none of its sessions run.
const leftTrustChanges = async (file: string): Promise<TrustChange[]> => {
  const saved = Bun.file(file);
  if (!(await saved.exists())) return [];
  const changes = parseJsonOrNull(await saved.text());
  return Array.isArray(changes) ? changes : [];
};

// The home holds the sockets and the MCP config every session runs, so it must
// be this user's own folder, closed to everyone else, even if it was made
// before (mkdir sets the mode only when it makes the folder).
const claimHome = async (home: string): Promise<void> => {
  await mkdir(home, { recursive: true, mode: HOME_MODE });
  const info = await lstat(home);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new Error(`${home} isn't a folder of this user's own`);
  await chmod(home, HOME_MODE);
};

// A lock that's gone or someone else's means this runner's home was deleted or
// taken over: it stops, ending its sessions.
const holdsLock = (lockFile: string): boolean => {
  try {
    return Number(readFileSync(lockFile, "utf8")) === process.pid;
  } catch {
    return false;
  }
};

// When the process with this id started (to the second), or null if there's none.
const startedAtMsOf = (pid: number): number | null => {
  const listed = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
  const startedAtMs = new Date(listed.stdout.toString().trim()).getTime();
  return listed.exitCode === 0 && Number.isFinite(startedAtMs) ? startedAtMs : null;
};

// What the sessions of a runner that died outright started is ended now. A
// group is still that session's when its leader is the process recorded (it
// started when the session did, as psutil tells processes apart), or the leader
// is gone and the group lives on: an id isn't handed out again while a group
// still has it. A process that got the number since is left alone.
const LEADER_START_SLACK_MS = 5_000;
const isStillTheSession = (groupId: number, atMs: number): boolean => {
  const leaderStartedAtMs = startedAtMsOf(groupId);
  return leaderStartedAtMs === null || Math.abs(leaderStartedAtMs - atMs) <= LEADER_START_SLACK_MS;
};
const endLeftSessionGroups = async (file: string): Promise<void> => {
  const saved = Bun.file(file);
  const groups = (await saved.exists()) ? parseJsonOrNull(await saved.text()) : [];
  const recent = (Array.isArray(groups) ? groups : []).filter(
    ({ groupId, atMs }) => Number.isInteger(groupId) && groupId > 1 && typeof atMs === "number" && atMs >= bootAtMs() && isStillTheSession(groupId, atMs),
  );
  recent.forEach(({ groupId }) => {
    try {
      process.kill(-groupId, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  await rm(file, { force: true });
};

// The Claude Code every session runs: the pinned copy, made from `claude` on
// the path or the installer's folder for that version. Without one, sessions
// are refused: the mod loads only in that version, and a session without it
// would never report its start.
const pinClaudeCodeOrRefuse = (pinnedFolder: string): readonly string[] => {
  const candidates = [Bun.which(CLAUDE_COMMAND), join(CLAUDE_VERSIONS_FOLDER, PINNED_CLAUDE_CODE_VERSION)];
  const pinned = pinClaudeCode(pinnedFolder, PINNED_CLAUDE_CODE_VERSION, candidates);
  if (pinned) {
    runnerState.expectedClaudeVersion = PINNED_CLAUDE_CODE_VERSION;
    return [pinned];
  }
  runnerState.cannotStartWhy = `talos needs Claude Code ${PINNED_CLAUDE_CODE_VERSION}, and this machine doesn't have it`;
  log.warn(`runner: ${runnerState.cannotStartWhy}`);
  return [CLAUDE_COMMAND];
};

export const runSessionRunner = async (inputs: RunnerInputs): Promise<void> => {
  checkCatalog({ kinds: inputs.kinds, proseTurn: inputs.proseTurn });
  useRunnerInputs(inputs);
  const { home, runnerSocket, hooksSocket, linkSocket, mcpConfig, runnerLock, trustChanges, modSnapshots, pinnedClaudeCode } = paths();
  await claimHome(home);
  if (!takeRunnerLock(runnerLock)) {
    log.event("runner: another session runner holds this home; leaving it be");
    process.exit(0);
  }
  await endLeftSessionGroups(paths().sessionGroups);
  // Tests pass their own Claude Code (a stand-in), which isn't pinned.
  if (!inputs.claudeCommand) useRunnerInputs({ ...inputs, claudeCommand: pinClaudeCodeOrRefuse(pinnedClaudeCode) });
  runnerState.modSnapshotFolder = snapshotMod(MOD_FOLDER, modSnapshots, PINNED_CLAUDE_CODE_VERSION).folder;
  // Kept to put back at the next stop if they can't be put back now, so the
  // record this runner writes still holds them.
  const left = await leftTrustChanges(trustChanges);
  if (await putTrustBack(left)) await forgetTrustChanges();
  else keptTrustChanges.push(...left);
  // A stop from the system (logout, kill) ends the sessions and puts trust back,
  // the same as stopRunner.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void stopRunner());
  await Promise.all([rm(runnerSocket, { force: true }), rm(hooksSocket, { force: true }), rm(linkSocket, { force: true })]);
  // The MCP config that gives every session talos's structured tools.
  await Bun.write(
    mcpConfig,
    JSON.stringify({ mcpServers: { [TALOS_MCP_SERVER_KEY]: { command: process.execPath, args: [TOOLS_SERVER_SCRIPT] } } }),
  );
  
  Bun.serve(controlServeOptions(runnerSocket) as unknown as Parameters<typeof Bun.serve>[0]);
  startHookServer(hooksSocket);
  Bun.serve(linkServeOptions(linkSocket) as unknown as Parameters<typeof Bun.serve>[0]);
  await chmod(runnerSocket, RUNNER_SOCKET_MODE);
  await chmod(hooksSocket, RUNNER_SOCKET_MODE);
  await chmod(linkSocket, RUNNER_SOCKET_MODE);
  setInterval(sendHeartbeats, SESSION_LIMITS.linkHeartbeatMs);
  setInterval(readAllNewEntries, TRANSCRIPT_CHECK_MS);
  setInterval(() => {
    if (!holdsLock(runnerLock)) return void stopRunner();
    [...heldSessions.values()]
      .filter(({ hasDraft, draftAtMs }) => hasDraft && steadyNow() - draftAtMs > SESSION_LIMITS.draftForgetMs)
      .forEach(({ summary, hookToken }) => updateHeldSession(summary.sessionName, hookToken, { hasDraft: false }));
    [...heldSessions.keys()].forEach((sessionName) => applyLaneEvent(sessionName, { type: "tick" }));
  }, ASK_CHECK_MS);
  log.event(`runner: listening on ${runnerSocket}`);
};
