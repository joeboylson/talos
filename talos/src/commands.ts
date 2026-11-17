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
  | { name: "unknown"; typed: string };

export const HELP_TEXT = `talos: connects this machine to the Talos server

  talos                           pair this machine if needed, then connect and stay connected
  talos folders                   list the folders this machine allows sessions in
  talos folders add <path>        allow sessions in a folder on this machine
  talos folders remove <folder>   stop allowing a folder
  talos folders rename <folder> <new-name>
                                  give a folder a new name (its path stays)
  talos help                      show this list
`;

export const parseCommand = (args: string[]): Command => {
  const typed = args.join(" ");
  const [firstWord, action, target, newName, ...extraWords] = args;
  if (firstWord === undefined) return { name: "connect" };
  if (firstWord === "help" && args.length === 1) return { name: "help" };
  if (firstWord !== "folders" || extraWords.length > 0) return { name: "unknown", typed };
  if (action === undefined) return { name: "folders-list" };
  if (action === "rename" && target && newName) return { name: "folders-rename", folderName: target, newName };
  if (newName !== undefined) return { name: "unknown", typed };
  if (action === "add" && target) return { name: "folders-add", path: target };
  if (action === "remove" && target) return { name: "folders-remove", folderName: target };
  return { name: "unknown", typed };
};
