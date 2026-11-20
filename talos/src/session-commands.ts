import type { SessionCommand } from "./commands";
import { RUNNER_SCRIPT, TALOS_FOLDER } from "./constants";
import { DETACH_KEY, connectToSessions } from "./talos-sessions";

const sessions = connectToSessions({ home: TALOS_FOLDER, runnerScript: RUNNER_SCRIPT });

const fail = (problem: string): never => {
  console.error(`talos: ${problem}`);
  process.exit(1);
};

const listSessions = async () => {
  if (!(await sessions.isRunning())) return console.log("no sessions");
  const list = await sessions.sessions();
  if (list.length === 0) return console.log("no sessions");
  list.forEach(({ sessionName, folderName, state }) => console.log(`${sessionName}\t${folderName}\t${state}`));
};

// Your terminal shows the session's own terminal and types into it, until
// Ctrl-\ leaves it running or the session ends.
const attach = async (sessionName: string) => {
  if (!(await sessions.isRunning())) return fail("no sessions are running");
  const attached = await sessions.attach(sessionName, { input: process.stdin, output: process.stdout, detachKey: DETACH_KEY });
  if (!attached.ok) return fail(attached.reason);
  process.stdout.write(`\r\n[talos] ${attached.how === "detached" ? `left ${sessionName} running` : `${sessionName} ended`}\r\n`);
  process.exit(0);
};

export const runSessionCommand = async (command: SessionCommand): Promise<void> => {
  if (command.name === "sessions-list") return listSessions();
  if (command.name === "sessions-attach") return attach(command.sessionName);
  if (!(await sessions.isRunning())) return console.log(command.name === "runner-stop" ? "the session runner isn't running" : "no sessions");
  if (command.name === "sessions-stop") {
    const result = await sessions.stop(command.sessionName);
    return result.ok ? console.log(`stopped ${command.sessionName}`) : fail(result.reason);
  }
  await sessions.stopRunner();
  console.log("stopped the session runner and its sessions");
};
