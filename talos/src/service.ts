// Running talos as a service: a macOS launch agent starts it at login and
// starts it again if it stops (`talos install`, `talos uninstall`), and
// `talos update` brings an installed copy up to main (see install.sh).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { createLogger, ENV_KEYS, httpOriginFromServerUrl, readLogsMode, requireEnv, toIdentifierName } from "talos-shared";
import { INSTALLED_APP_FOLDER, INSTALLED_ENV_FILE, SERVICE_LOG_FILE, TALOS_FOLDER } from "./constants";
import { acceptMachine } from "./pairing";

export const LAUNCH_AGENT_LABEL = "local.talos";
const LAUNCH_AGENT_FILE = join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
export const INSTALL_SCRIPT_URL = "https://raw.githubusercontent.com/joeboylson/talos/main/install.sh";
// Seconds launchd waits before starting talos again after it stops.
const RESTART_WAIT_SECONDS = 10;

const INDEX_SCRIPT = new URL("./index.ts", import.meta.url).pathname;
// A copy install.sh put in place, rather than a git checkout.
const isInstalledCopy = (): boolean => INDEX_SCRIPT.startsWith(`${INSTALLED_APP_FOLDER}/`);
// The settings talos runs with: an installed copy's, or a checkout's .env.
const envFileOf = (): string => (isInstalledCopy() ? INSTALLED_ENV_FILE : join(dirname(INDEX_SCRIPT), "..", "..", ".env"));

export type LaunchAgent = { label: string; programArguments: string[]; environment: Record<string, string>; logFile: string };

const escapeXml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const xmlString = (text: string): string => `<string>${escapeXml(text)}</string>`;

// KeepAlive starts it again whenever it stops, a crash or a restart after
// `talos update` alike.
export const buildLaunchAgentPlist = ({ label, programArguments, environment, logFile }: LaunchAgent): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${xmlString(label)}`,
    `  <key>ProgramArguments</key><array>${programArguments.map(xmlString).join("")}</array>`,
    `  <key>EnvironmentVariables</key><dict>${Object.entries(environment)
      .map(([name, value]) => `<key>${escapeXml(name)}</key>${xmlString(value)}`)
      .join("")}</dict>`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    `  <key>ThrottleInterval</key><integer>${RESTART_WAIT_SECONDS}</integer>`,
    `  <key>StandardOutPath</key>${xmlString(logFile)}`,
    `  <key>StandardErrorPath</key>${xmlString(logFile)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

const launchctl = (args: string[]): boolean => Bun.spawnSync(["launchctl", ...args], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const serviceTarget = (): string => `gui/${process.getuid?.()}`;

const requireMac = (): void => {
  if (process.platform !== "darwin") throw new Error("talos: running as a service works on macOS only for now");
};

// Pairs first, here, if it isn't yet: the code to enter on the page would be
// lost in the service's log. Sessions get the PATH talos is installed from, so
// their tools (git, brew's) are where they are in a terminal; launchd's own
// PATH has almost nothing.
export const installService = async (): Promise<void> => {
  requireMac();
  const serverUrl = requireEnv(ENV_KEYS.serverUrl);
  const log = createLogger(readLogsMode(process.env[ENV_KEYS.logsMode]));
  const wantedMachineName = toIdentifierName(process.env[ENV_KEYS.machineName] || hostname());
  const { machineName } = await acceptMachine(serverUrl, httpOriginFromServerUrl(serverUrl), wantedMachineName, log);
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...(process.env.TALOS_HOME && { TALOS_HOME: process.env.TALOS_HOME }),
  };
  const plist = buildLaunchAgentPlist({
    label: LAUNCH_AGENT_LABEL,
    programArguments: [process.execPath, `--env-file=${envFileOf()}`, INDEX_SCRIPT],
    environment,
    logFile: SERVICE_LOG_FILE,
  });
  mkdirSync(dirname(LAUNCH_AGENT_FILE), { recursive: true });
  writeFileSync(LAUNCH_AGENT_FILE, plist);
  // Loaded already (a second install): it's unloaded first, so the new file counts.
  launchctl(["bootout", `${serviceTarget()}/${LAUNCH_AGENT_LABEL}`]);
  if (!launchctl(["bootstrap", serviceTarget(), LAUNCH_AGENT_FILE])) throw new Error(`talos: launchd wouldn't load ${LAUNCH_AGENT_FILE}`);
  console.log(`talos: ${machineName} runs talos at login now, and again if it stops. Its log: ${SERVICE_LOG_FILE}`);
};

// The session runner and its sessions go on until `talos runner stop`.
export const uninstallService = (): void => {
  requireMac();
  launchctl(["bootout", `${serviceTarget()}/${LAUNCH_AGENT_LABEL}`]);
  rmSync(LAUNCH_AGENT_FILE, { force: true });
  console.log("talos: no longer runs at login");
};

// install.sh does the work, so an update and a fresh install are one path.
export const updateTalos = (): void => {
  if (!isInstalledCopy()) throw new Error("talos: this copy runs from a git checkout; update it with git pull");
  const ran = Bun.spawnSync(["sh", "-c", `curl -fsSL ${INSTALL_SCRIPT_URL} | sh`], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, TALOS_HOME: TALOS_FOLDER },
  });
  if (ran.exitCode !== 0) throw new Error("talos: the update didn't finish; the running copy is unchanged");
};
