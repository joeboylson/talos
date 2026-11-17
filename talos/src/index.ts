import { HELP_TEXT, parseCommand } from "./commands";
import { runConnect } from "./connect";

const command = parseCommand(process.argv.slice(2));

if (command.name === "connect") runConnect();
if (command.name === "help") console.log(HELP_TEXT);
if (command.name === "unknown") {
  console.error(`talos: no command "${command.typed}"\n\n${HELP_TEXT}`);
  process.exit(1);
}
