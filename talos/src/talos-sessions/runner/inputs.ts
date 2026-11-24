// What talos passes in to runSessionRunner. Every runner file reads them from
// here, so none makes its own logger or folder check when it loads.
import { CLAUDE_COMMAND, homePaths, type HomePaths } from "../constants";
import type { Catalog, OutputKind, TurnShape } from "../kinds";
import { SESSION_LIMITS } from "../limits";

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
  // The command that runs Claude Code. Tests pass a stand-in.
  claudeCommand?: readonly string[];
  // How long a session may take to report its start (SESSION_LIMITS.startLongestWaitMs),
  // and how long its mod may go quiet (SESSION_LIMITS.linkSilenceMs).
  startLongestWaitMs?: number;
  linkSilenceMs?: number;
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


export const claudeCommand = (): readonly string[] => given.claudeCommand ?? [CLAUDE_COMMAND];

export const startLongestWaitMs = (): number => given.startLongestWaitMs ?? SESSION_LIMITS.startLongestWaitMs;
export const linkSilenceMs = (): number => given.linkSilenceMs ?? SESSION_LIMITS.linkSilenceMs;

export const catalog = (): Catalog => ({ kinds: given.kinds, proseTurn: given.proseTurn });
