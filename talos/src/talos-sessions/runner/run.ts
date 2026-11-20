// The session runner: a background program that starts Claude Code sessions in
// terminals it holds, so they keep running when talos restarts. talos starts
// it (see runner-client.ts) and talks to it through a file socket only this
// user can open. `talos runner stop` ends it and every session it holds.
import { chmod, mkdir, rm } from "node:fs/promises";
import {
  TALOS_FOLDER,
  TALOS_FOLDER_MODE,
  RUNNER_HOOKS_SOCKET,
  RUNNER_SOCKET,
  RUNNER_SOCKET_MODE,
  MCP_CONFIG_FILE,
  STATUS_CHECK_MS,
  TALOS_MCP_SERVER_KEY,
  TOOLS_SERVER_SCRIPT,
  TRANSCRIPT_CHECK_MS,
} from "../constants";
import { controlServeOptions } from "./control-server";
import { startHookServer } from "./hook-server";
import { log } from "./log";
import { applyStatusLaneEvent } from "./session-state";
import { heldSessions } from "./store";
import { readAllNewEntries } from "./transcript";

export const runSessionRunner = async (): Promise<void> => {
  await Promise.all([rm(RUNNER_SOCKET, { force: true }), rm(RUNNER_HOOKS_SOCKET, { force: true })]);
  // talos (and only talos) connects to the control socket. A session is told the
  // hook socket instead, so a prompt-injected session can't reach the routes that
  // drive other sessions.
  await mkdir(TALOS_FOLDER, { recursive: true, mode: TALOS_FOLDER_MODE });
  // The MCP config that gives every session talos's structured tools.
  await Bun.write(
    MCP_CONFIG_FILE,
    JSON.stringify({ mcpServers: { [TALOS_MCP_SERVER_KEY]: { command: process.execPath, args: [TOOLS_SERVER_SCRIPT] } } }),
  );
  
  Bun.serve(controlServeOptions as unknown as Parameters<typeof Bun.serve>[0]);
  startHookServer();
  await chmod(RUNNER_SOCKET, RUNNER_SOCKET_MODE);
  await chmod(RUNNER_HOOKS_SOCKET, RUNNER_SOCKET_MODE);
  setInterval(readAllNewEntries, TRANSCRIPT_CHECK_MS);
  setInterval(() => [...heldSessions.keys()].forEach((sessionName) => applyStatusLaneEvent(sessionName, { type: "tick" })), STATUS_CHECK_MS);
  log.event(`runner: listening on ${RUNNER_SOCKET}`);
};
