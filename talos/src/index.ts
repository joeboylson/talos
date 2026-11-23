import { HELP_TEXT, isFolderCommand, isSessionCommand, parseCommand } from "./commands";
import { runConnect } from "./connect";
import { runFolderCommand } from "./folder-commands";
import { runSessionCommand } from "./session-commands";
import { installService, uninstallService, updateTalos } from "./service";

const command = parseCommand(process.argv.slice(2));

if (command.name === "connect") await runConnect();
if (command.name === "help") console.log(HELP_TEXT);
if (isFolderCommand(command)) await runFolderCommand(command);
if (isSessionCommand(command)) await runSessionCommand(command);
if (command.name === "install") await installService();
if (command.name === "uninstall") uninstallService();
if (command.name === "update") updateTalos();
if (command.name === "unknown") {
  console.error(`talos: no command "${command.typed}"\n\n${HELP_TEXT}`);
  process.exit(1);
}
