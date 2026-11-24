// Commands follow the same shape as identifiers and page addresses (see
// docs/GLOSSARY.md): talos folders ↔ /folders ↔ talos:folders.
// Each new command is added here, to `talos help`, and to the README.

export type Command =
  | { name: "connect" }
  | { name: "help"; topic?: string }
  | { name: "folders-list" }
  | { name: "folders-add"; path: string }
  | { name: "folders-remove"; folderName: string }
  | { name: "folders-rename"; folderName: string; newName: string }
  | { name: "sessions-list" }
  | { name: "sessions-start"; folder: string }
  | { name: "sessions-send"; sessionName: string; text: string | null }
  // No session name: choose one of those running.
  | { name: "sessions-attach"; sessionName: string | null }
  | { name: "sessions-open"; sessionName: string }
  | { name: "sessions-stop"; sessionName: string }
  | { name: "runner-stop" }
  | { name: "service-install" }
  | { name: "service-uninstall" }
  | { name: "service-start" }
  | { name: "service-stop" }
  | { name: "status" }
  | { name: "update" }
  | { name: "logs" }
  | { name: "open" }
  | { name: "unknown"; typed: string };

export type FolderCommand = Extract<Command, { name: `folders-${string}` }>;
export type SessionCommand = Extract<Command, { name: `sessions-${string}` | "runner-stop" }>;

export const isFolderCommand = (command: Command): command is FolderCommand => command.name.startsWith("folders-");
export const isSessionCommand = (command: Command): command is SessionCommand =>
  command.name.startsWith("sessions-") || command.name === "runner-stop";

// The help, grouped by task. `talos help <thing>` (or `talos <thing> --help`)
// shows the group its first word belongs to.
type HelpGroup = { title: string; topics: readonly string[]; commands: readonly (readonly [string, string])[]; examples: readonly string[] };
const HELP_GROUPS: readonly HelpGroup[] = [
  {
    title: "Run talos on this machine",
    topics: ["connect", "service", "status", "update", "logs", "open"],
    commands: [
      ["talos connect [--owner <login>]", "pair this machine if needed, then connect here until stopped"],
      ["talos service install [--owner <login>]", "pair if needed, then run talos in the background, at every login"],
      ["talos service start", "start the background talos"],
      ["talos service stop", "stop it (it starts again at the next login)"],
      ["talos service uninstall", "stop running talos in the background"],
      ["talos status [--json]", "show whether this machine is paired, running and connected"],
      ["talos update", "update to the latest talos, then run talos service install"],
      ["talos logs [--runner]", "follow talos's log (or the session runner's)"],
      ["talos open", "open this machine on the page"],
    ],
    examples: ["talos service install", "talos status --json"],
  },
  {
    title: "Folders sessions may run in",
    topics: ["folders"],
    commands: [
      ["talos folders [--json]", "list the folders this machine allows sessions in"],
      ["talos folders add <path>", "allow sessions in a folder on this machine"],
      ["talos folders remove <folder>", "stop allowing a folder"],
      ["talos folders rename <folder> <new-name>", "give a folder a new name (its path stays)"],
    ],
    examples: ["talos folders add ~/code/website"],
  },
  {
    title: "Sessions",
    topics: ["sessions", "runner"],
    commands: [
      ["talos sessions [--json]", "list this machine's Claude sessions"],
      ["talos sessions start [<folder>] [--name <name>] [--add]", "start a session in a folder, by name or path (here if none); one not added yet is added first"],
      ['talos sessions <session> send "<text>"', "send it a message (or pipe the text in)"],
      ["talos sessions [<session>] attach", "follow its conversation and type to it (Ctrl-D leaves it running); with no session, choose one"],
      ["talos sessions <session> open", "open it on the page"],
      ["talos sessions <session> stop", "end a session"],
      ["talos runner stop", "end the session runner and every session in it"],
    ],
    examples: ["talos sessions start website --name new-homepage", 'talos sessions new-homepage send "use the logo blue"'],
  },
];
const EVERYWHERE = [
  "  talos help [<thing>]   this list, or one part of it (like talos help sessions)",
  "  --help, -h             help for any command; --version, -V which talos this is",
  "  --json                 lists and status as JSON, for scripts",
].join("\n");

const formatGroup = ({ title, commands, examples }: HelpGroup): string => {
  const width = Math.max(...commands.map(([usage]) => usage.length));
  const lines = commands.map(([usage, text]) => `  ${usage.padEnd(width)}  ${text}`);
  return [`${title}:`, ...lines, "", "  for example:", ...examples.map((example) => `    ${example}`)].join("\n");
};

export const HELP_TEXT = ["talos: connects this machine to the Talos server", "", ...HELP_GROUPS.map(formatGroup).flatMap((group) => [group, ""]), EVERYWHERE, ""].join("\n");

// One group's help, or all of it for a topic that isn't one.
export const helpFor = (topic?: string): string => {
  const group = topic ? HELP_GROUPS.find(({ topics }) => topics.includes(topic)) : undefined;
  return group ? `${formatGroup(group)}\n\n${EVERYWHERE}\n` : HELP_TEXT;
};

// Every command's words up to its first name or path, for "did you mean".
export const KNOWN_COMMANDS: readonly string[] = HELP_GROUPS.flatMap(({ commands }) =>
  commands.map(([usage]) => usage.replace(/^talos /, "").split(" ").filter((word) => /^[a-z]+$/.test(word)).join(" ")),
).filter((command, index, all) => command && all.indexOf(command) === index);

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

// `sessions start [<folder>]` starts one, here if no folder is named;
// otherwise the first word names a
// session and the second says what to do with it. A message to send is the
// rest of the words, or, with none, what's piped in.
const SESSION_ACTIONS = ["attach", "open", "stop"] as const;
const parseSessionsCommand = (args: string[], typed: string): Command => {
  const [first, action, ...rest] = args;
  if (first === undefined) return { name: "sessions-list" };
  if (first === "start" && action === undefined) return { name: "sessions-start", folder: "." };
  if (first === "attach" && action === undefined) return { name: "sessions-attach", sessionName: null };
  if (first === "start" && action && rest.length === 0 && !SESSION_ACTIONS.some((known) => known === action) && action !== "send") {
    return { name: "sessions-start", folder: action };
  }
  if (action === "send") return { name: "sessions-send", sessionName: first, text: rest.length > 0 ? rest.join(" ") : null };
  if (rest.length > 0) return { name: "unknown", typed };
  if (action === "attach") return { name: "sessions-attach", sessionName: first };
  if (action === "open") return { name: "sessions-open", sessionName: first };
  if (action === "stop") return { name: "sessions-stop", sessionName: first };
  return { name: "unknown", typed };
};

const WHOLE_COMMANDS: Record<string, Command> = {
  connect: { name: "connect" },
  status: { name: "status" },
  update: { name: "update" },
  logs: { name: "logs" },
  open: { name: "open" },
  "runner stop": { name: "runner-stop" },
  "service install": { name: "service-install" },
  "service uninstall": { name: "service-uninstall" },
  "service start": { name: "service-start" },
  "service stop": { name: "service-stop" },
};

export const parseCommand = (args: string[]): Command => {
  const typed = args.join(" ");
  const [firstWord, ...otherWords] = args;
  if (firstWord === undefined) return { name: "help" };
  if (firstWord === "help" && otherWords.length <= 1) return { name: "help", ...(otherWords[0] && { topic: otherWords[0] }) };
  if (firstWord === "folders") return parseFoldersCommand(otherWords, typed);
  if (firstWord === "sessions") return parseSessionsCommand(otherWords, typed);
  return WHOLE_COMMANDS[typed] ?? { name: "unknown", typed };
};
