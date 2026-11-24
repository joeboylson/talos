// Things the terminal does better than the page: following talos's log, and
// opening the page where this machine is.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ENV_KEYS, buildPagePath, httpOriginFromServerUrl, requireEnv } from "talos-shared";
import { cliError, type Flags } from "./cli";
import { SERVICE_LOG_FILE, TALOS_FOLDER } from "./constants";

// The lines of the log shown before following it.
const LOG_LINES_SHOWN = 50;
const RUNNER_LOG_FILE = join(TALOS_FOLDER, "runner.log");

// Follows the log until Ctrl-C, the last few lines first.
export const showLogs = async (flags: Flags): Promise<void> => {
  const logFile = flags.runner ? RUNNER_LOG_FILE : SERVICE_LOG_FILE;
  if (!existsSync(logFile)) {
    throw flags.runner
      ? cliError(`there's no session runner log yet (${logFile})`, "talos sessions start <folder>")
      : cliError(`there's no log yet (${logFile}); talos only logs there in the background`, "talos service install");
  }
  const following = Bun.spawn(["tail", "-n", String(LOG_LINES_SHOWN), "-f", logFile], { stdout: "inherit", stderr: "inherit" });
  await following.exited;
};

// The page address of something on the server, for opening or printing.
export const pageAddress = (pathParts: string[]): string => `${httpOriginFromServerUrl(requireEnv(ENV_KEYS.serverUrl))}${buildPagePath(pathParts)}`;

// Prints the address (it's what a script or an agent can use), then opens it
// in a browser where there is one.
export const openPage = (address: string): void => {
  console.log(address);
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  if (Bun.which(opener)) Bun.spawnSync([opener, address], { stdout: "ignore", stderr: "ignore" });
};

export const openMachinePage = (): void => openPage(pageAddress(["machines"]));
