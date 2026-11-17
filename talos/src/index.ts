import { HELP_TEXT, parseCommand } from "./commands";
import { runConnect } from "./connect";
import { runFolderCommand } from "./folder-commands";

const command = parseCommand(process.argv.slice(2));

if (command.name === "connect") await runConnect();
if (command.name === "help") console.log(HELP_TEXT);
if (
  command.name === "folders-list" ||
  command.name === "folders-add" ||
  command.name === "folders-remove" ||
  command.name === "folders-rename"
) {
  await runFolderCommand(command);
}
if (command.name === "unknown") {
  console.error(`talos: no command "${command.typed}"\n\n${HELP_TEXT}`);
  process.exit(1);
}
