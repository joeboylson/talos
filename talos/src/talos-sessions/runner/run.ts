// The session runner: a background program that starts Claude Code sessions in
// terminals it holds, so they keep running when talos restarts. talos starts
// it (see runner-client.ts) and talks to it through a file socket only this
// user can open. `talos runner stop` ends it and every session it holds.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import type { TrustChange } from "../claude/claude-trust";
import { parseJsonOrNull } from "../json";
import { ASK_CHECK_MS, HOME_MODE, RUNNER_SOCKET_MODE, TALOS_MCP_SERVER_KEY, TOOLS_SERVER_SCRIPT, TRANSCRIPT_CHECK_MS } from "../constants";
import { controlServeOptions, forgetTrustChanges, putTrustBack, stopRunner } from "./control-server";
import { startHookServer } from "./hook-server";
import { log, paths, useRunnerInputs, type RunnerInputs } from "./inputs";
import { applyLaneEvent } from "./session-state";
import { heldSessions, trustChanges as keptTrustChanges, updateHeldSession } from "./store";
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

// Only one runner holds a home: a second one started at the same moment (two
// programs calling ensureRunning) would delete the first one's sockets. A lock
// left by a runner that died is taken over.
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
    if (isRetry || (Number.isInteger(holder) && holder > 0 && isAlive(holder))) return false;
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

// What the sessions of a runner that died outright started is ended now: a
// group still alive with a recorded number is that session's.
// shortcut: a group number can only be reused once process ids wrap around, so
// groups recorded over an hour ago are left alone rather than risk another's.
const LEFT_GROUP_MAX_AGE_MS = 60 * 60_000;
const endLeftSessionGroups = async (file: string): Promise<void> => {
  const saved = Bun.file(file);
  const groups = (await saved.exists()) ? parseJsonOrNull(await saved.text()) : [];
  const recent = (Array.isArray(groups) ? groups : []).filter(
    ({ groupId, atMs }) => Number.isInteger(groupId) && groupId > 1 && typeof atMs === "number" && Date.now() - atMs < LEFT_GROUP_MAX_AGE_MS,
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

export const runSessionRunner = async (inputs: RunnerInputs): Promise<void> => {
  useRunnerInputs(inputs);
  const { home, runnerSocket, hooksSocket, mcpConfig, runnerLock, trustChanges } = paths();
  await claimHome(home);
  if (!takeRunnerLock(runnerLock)) {
    log.event("runner: another session runner holds this home; leaving it be");
    process.exit(0);
  }
  await endLeftSessionGroups(paths().sessionGroups);
  // Kept to put back at the next stop if they can't be put back now, so the
  // record this runner writes still holds them.
  const left = await leftTrustChanges(trustChanges);
  if (await putTrustBack(left)) await forgetTrustChanges();
  else keptTrustChanges.push(...left);
  // A stop from the system (logout, kill) ends the sessions and puts trust back,
  // the same as stopRunner.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void stopRunner());
  await Promise.all([rm(runnerSocket, { force: true }), rm(hooksSocket, { force: true })]);
  // talos (and only talos) connects to the control socket. A session is told the
  // hook socket instead, so a prompt-injected session can't reach the routes that
  // drive other sessions.
  // The MCP config that gives every session talos's structured tools.
  await Bun.write(
    mcpConfig,
    JSON.stringify({ mcpServers: { [TALOS_MCP_SERVER_KEY]: { command: process.execPath, args: [TOOLS_SERVER_SCRIPT] } } }),
  );
  
  Bun.serve(controlServeOptions(runnerSocket) as unknown as Parameters<typeof Bun.serve>[0]);
  startHookServer(hooksSocket);
  await chmod(runnerSocket, RUNNER_SOCKET_MODE);
  await chmod(hooksSocket, RUNNER_SOCKET_MODE);
  setInterval(readAllNewEntries, TRANSCRIPT_CHECK_MS);
  setInterval(() => {
    if (!holdsLock(runnerLock)) return void stopRunner();
    [...heldSessions.values()]
      .filter(({ hasDraft, draftAtMs }) => hasDraft && Date.now() - draftAtMs > SESSION_LIMITS.draftForgetMs)
      .forEach(({ summary, hookToken }) => updateHeldSession(summary.sessionName, hookToken, { hasDraft: false }));
    [...heldSessions.keys()].forEach((sessionName) => applyLaneEvent(sessionName, { type: "tick" }));
  }, ASK_CHECK_MS);
  log.event(`runner: listening on ${runnerSocket}`);
};
