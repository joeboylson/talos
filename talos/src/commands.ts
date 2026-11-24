// Commands follow the same shape as identifiers and page addresses (see
// docs/GLOSSARY.md): talos folders ↔ /folders ↔ talos:folders.
// Each new command is added here, to `talos help`, and to the README.

export type Command =
  | { name: "connect" }
  | { name: "help" }
  | { name: "folders-list" }
  | { name: "folders-add"; path: string }
  | { name: "folders-remove"; folderName: string }
  | { name: "folders-rename"; folderName: string; newName: string }
  | { name: "sessions-list" }
  | { name: "sessions-attach"; sessionName: string }
  | { name: "sessions-stop"; sessionName: string }
  | { name: "runner-stop" }
  | { name: "service-install" }
  | { name: "service-uninstall" }
  | { name: "service-start" }
  | { name: "service-stop" }
  | { name: "status" }
  | { name: "update" }
  | { name: "unknown"; typed: string };

export type FolderCommand = Extract<Command, { name: `folders-${string}` }>;
export type SessionCommand = Extract<Command, { name: `sessions-${string}` | "runner-stop" }>;

export const isFolderCommand = (command: Command): command is FolderCommand => command.name.startsWith("folders-");
export const isSessionCommand = (command: Command): command is SessionCommand =>
  command.name.startsWith("sessions-") || command.name === "runner-stop";

export const HELP_TEXT = `talos: connects this machine to the Talos server

  talos connect                             pair this machine if needed, then connect here until stopped
  talos service install                     pair if needed, then run talos in the background, at every login
  talos service start                       start the background talos
  talos service stop                        stop it (it starts again at the next login)
  talos service uninstall                   stop running talos in the background
  talos status                              show whether this machine is paired, running and connected
  talos update                              update to the latest talos, then run talos service install
  talos folders                             list the folders this machine allows sessions in
  talos folders add <path>                  allow sessions in a folder on this machine
  talos folders remove <folder>             stop allowing a folder
  talos folders rename <folder> <new-name>  give a folder a new name (its path stays)
  talos sessions                            list this machine's Claude sessions
  talos sessions <session> attach           watch and type in a session (Ctrl-\\ leaves it running)
  talos sessions <session> stop             end a session
  talos runner stop                         end the session runner and every session in it
  talos help                                show this list
`;

const parseFoldersCommand = (args: string[], typed: string): Command => {
  const [action, target, newName, ...extraWords] = args;
  if (extraWords.length > 0) return { name: "unknown", typed };
  if (action === undefined) return { name: "folders-list" };
  if (action === "rename" && target && newName) return { name: "folders-rename", folderName: target, newName };
  if (newName !== undefined) return { name: "unknown", typed };
  if (action === "add" && target) return { name: "folders-add", path: target };
  if (action === "remove" && target) return { name: "folders-remove", folderName: target };
  return { name: "unknown", typed };
};

const parseSessionsCommand = (args: string[], typed: string): Command => {
  const [sessionName, action, ...extraWords] = args;
  if (sessionName === undefined) return { name: "sessions-list" };
  if (extraWords.length > 0) return { name: "unknown", typed };
  if (action === "attach") return { name: "sessions-attach", sessionName };
  if (action === "stop") return { name: "sessions-stop", sessionName };
  return { name: "unknown", typed };
};

export const parseCommand = (args: string[]): Command => {
  const typed = args.join(" ");
  const [firstWord, ...otherWords] = args;
  if (firstWord === undefined) return { name: "help" };
  if (firstWord === "help" && otherWords.length === 0) return { name: "help" };
  if (typed === "connect") return { name: "connect" };
  if (typed === "status") return { name: "status" };
  if (typed === "update") return { name: "update" };
  if (firstWord === "folders") return parseFoldersCommand(otherWords, typed);
  if (firstWord === "sessions") return parseSessionsCommand(otherWords, typed);
  if (typed === "runner stop") return { name: "runner-stop" };
  if (typed === "service install") return { name: "service-install" };
  if (typed === "service uninstall") return { name: "service-uninstall" };
  if (typed === "service start") return { name: "service-start" };
  if (typed === "service stop") return { name: "service-stop" };
  return { name: "unknown", typed };
};
