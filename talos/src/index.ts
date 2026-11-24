import { HELP_TEXT, isFolderCommand, isSessionCommand, parseCommand } from "./commands";
import { runConnect } from "./connect";
import { runFolderCommand } from "./folder-commands";
import { runSessionCommand } from "./session-commands";
import { installService, showStatus, startService, stopService, uninstallService, updateTalos } from "./service";

const command = parseCommand(process.argv.slice(2));

if (command.name === "connect") await runConnect();
if (command.name === "help") console.log(HELP_TEXT);
if (isFolderCommand(command)) await runFolderCommand(command);
if (isSessionCommand(command)) await runSessionCommand(command);
if (command.name === "service-install") await installService();
if (command.name === "service-uninstall") uninstallService();
if (command.name === "service-start") startService();
if (command.name === "service-stop") stopService();
if (command.name === "status") await showStatus();
if (command.name === "update") updateTalos();
if (command.name === "unknown") {
  console.error(`talos: no command "${command.typed}"\n\n${HELP_TEXT}`);
  process.exit(1);
}
