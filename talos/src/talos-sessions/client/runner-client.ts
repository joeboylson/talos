import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { SESSION_LIMITS } from "../limits";
import { HOME_MODE, RUNNER_START_CHECK_MS, RUNNER_START_TIMEOUT_MS, homePaths } from "../constants";
import { RUNNER_ROUTES, parseRunnerEvent, type RunnerEvent } from "./runner-protocol";

// Requests to the session runner go over its file socket; the name in the
// address is ignored.
export const runnerFetch = (home: string, route: string, init: RequestInit = {}): Promise<Response> =>
  // A new connection each time, so a runner that has stopped is seen as gone at
  // once, not still reached through a kept connection.
  fetch(`http://talos-runner${route}`, { ...init, unix: homePaths(home).runnerSocket, keepalive: false } as RequestInit);

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
  const { log } = homePaths(home);
  await mkdir(home, { recursive: true, mode: HOME_MODE });
  // The log is written through for the runner's life, so it's kept short here.
  // shortcut: one runner that logs past the cap keeps growing it until it stops.
  const logBytes = await stat(log).then(({ size }) => size, () => 0);
  if (logBytes > SESSION_LIMITS.maxRunnerLogBytes) await rename(log, `${log}.1`);
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

// Calls onEvent for each event until the session runner goes away or the signal
// aborts; then resolves. Only failing to connect at all throws: a runner that
// stops mid-stream drops the connection, and that's the end of the stream.
// Bun gives up on a request after 5 quiet minutes; this stream is quiet
// whenever nothing happens, so its limit is turned off.
export const followRunnerEvents = async (home: string, onEvent: (runnerEvent: RunnerEvent) => void, signal?: AbortSignal): Promise<void> => {
  const response = await runnerFetch(home, RUNNER_ROUTES.events, { timeout: false, signal } as RequestInit);
  if (!response.body) return;
  const decoder = new TextDecoder();
  type LineReader = { read: () => Promise<{ done: boolean; value?: Uint8Array }> };
  const readLines = async (reader: LineReader, unfinishedLine: string): Promise<void> => {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
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
