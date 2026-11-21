// What talos passes in to runSessionRunner. Every runner file reads them from
// here, so none makes its own logger or folder check when it loads.
import { CLAUDE_COMMAND, CLAUDE_CONFIG_FILE, homePaths, type HomePaths } from "../constants";
import type { Catalog, OutputKind, TurnShape } from "../kinds";

export type SessionsLogger = {
  event: (message: string) => void;
  detail: (message: string) => void;
  warn: (message: string) => void;
};
// Whether a session may start in this folder. Asked on every start request.
export type FolderCheck = (folderName: string, path: string) => Promise<boolean>;

export type RunnerInputs = {
  // The folder the module keeps its own files in.
  home: string;
  log: SessionsLogger;
  isAllowedFolder: FolderCheck;
  // The kinds of structured output talos defines, and what a normal turn may send.
  kinds: readonly OutputKind[];
  proseTurn: TurnShape;
  // Put each folder's trust setting back when the session runner stops. An
  // example's session runner does; talos's leaves its folders trusted.
  restoreTrustOnStop?: boolean;
  // The command that runs Claude Code, and the settings file it reads trust
  // from. Tests pass stand-ins, so they never touch the real ~/.claude.json.
  claudeCommand?: readonly string[];
  claudeConfigFile?: string;
};

const given: RunnerInputs = {
  home: "",
  log: { event: console.log, detail: () => {}, warn: console.warn },
  isAllowedFolder: async () => false,
  kinds: [],
  proseTurn: { output: "prose", optional: [] },
};

export const useRunnerInputs = (inputs: RunnerInputs): void => {
  Object.assign(given, inputs);
};

export const log: SessionsLogger = {
  event: (message) => given.log.event(message),
  detail: (message) => given.log.detail(message),
  warn: (message) => given.log.warn(message),
};

export const isAllowedFolder: FolderCheck = (folderName, path) => given.isAllowedFolder(folderName, path);

export const paths = (): HomePaths => homePaths(given.home);

export const restoresTrust = (): boolean => given.restoreTrustOnStop === true;

export const claudeCommand = (): readonly string[] => given.claudeCommand ?? [CLAUDE_COMMAND];
export const claudeConfigFile = (): string => given.claudeConfigFile ?? CLAUDE_CONFIG_FILE;

export const catalog = (): Catalog => ({ kinds: given.kinds, proseTurn: given.proseTurn });
