import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import {
  CREDENTIALS_FOLDER,
  CREDENTIALS_FOLDER_MODE,
  HOST_LOG,
  HOST_SCRIPT,
  HOST_SOCKET,
  HOST_START_CHECK_MS,
  HOST_START_TIMEOUT_MS,
} from "./constants";
import { HOST_ROUTES, parseHostEvent, type HostEvent } from "./host-protocol";

// Requests to the session host go over its file socket; the host name in the
// address is ignored.
export const hostFetch = (route: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://talos-host${route}`, { ...init, unix: HOST_SOCKET } as RequestInit);

export const postToHost = (route: string, body: unknown): Promise<Response> =>
  hostFetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const isHostRunning = (): Promise<boolean> =>
  hostFetch(HOST_ROUTES.health).then(
    (response) => response.ok,
    () => false,
  );

// Started on its own, outside talos's process group, so restarting talos
// (or closing its terminal) leaves the host and its sessions running.
const startHost = async (): Promise<void> => {
  await mkdir(CREDENTIALS_FOLDER, { recursive: true, mode: CREDENTIALS_FOLDER_MODE });
  await rm(HOST_SOCKET, { force: true });
  const logFile = openSync(HOST_LOG, "a");
  const host = spawn(process.execPath, [HOST_SCRIPT], { detached: true, stdio: ["ignore", logFile, logFile], env: process.env });
  host.unref();
};

const waitForHost = async (deadlineMs: number): Promise<void> => {
  if (await isHostRunning()) return;
  if (Date.now() > deadlineMs) throw new Error(`the session host didn't start; see ${HOST_LOG}`);
  await Bun.sleep(HOST_START_CHECK_MS);
  return waitForHost(deadlineMs);
};

export const ensureHostRunning = async (): Promise<void> => {
  if (await isHostRunning()) return;
  await startHost();
  await waitForHost(Date.now() + HOST_START_TIMEOUT_MS);
};

// Calls onEvent for each event until the host goes away; then resolves.
// Bun gives up on a request after 5 quiet minutes; this stream is quiet
// whenever nothing happens, so its limit is turned off.
export const followHostEvents = async (onEvent: (hostEvent: HostEvent) => void): Promise<void> => {
  const response = await hostFetch(HOST_ROUTES.events, { timeout: false } as RequestInit);
  if (!response.body) return;
  const decoder = new TextDecoder();
  type LineReader = { read: () => Promise<{ done: boolean; value?: Uint8Array }> };
  const readLines = async (reader: LineReader, unfinishedLine: string): Promise<void> => {
    const { done, value } = await reader.read();
    if (done) return;
    const lines = (unfinishedLine + decoder.decode(value, { stream: true })).split("\n");
    lines.slice(0, -1).forEach((line) => {
      const hostEvent = parseHostEvent(line);
      if (hostEvent) onEvent(hostEvent);
    });
    return readLines(reader, lines.at(-1) ?? "");
  };
  await readLines(response.body.getReader(), "");
};
