import { readSessionList } from "talos-shared";
import type { SessionCommand } from "./commands";
import { DETACH_KEY } from "./constants";
import { hostFetch, isHostRunning, postToHost } from "./host-client";
import { HOST_ROUTES, sessionRoute } from "./host-protocol";

const fail = (problem: string): never => {
  console.error(`talos: ${problem}`);
  process.exit(1);
};

const listSessions = async () => {
  if (!(await isHostRunning())) return console.log("no sessions");
  const sessions = readSessionList(await (await hostFetch(HOST_ROUTES.sessions)).json()) ?? [];
  if (sessions.length === 0) return console.log("no sessions");
  sessions.forEach(({ sessionName, folderName, state }) => console.log(`${sessionName}\t${folderName}\t${state}`));
};

// Your terminal shows the session's own terminal and types into it, until
// Ctrl-\ leaves it running or the session ends.
const attach = async (sessionName: string) => {
  if (!(await isHostRunning())) return fail("no sessions are running");
  const outputResponse = await hostFetch(sessionRoute(sessionName, "output"));
  if (!outputResponse.ok || !outputResponse.body) return fail(`no session called ${sessionName}`);

  const matchTerminalSize = () =>
    postToHost(sessionRoute(sessionName, "resize"), { cols: process.stdout.columns, rows: process.stdout.rows });
  await matchTerminalSize();
  process.stdout.on("resize", matchTerminalSize);

  const leave = (message: string) => {
    process.stdin.setRawMode(false);
    process.stdout.write(`\r\n[talos] ${message}\r\n`);
    process.exit(0);
  };

  // Keystrokes go one request at a time, so they arrive in the order typed.
  let pendingInput: Promise<unknown> = Promise.resolve();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer) => {
    if (chunk.includes(DETACH_KEY)) return leave(`left ${sessionName} running`);
    pendingInput = pendingInput.then(() =>
      hostFetch(sessionRoute(sessionName, "input"), { method: "POST", body: chunk }),
    );
  });

  for await (const outputChunk of outputResponse.body) process.stdout.write(outputChunk);
  leave(`${sessionName} ended`);
};

export const runSessionCommand = async (command: SessionCommand): Promise<void> => {
  if (command.name === "sessions-list") return listSessions();
  if (command.name === "sessions-attach") return attach(command.sessionName);
  if (!(await isHostRunning()))
    return console.log(command.name === "host-stop" ? "the session host isn't running" : "no sessions");
  if (command.name === "sessions-stop") {
    await postToHost(sessionRoute(command.sessionName, "stop"), {});
    return console.log(`stopped ${command.sessionName}`);
  }
  await postToHost(HOST_ROUTES.stop, {});
  console.log("stopped the session host and its sessions");
};
