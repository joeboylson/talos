// Running talos as a service that starts at login and again if it stops: a
// launch agent on macOS, a systemd user service on Linux (`talos install`,
// `talos uninstall`). `talos update` brings an installed copy up to main (see
// install.sh).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { createLogger, ENV_KEYS, httpOriginFromServerUrl, readLogsMode, requireEnv, toIdentifierName } from "talos-shared";
import { INSTALLED_APP_FOLDER, INSTALLED_ENV_FILE, SERVICE_LOG_FILE, TALOS_FOLDER } from "./constants";
import { acceptMachine } from "./pairing";

// install.sh and uninstall.sh use these same names.
export const LAUNCH_AGENT_LABEL = "local.talos";
export const SYSTEMD_UNIT_NAME = "talos.service";
const LAUNCH_AGENT_FILE = join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
const SYSTEMD_UNIT_FILE = join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
export const INSTALL_SCRIPT_URL = "https://raw.githubusercontent.com/joeboylson/talos/main/install.sh";
// Seconds the system waits before starting talos again after it stops.
const RESTART_WAIT_SECONDS = 10;

const INDEX_SCRIPT = new URL("./index.ts", import.meta.url).pathname;
// A copy install.sh put in place, rather than a git checkout.
const isInstalledCopy = (): boolean => INDEX_SCRIPT.startsWith(`${INSTALLED_APP_FOLDER}/`);
// The settings talos runs with: an installed copy's, or a checkout's .env.
const envFileOf = (): string => (isInstalledCopy() ? INSTALLED_ENV_FILE : join(dirname(INDEX_SCRIPT), "..", "..", ".env"));

// What the service runs, with what environment, and where its output goes.
export type ServiceSpec = { programArguments: string[]; environment: Record<string, string>; logFile: string };

const escapeXml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const xmlString = (text: string): string => `<string>${escapeXml(text)}</string>`;

// KeepAlive starts it again whenever it stops, a crash or a restart after
// `talos update` alike.
export const buildLaunchAgentPlist = ({ programArguments, environment, logFile }: ServiceSpec): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${xmlString(LAUNCH_AGENT_LABEL)}`,
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

// systemd reads a quoted word whole, spaces and all; a backslash or quote
// inside is escaped, and % (its own specifier sign) doubled.
const systemdQuoted = (text: string): string => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

// Restart=always starts it again whenever it stops, as KeepAlive does.
export const buildSystemdUnit = ({ programArguments, environment, logFile }: ServiceSpec): string =>
  [
    "[Unit]",
    "Description=talos",
    "",
    "[Service]",
    `ExecStart=${programArguments.map(systemdQuoted).join(" ")}`,
    ...Object.entries(environment).map(([name, value]) => `Environment=${systemdQuoted(`${name}=${value}`)}`),
    "Restart=always",
    `RestartSec=${RESTART_WAIT_SECONDS}`,
    `StandardOutput=append:${logFile}`,
    `StandardError=append:${logFile}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

const succeeds = (command: string[]): boolean => Bun.spawnSync(command, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

// Each system's file, and how to load and unload it. A load replaces one
// loaded before (a second install), so the new file counts.
type Service = { file: string; build: (spec: ServiceSpec) => string; load: () => boolean; unload: () => void };
const launchdTarget = (): string => `gui/${process.getuid?.()}`;
const SERVICES: Partial<Record<NodeJS.Platform, Service>> = {
  darwin: {
    file: LAUNCH_AGENT_FILE,
    build: buildLaunchAgentPlist,
    load: () => {
      succeeds(["launchctl", "bootout", `${launchdTarget()}/${LAUNCH_AGENT_LABEL}`]);
      return succeeds(["launchctl", "bootstrap", launchdTarget(), LAUNCH_AGENT_FILE]);
    },
    unload: () => void succeeds(["launchctl", "bootout", `${launchdTarget()}/${LAUNCH_AGENT_LABEL}`]),
  },
  linux: {
    file: SYSTEMD_UNIT_FILE,
    build: buildSystemdUnit,
    load: () =>
      succeeds(["systemctl", "--user", "daemon-reload"]) &&
      succeeds(["systemctl", "--user", "enable", SYSTEMD_UNIT_NAME]) &&
      succeeds(["systemctl", "--user", "restart", SYSTEMD_UNIT_NAME]),
    unload: () => {
      succeeds(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME]);
      succeeds(["systemctl", "--user", "daemon-reload"]);
    },
  },
};

const serviceForThisSystem = (): Service => {
  const service = SERVICES[process.platform];
  if (!service) throw new Error(`talos: running as a service works on macOS and Linux, not ${process.platform}`);
  return service;
};

// Pairs first, here, if it isn't yet: the code to enter on the page would be
// lost in the service's log. Sessions get the PATH talos is installed from, so
// their tools (git, brew's) are where they are in a terminal; a service's own
// PATH has almost nothing.
export const installService = async (): Promise<void> => {
  const service = serviceForThisSystem();
  const serverUrl = requireEnv(ENV_KEYS.serverUrl);
  const log = createLogger(readLogsMode(process.env[ENV_KEYS.logsMode]));
  const wantedMachineName = toIdentifierName(process.env[ENV_KEYS.machineName] || hostname());
  const { machineName } = await acceptMachine(serverUrl, httpOriginFromServerUrl(serverUrl), wantedMachineName, log);
  const spec = {
    programArguments: [process.execPath, `--env-file=${envFileOf()}`, INDEX_SCRIPT],
    environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(process.env.TALOS_HOME && { TALOS_HOME: process.env.TALOS_HOME }) },
    logFile: SERVICE_LOG_FILE,
  };
  mkdirSync(dirname(service.file), { recursive: true });
  writeFileSync(service.file, service.build(spec));
  if (!service.load()) throw new Error(`talos: the system wouldn't start ${service.file}`);
  console.log(`talos: ${machineName} runs talos at login now, and again if it stops. Its log: ${SERVICE_LOG_FILE}`);
};

// The session runner and its sessions go on until `talos runner stop`.
export const uninstallService = (): void => {
  const service = serviceForThisSystem();
  service.unload();
  rmSync(service.file, { force: true });
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
  if (ran.exitCode !== 0) throw new Error("talos: the update didn't finish");
};
