// The session runner: a background program that starts Claude Code sessions in
// terminals it holds, so they keep running when talos restarts. talos starts
// it (see runner-client.ts) and talks to it through a file socket only this
// user can open. `talos runner stop` ends it and every session it holds.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import type { TrustChange } from "../claude/claude-trust";
import { parseJsonOrNull } from "../json";
import { ASK_CHECK_MS, HOME_MODE, RUNNER_SOCKET_MODE, TALOS_MCP_SERVER_KEY, TOOLS_SERVER_SCRIPT, TRANSCRIPT_CHECK_MS } from "../constants";
import { controlServeOptions, putTrustBack, stopRunner } from "./control-server";
import { startHookServer } from "./hook-server";
import { log, paths, useRunnerInputs, type RunnerInputs } from "./inputs";
import { applyLaneEvent } from "./session-state";
import { heldSessions } from "./store";
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
  } catch {
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

export const runSessionRunner = async (inputs: RunnerInputs): Promise<void> => {
  useRunnerInputs(inputs);
  const { home, runnerSocket, hooksSocket, mcpConfig, runnerLock, trustChanges } = paths();
  await mkdir(home, { recursive: true, mode: HOME_MODE });
  if (!takeRunnerLock(runnerLock)) {
    log.event("runner: another session runner holds this home; leaving it be");
    process.exit(0);
  }
  await putTrustBack(await leftTrustChanges(trustChanges));
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
  setInterval(() => [...heldSessions.keys()].forEach((sessionName) => applyLaneEvent(sessionName, { type: "tick" })), ASK_CHECK_MS);
  log.event(`runner: listening on ${runnerSocket}`);
};
