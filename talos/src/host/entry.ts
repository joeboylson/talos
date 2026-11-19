// The session host: a background program that starts Claude Code sessions in
// terminals it holds, so they keep running when talos restarts. talos starts
// it (see host-client.ts) and talks to it through a file socket only this
// user can open. `talos host stop` ends it and every session it holds.
import { chmod, mkdir, rm } from "node:fs/promises";
import {
  CREDENTIALS_FOLDER,
  CREDENTIALS_FOLDER_MODE,
  HOST_HOOKS_SOCKET,
  HOST_SOCKET,
  HOST_SOCKET_MODE,
  MCP_CONFIG_FILE,
  STATUS_CHECK_MS,
  TALOS_MCP_SERVER_KEY,
  TALOS_TOOLS_SCRIPT,
  TRANSCRIPT_CHECK_MS,
} from "../constants";
import { controlServeOptions } from "./control-server";
import { hookServeOptions } from "./hook-server";
import { log } from "./log";
import { applyStatusLaneEvent } from "./session-state";
import { heldSessions } from "./store";
import { readAllNewEntries } from "./transcript";

await Promise.all([rm(HOST_SOCKET, { force: true }), rm(HOST_HOOKS_SOCKET, { force: true })]);
// talos (and only talos) connects to the control socket. A session is told the
// hook socket instead, so a prompt-injected session can't reach the routes that
// drive other sessions.
await mkdir(CREDENTIALS_FOLDER, { recursive: true, mode: CREDENTIALS_FOLDER_MODE });
// The MCP config that gives every session talos's structured tools.
await Bun.write(
  MCP_CONFIG_FILE,
  JSON.stringify({ mcpServers: { [TALOS_MCP_SERVER_KEY]: { command: process.execPath, args: [TALOS_TOOLS_SCRIPT] } } }),
);

Bun.serve(controlServeOptions as unknown as Parameters<typeof Bun.serve>[0]);
Bun.serve(hookServeOptions as unknown as Parameters<typeof Bun.serve>[0]);
await chmod(HOST_SOCKET, HOST_SOCKET_MODE);
await chmod(HOST_HOOKS_SOCKET, HOST_SOCKET_MODE);
setInterval(readAllNewEntries, TRANSCRIPT_CHECK_MS);
setInterval(() => [...heldSessions.keys()].forEach((sessionName) => applyStatusLaneEvent(sessionName, { type: "tick" })), STATUS_CHECK_MS);
log.event(`host: listening on ${HOST_SOCKET}`);
