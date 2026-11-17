// Commands follow the same shape as identifiers and page addresses (see
// docs/GLOSSARY.md): talos machines work-mac ping ↔ talos:machines:work-mac.
// Each new command is added here, to `talos help`, and to the README.

export type Command = { name: "connect" } | { name: "help" } | { name: "unknown"; typed: string };

export const HELP_TEXT = `talos: connects this machine to the Talos server

  talos         pair this machine if needed, then connect and stay connected
  talos help    show this list
`;

export const parseCommand = (args: string[]): Command => {
  const [firstWord, ...otherWords] = args;
  if (firstWord === undefined) return { name: "connect" };
  if (firstWord === "help" && otherWords.length === 0) return { name: "help" };
  return { name: "unknown", typed: args.join(" ") };
};
