import { ENV_KEYS, buildIdentifier, pickUniqueName, requireEnv, toIdentifierName, type Folder } from "talos-shared";
import { cliError, formatTable, type Flags } from "./cli";
import type { SessionCommand } from "./commands";
import { RUNNER_SCRIPT, TALOS_FOLDER } from "./constants";
import { readCredentials } from "./credentials";
import { readFolders } from "./folders";
import { openPage, pageAddress } from "./machine-commands";
import { DETACH_KEY, connectToSessions, type Result, type SessionSummary } from "./talos-sessions";

const sessions = connectToSessions({ home: TALOS_FOLDER, runnerScript: RUNNER_SCRIPT });

const succeedOrFail = (result: Result, fix?: string): void => {
  if (!result.ok) throw cliError(result.reason, fix);
};

const runningSessions = async (): Promise<SessionSummary[]> => ((await sessions.isRunning()) ? sessions.sessions() : []);

// This machine's name on the server, which a session's identifier and page
// address carry.
const machineNameOrFail = async (): Promise<string> => {
  const machineName = (await readCredentials(requireEnv(ENV_KEYS.serverUrl)))?.machineName;
  if (!machineName) throw cliError("this machine isn't paired yet", "talos service install");
  return machineName;
};

const listSessions = async (flags: Flags): Promise<void> => {
  const list = await runningSessions();
  if (flags.json) return console.log(JSON.stringify(list, null, 2));
  if (list.length === 0) return console.error("talos: no sessions (talos sessions start <folder>)");
  const rows = list.map(({ sessionName, folderName, state }) => [sessionName, folderName, state === "idle" ? "ready" : state]);
  console.log(formatTable(["session", "folder", "state"], rows, process.stdout.isTTY === true));
};

// Which folder a new session starts in, and its name: the folder's unless
// --name says otherwise, made a name like an identifier, and unique among the
// sessions running.
export const planSessionStart = (
  folderName: string,
  wantedName: string | undefined,
  folders: readonly Folder[],
  takenNames: readonly string[],
): { folder: Folder; sessionName: string } => {
  const folder = folders.find((known) => known.folderName === folderName);
  if (!folder) throw cliError(`this machine has no folder called ${folderName}`, "talos folders");
  return { folder, sessionName: pickUniqueName(toIdentifierName(wantedName ?? folderName), [...takenNames]) };
};

const startSession = async (folderName: string, flags: Flags): Promise<void> => {
  const folders = await readFolders();
  const machineName = await machineNameOrFail();
  await sessions.ensureRunning();
  const takenNames = (await sessions.sessions()).map(({ sessionName }) => sessionName);
  const { folder, sessionName } = planSessionStart(folderName, flags.name, folders, takenNames);
  succeedOrFail(await sessions.start(sessionName, folderName, folder.path));
  console.log(`started ${buildIdentifier(["machines", machineName, "sessions", sessionName])}`);
  console.log(pageAddress(["sessions", machineName, sessionName]));
};

// The text typed after `send`, or, with none, what's piped in.
const readMessage = async (text: string | null): Promise<string> => {
  if (text !== null) return text;
  if (process.stdin.isTTY) throw cliError("there's no message to send", 'talos sessions <session> send "<text>"', 2);
  return (await Bun.stdin.text()).trim();
};

const sendMessage = async (sessionName: string, text: string | null): Promise<void> => {
  const message = await readMessage(text);
  if (!message) throw cliError("the message is empty");
  if (!(await sessions.isRunning())) throw cliError(`there's no session ${sessionName}`, "talos sessions");
  succeedOrFail(await sessions.send(sessionName, message), "talos sessions");
  console.log(`sent to ${sessionName}`);
};

// Your terminal shows the session's own terminal and types into it, until
// Ctrl-\ leaves it running or the session ends.
const attach = async (sessionName: string): Promise<void> => {
  if (!(await sessions.isRunning())) throw cliError(`there's no session ${sessionName}`, "talos sessions");
  const attached = await sessions.attach(sessionName, { input: process.stdin, output: process.stdout, detachKey: DETACH_KEY });
  if (!attached.ok) throw cliError(attached.reason, "talos sessions");
  process.stdout.write(`\r\n[talos] ${attached.how === "detached" ? `left ${sessionName} running` : `${sessionName} ended`}\r\n`);
  process.exit(0);
};

const openSession = async (sessionName: string): Promise<void> => {
  const isRunning = (await runningSessions()).some((session) => session.sessionName === sessionName);
  if (!isRunning) throw cliError(`there's no session ${sessionName}`, "talos sessions");
  openPage(pageAddress(["sessions", await machineNameOrFail(), sessionName]));
};

export const runSessionCommand = async (command: SessionCommand, flags: Flags): Promise<void> => {
  if (command.name === "sessions-list") return listSessions(flags);
  if (command.name === "sessions-start") return startSession(command.folderName, flags);
  if (command.name === "sessions-send") return sendMessage(command.sessionName, command.text);
  if (command.name === "sessions-attach") return attach(command.sessionName);
  if (command.name === "sessions-open") return openSession(command.sessionName);
  if (!(await sessions.isRunning())) {
    if (command.name === "runner-stop") return console.error("talos: the session runner isn't running");
    throw cliError(`there's no session ${command.sessionName}`, "talos sessions");
  }
  if (command.name === "sessions-stop") {
    succeedOrFail(await sessions.stop(command.sessionName), "talos sessions");
    return console.log(`stopped ${command.sessionName}`);
  }
  await sessions.stopRunner();
  console.log("stopped the session runner and its sessions");
};
