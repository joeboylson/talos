// Running talos in the background, at every login and again if it stops: a
// launch agent on macOS, a systemd user service on Linux (`talos service ...`).
// `talos update` brings an installed copy up to main (see install.sh), and
// `talos status` says where this machine stands.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  createLogger,
  ENV_KEYS,
  httpOriginFromServerUrl,
  LOCAL_STATUS_HOST,
  LOCAL_STATUS_PORT,
  LOCAL_STATUS_ROUTE,
  readLogsMode,
  requireEnv,
  toIdentifierName,
  type LocalStatus,
} from "talos-shared";
import { INSTALLED_APP_FOLDER, INSTALLED_ENV_FILE, LOCAL_STATUS_WAIT_MS, RUNNER_SCRIPT, SERVICE_LOG_FILE, TALOS_FOLDER } from "./constants";
import { readCredentials } from "./credentials";
import { cliError, type Flags } from "./cli";
import { acceptMachine } from "./pairing";
import { connectToSessions } from "./talos-sessions";

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
const outputOf = (command: string[]): string => Bun.spawnSync(command, { stdout: "pipe", stderr: "ignore" }).stdout.toString();

// Each system's file, and how to load it (start it now and at every login,
// replacing one loaded before, so a new file counts), unload it, start and
// stop it now, and ask whether it runs.
type Service = {
  file: string;
  build: (spec: ServiceSpec) => string;
  load: () => boolean;
  unload: () => void;
  start: () => boolean;
  stop: () => boolean;
  isRunning: () => boolean;
};
const launchdJob = (): string => `gui/${process.getuid?.()}/${LAUNCH_AGENT_LABEL}`;
const launchdDomain = (): string => `gui/${process.getuid?.()}`;
// A stopped launch agent is unloaded, so the next login (or a start) loads it again.
const SERVICES: Partial<Record<NodeJS.Platform, Service>> = {
  darwin: {
    file: LAUNCH_AGENT_FILE,
    build: buildLaunchAgentPlist,
    load: () => {
      succeeds(["launchctl", "bootout", launchdJob()]);
      return succeeds(["launchctl", "bootstrap", launchdDomain(), LAUNCH_AGENT_FILE]);
    },
    unload: () => void succeeds(["launchctl", "bootout", launchdJob()]),
    start: () => succeeds(["launchctl", "bootstrap", launchdDomain(), LAUNCH_AGENT_FILE]) || succeeds(["launchctl", "kickstart", launchdJob()]),
    stop: () => succeeds(["launchctl", "bootout", launchdJob()]),
    isRunning: () => outputOf(["launchctl", "print", launchdJob()]).includes("state = running"),
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
    start: () => succeeds(["systemctl", "--user", "start", SYSTEMD_UNIT_NAME]),
    stop: () => succeeds(["systemctl", "--user", "stop", SYSTEMD_UNIT_NAME]),
    isRunning: () => succeeds(["systemctl", "--user", "is-active", "--quiet", SYSTEMD_UNIT_NAME]),
  },
};

const serviceForThisSystem = (): Service => {
  const service = SERVICES[process.platform];
  if (!service) throw cliError(`running in the background works on macOS and Linux, not ${process.platform}`, "talos connect");
  return service;
};
const installedService = (): Service => {
  const service = serviceForThisSystem();
  if (!existsSync(service.file)) throw cliError("it isn't set up to run in the background", "talos service install");
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
    programArguments: [process.execPath, `--env-file=${envFileOf()}`, INDEX_SCRIPT, "connect"],
    environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(process.env.TALOS_HOME && { TALOS_HOME: process.env.TALOS_HOME }) },
    logFile: SERVICE_LOG_FILE,
  };
  mkdirSync(dirname(service.file), { recursive: true });
  writeFileSync(service.file, service.build(spec));
  if (!service.load()) throw cliError(`the system wouldn't start ${service.file}`, "talos logs");
  console.log(`${machineName} runs in the background now, and at every login (talos status, talos logs)`);
};

// The session runner and its sessions go on until `talos runner stop`.
export const uninstallService = (): void => {
  const service = serviceForThisSystem();
  service.unload();
  rmSync(service.file, { force: true });
  console.log("no longer runs in the background");
};

export const startService = (): void => {
  const service = installedService();
  if (service.isRunning()) return console.log("already running in the background");
  if (!service.start()) throw cliError("the system wouldn't start it", "talos logs");
  console.log("running in the background");
};

// Its sessions keep running in the session runner, and come back on the page
// once talos starts again.
export const stopService = (): void => {
  const service = installedService();
  if (!service.isRunning()) return console.log("already stopped");
  if (!service.stop()) throw cliError("the system wouldn't stop it");
  console.log("stopped; it starts again at the next login, or with talos service start");
};

// install.sh does the work, so an update and a fresh install are one path. It
// then runs `talos service install` from the new copy: the machine ends up
// updated and running in the background, whatever it had before (pairing
// first if it must).
export const updateTalos = (): void => {
  if (!isInstalledCopy()) throw cliError("this copy runs from a git checkout", "git pull");
  const env = { ...process.env, TALOS_HOME: TALOS_FOLDER, TALOS_INSTALL_SERVICE: "1" };
  const updated = Bun.spawnSync(["sh", "-c", `curl -fsSL ${INSTALL_SCRIPT_URL} | sh`], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
  if (updated.exitCode !== 0) throw cliError("the update didn't finish", "talos update");
};

// What `talos status` shows, each fact gathered where it lives.
export type StatusFacts = {
  version: string;
  serverUrl: string | null;
  machineName: string | null;
  service: "not-installed" | "running" | "stopped" | "unsupported";
  connection: { machineName: string; isConnected: boolean } | null;
  sessionCount: number | null;
};

export const formatStatus = ({ version, serverUrl, machineName, service, connection, sessionCount }: StatusFacts): string => {
  const serviceText = { "not-installed": "not set up (talos service install)", running: "running in the background", stopped: "stopped (talos service start)", unsupported: "not on this system" }[service];
  const connectionText = !connection ? "talos isn't running" : connection.isConnected ? `connected as ${connection.machineName}` : "trying to connect";
  const rows: [string, string][] = [
    ["version", version],
    ["server", serverUrl ?? "not set (TALOS_SERVER_URL)"],
    ["machine", machineName ? `paired as ${machineName}` : "not paired"],
    ["service", serviceText],
    ["connection", connectionText],
    ["sessions", sessionCount === null ? "session runner not running" : `${sessionCount} running`],
  ];
  return rows.map(([label, value]) => `  ${label.padEnd(12)}${value}`).join("\n");
};

export const talosVersion = (): string => {
  if (isInstalledCopy()) return readFileSync(join(INSTALLED_APP_FOLDER, "VERSION"), "utf8").trim().slice(0, 7);
  const commit = outputOf(["git", "-C", dirname(INDEX_SCRIPT), "rev-parse", "--short", "HEAD"]).trim();
  return `${commit || "unknown"} (git checkout)`;
};

// The running talos says whether it's connected, on the same local address
// the page's "This machine" panel reads. Nothing answers when it isn't running.
const readConnection = async (): Promise<StatusFacts["connection"]> => {
  const answer = await fetch(`http://${LOCAL_STATUS_HOST}:${LOCAL_STATUS_PORT}${LOCAL_STATUS_ROUTE}`, { signal: AbortSignal.timeout(LOCAL_STATUS_WAIT_MS) }).catch(() => null);
  const status = answer?.ok ? ((await answer.json().catch(() => null)) as Partial<LocalStatus> | null) : null;
  return status && typeof status.machineName === "string" ? { machineName: status.machineName, isConnected: status.isConnected === true } : null;
};

const readServiceState = (): StatusFacts["service"] => {
  const service = SERVICES[process.platform];
  if (!service) return "unsupported";
  if (!existsSync(service.file)) return "not-installed";
  return service.isRunning() ? "running" : "stopped";
};

export const showStatus = async (flags: Flags): Promise<void> => {
  const serverUrl = process.env[ENV_KEYS.serverUrl] || null;
  const credentials = serverUrl ? await readCredentials(serverUrl) : null;
  const sessions = connectToSessions({ home: TALOS_FOLDER, runnerScript: RUNNER_SCRIPT });
  const sessionCount = (await sessions.isRunning()) ? (await sessions.sessions().catch(() => [])).length : null;
  const facts = {
    version: talosVersion(),
    serverUrl,
    machineName: credentials?.machineName ?? (credentials ? "this machine" : null),
    service: readServiceState(),
    connection: await readConnection(),
    sessionCount,
  };
  if (flags.json) return console.log(JSON.stringify(facts, null, 2));
  console.log(`talos\n${formatStatus(facts)}`);
};
