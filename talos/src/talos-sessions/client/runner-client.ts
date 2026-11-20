import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import {
  TALOS_FOLDER,
  TALOS_FOLDER_MODE,
  RUNNER_LOG,
  RUNNER_SOCKET,
  RUNNER_START_CHECK_MS,
  RUNNER_START_TIMEOUT_MS,
} from "../constants";
import { RUNNER_ROUTES, parseRunnerEvent, type RunnerEvent } from "./runner-protocol";

// Requests to the session runner go over its file socket; the name in the
// address is ignored.
export const runnerFetch = (route: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://talos-runner${route}`, { ...init, unix: RUNNER_SOCKET } as RequestInit);

export const postToRunner = (route: string, body: unknown): Promise<Response> =>
  runnerFetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const isRunnerRunning = (): Promise<boolean> =>
  runnerFetch(RUNNER_ROUTES.health).then(
    (response) => response.ok,
    () => false,
  );

// Started on its own, outside talos's process group, so restarting talos
// (or closing its terminal) leaves the session runner and its sessions running.
const startRunner = async (runnerScript: string): Promise<void> => {
  await mkdir(TALOS_FOLDER, { recursive: true, mode: TALOS_FOLDER_MODE });
  await rm(RUNNER_SOCKET, { force: true });
  const logFile = openSync(RUNNER_LOG, "a");
  const runner = spawn(process.execPath, [runnerScript], { detached: true, stdio: ["ignore", logFile, logFile], env: process.env });
  runner.unref();
};

const waitForRunner = async (deadlineMs: number): Promise<void> => {
  if (await isRunnerRunning()) return;
  if (Date.now() > deadlineMs) throw new Error(`the session runner didn't start; see ${RUNNER_LOG}`);
  await Bun.sleep(RUNNER_START_CHECK_MS);
  return waitForRunner(deadlineMs);
};

// runnerScript is the program that calls runSessionRunner (talos's session-runner.ts).
export const ensureRunnerRunning = async (runnerScript: string): Promise<void> => {
  if (await isRunnerRunning()) return;
  await startRunner(runnerScript);
  await waitForRunner(Date.now() + RUNNER_START_TIMEOUT_MS);
};

// Calls onEvent for each event until the session runner goes away; then resolves.
// Bun gives up on a request after 5 quiet minutes; this stream is quiet
// whenever nothing happens, so its limit is turned off.
export const followRunnerEvents = async (onEvent: (runnerEvent: RunnerEvent) => void): Promise<void> => {
  const response = await runnerFetch(RUNNER_ROUTES.events, { timeout: false } as RequestInit);
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
