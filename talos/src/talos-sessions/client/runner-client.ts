import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { HOME_MODE, RUNNER_START_CHECK_MS, RUNNER_START_TIMEOUT_MS, homePaths } from "../constants";
import { RUNNER_ROUTES, parseRunnerEvent, type RunnerEvent } from "./runner-protocol";

// Requests to the session runner go over its file socket; the name in the
// address is ignored.
export const runnerFetch = (home: string, route: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://talos-runner${route}`, { ...init, unix: homePaths(home).runnerSocket } as RequestInit);

export const postToRunner = (home: string, route: string, body: unknown): Promise<Response> =>
  runnerFetch(home, route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const isRunnerRunning = (home: string): Promise<boolean> =>
  runnerFetch(home, RUNNER_ROUTES.health).then(
    (response) => response.ok,
    () => false,
  );

// Started on its own, outside talos's process group, so restarting talos
// (or closing its terminal) leaves the session runner and its sessions running.
// The script gets the home as its argument, to hand to runSessionRunner.
const startRunner = async (home: string, runnerScript: string): Promise<void> => {
  const { runnerSocket, log } = homePaths(home);
  await mkdir(home, { recursive: true, mode: HOME_MODE });
  await rm(runnerSocket, { force: true });
  const logFile = openSync(log, "a");
  const runner = spawn(process.execPath, [runnerScript, home], { detached: true, stdio: ["ignore", logFile, logFile], env: process.env });
  runner.unref();
};

const waitForRunner = async (home: string, deadlineMs: number): Promise<void> => {
  if (await isRunnerRunning(home)) return;
  if (Date.now() > deadlineMs) throw new Error(`the session runner didn't start; see ${homePaths(home).log}`);
  await Bun.sleep(RUNNER_START_CHECK_MS);
  return waitForRunner(home, deadlineMs);
};

// runnerScript is the program that calls runSessionRunner (talos's session-runner.ts).
export const ensureRunnerRunning = async (home: string, runnerScript: string): Promise<void> => {
  if (await isRunnerRunning(home)) return;
  await startRunner(home, runnerScript);
  await waitForRunner(home, Date.now() + RUNNER_START_TIMEOUT_MS);
};

// Calls onEvent for each event until the session runner goes away; then resolves.
// Bun gives up on a request after 5 quiet minutes; this stream is quiet
// whenever nothing happens, so its limit is turned off.
export const followRunnerEvents = async (home: string, onEvent: (runnerEvent: RunnerEvent) => void): Promise<void> => {
  const response = await runnerFetch(home, RUNNER_ROUTES.events, { timeout: false } as RequestInit);
  if (!response.body) return;
  const decoder = new TextDecoder();
  type LineReader = { read: () => Promise<{ done: boolean; value?: Uint8Array }> };
  const readLines = async (reader: LineReader, unfinishedLine: string): Promise<void> => {
    const { done, value } = await reader.read();
    if (done) return;
    const lines = (unfinishedLine + decoder.decode(value, { stream: true })).split("\n");
    lines.slice(0, -1).forEach((line) => {
      const runnerEvent = parseRunnerEvent(line);
      if (runnerEvent) onEvent(runnerEvent);
    });
    return readLines(reader, lines.at(-1) ?? "");
  };
  await readLines(response.body.getReader(), "");
};
