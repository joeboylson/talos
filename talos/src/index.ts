// The talos command: reads what was typed, runs it, and says what went wrong
// in one line if it didn't (see docs/CLI_RULES.md).
import { ENV_KEYS } from "talos-shared";
import { closestCommand, describeError, parseArgs, usageError, type Flags } from "./cli";
import { KNOWN_COMMANDS, helpFor, isFolderCommand, isSessionCommand, parseCommand, type Command } from "./commands";
import { runConnect } from "./connect";
import { runFolderCommand } from "./folder-commands";
import { openMachinePage, showLogs } from "./machine-commands";
import { runSessionCommand } from "./session-commands";
import { installService, showStatus, startService, stopService, talosVersion, uninstallService, updateTalos } from "./service";

const suggestionFor = (typed: string): string => {
  const guess = closestCommand(typed, KNOWN_COMMANDS) ?? closestCommand(typed.split(" ")[0] ?? "", KNOWN_COMMANDS);
  return guess ? `talos ${guess}` : "talos help";
};

const runCommand = async (command: Command, flags: Flags): Promise<void> => {
  if (command.name === "unknown") throw usageError(`there's no command "talos ${command.typed}"`, suggestionFor(command.typed));
  if (command.name === "help") return void process.stdout.write(helpFor(command.topic));
  if (command.name === "connect") return runConnect();
  if (isFolderCommand(command)) return runFolderCommand(command, flags);
  if (isSessionCommand(command)) return runSessionCommand(command, flags);
  if (command.name === "service-install") return installService();
  if (command.name === "service-uninstall") return uninstallService();
  if (command.name === "service-start") return startService();
  if (command.name === "service-stop") return stopService();
  if (command.name === "status") return showStatus(flags);
  if (command.name === "update") return updateTalos();
  if (command.name === "logs") return showLogs(flags);
  if (command.name === "open") return openMachinePage();
};

const main = async (): Promise<void> => {
  const { words, flags } = parseArgs(process.argv.slice(2));
  if (flags.version) return void console.log(`talos ${talosVersion()}`);
  if (flags.help) return void process.stdout.write(helpFor(words[0]));
  // Pairing's one question (is this you?) answered ahead, for a script.
  if (flags.owner) process.env[ENV_KEYS.pairOwner] = flags.owner;
  await runCommand(parseCommand(words), flags);
};

await main().catch((error: unknown) => {
  const { text, exitCode } = describeError(error, process.env.TALOS_DEBUG === "1");
  console.error(text);
  process.exit(exitCode);
});
