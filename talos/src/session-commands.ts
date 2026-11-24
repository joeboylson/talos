import { homedir } from "node:os";
import { ENV_KEYS, buildIdentifier, pickUniqueName, requireEnv, toIdentifierName, type Folder } from "talos-shared";
import { cliError, formatTable, type Flags } from "./cli";
import type { SessionCommand } from "./commands";
import { RUNNER_SCRIPT, TALOS_FOLDER } from "./constants";
import { readCredentials } from "./credentials";
import { readFolders } from "./folders";
import { attachToSession } from "./attach";
import { askChoice, askYesNo } from "./ask";
import { addFolderAt, realFolderPath, resolveFolderPath } from "./folder-commands";
import { openPage, pageAddress } from "./machine-commands";
import { connectToSessions, type Result, type SessionSummary } from "./talos-sessions";

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

// The folder a start names: one of this machine's, by its name or its path
// (realPath: what was typed, as a real folder on disk, if it is one). A folder
// on disk that isn't one of them yet comes back to be added.
export const chooseStartFolder = (typed: string, folders: readonly Folder[], realPath: string | null): { folder: Folder } | { pathToAdd: string } => {
  const folder = folders.find((known) => known.folderName === typed) ?? folders.find((known) => known.path === realPath);
  if (folder) return { folder };
  if (realPath) return { pathToAdd: realPath };
  throw cliError(`this machine has no folder called ${typed}`, "talos folders");
};

// A new session's name: the folder's unless --name says otherwise, made a name
// like an identifier, and unique among the sessions running.
export const sessionNameFor = (folder: Folder, wantedName: string | undefined, takenNames: readonly string[]): string =>
  pickUniqueName(toIdentifierName(wantedName ?? folder.folderName), [...takenNames]);

// A folder isn't added without a yes: from --add, or asked in a terminal.
const addForStart = async (path: string, typed: string, flags: Flags): Promise<Folder> => {
  if (!flags.add) {
    if (!process.stdin.isTTY) throw cliError(`${path} isn't one of this machine's folders`, `talos sessions start ${typed} --add`);
    const shown = path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path;
    if (!(await askYesNo(`${shown} isn't one of this machine's folders. Add it and start there?`, true))) throw cliError("nothing started");
  }
  return addFolderAt(path);
};

const startSession = async (typed: string, flags: Flags): Promise<void> => {
  const folders = await readFolders();
  const machineName = await machineNameOrFail();
  const realPath = await realFolderPath(resolveFolderPath(typed, process.cwd(), homedir()));
  const chosen = chooseStartFolder(typed, folders, realPath);
  const folder = "folder" in chosen ? chosen.folder : await addForStart(chosen.pathToAdd, typed, flags);
  await sessions.ensureRunning();
  const takenNames = (await sessions.sessions()).map(({ sessionName }) => sessionName);
  const sessionName = sessionNameFor(folder, flags.name, takenNames);
  succeedOrFail(await sessions.start(sessionName, folder.folderName, folder.path));
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

// Which session to attach to, when none was named: the only one running, or
// one chosen from a numbered list in the terminal.
const chooseSession = async (): Promise<string> => {
  const running = await runningSessions();
  if (running.length === 0) throw cliError("no sessions are running", "talos sessions start <folder>");
  if (running.length === 1) return running[0]!.sessionName;
  if (!process.stdin.isTTY) throw cliError("there's more than one session; name one", "talos sessions <session> attach", 2);
  const choices = running.map(({ sessionName, folderName, state }) => ({ value: sessionName, label: sessionName, hint: `${folderName}, ${state === "idle" ? "ready" : state}` }));
  const chosen = await askChoice("Attach to which session?", choices);
  if (!chosen) throw cliError("nothing attached");
  return chosen;
};

// The session's conversation in your terminal, and a line to type into,
// until Ctrl-D (or Ctrl-C with no turn running) leaves it running.
const attach = async (named: string | null): Promise<void> => {
  const sessionName = named ?? (await chooseSession());
  const isRunning = (await runningSessions()).some((session) => session.sessionName === sessionName);
  if (!isRunning) throw cliError(`there's no session ${sessionName}`, "talos sessions");
  await attachToSession(sessions, sessionName);
};

const openSession = async (sessionName: string): Promise<void> => {
  const isRunning = (await runningSessions()).some((session) => session.sessionName === sessionName);
  if (!isRunning) throw cliError(`there's no session ${sessionName}`, "talos sessions");
  openPage(pageAddress(["sessions", await machineNameOrFail(), sessionName]));
};

export const runSessionCommand = async (command: SessionCommand, flags: Flags): Promise<void> => {
  if (command.name === "sessions-list") return listSessions(flags);
  if (command.name === "sessions-start") return startSession(command.folder, flags);
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
