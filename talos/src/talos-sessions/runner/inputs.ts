// What talos passes in to runSessionRunner. Every runner file reads them from
// here, so none makes its own logger or folder check when it loads.
export type SessionsLogger = {
  event: (message: string) => void;
  detail: (message: string) => void;
  warn: (message: string) => void;
};
// Whether a session may start in this folder. Asked on every start request.
export type FolderCheck = (folderName: string, path: string) => Promise<boolean>;
export type RunnerInputs = { log: SessionsLogger; isAllowedFolder: FolderCheck };

const given: RunnerInputs = {
  log: { event: console.log, detail: () => {}, warn: console.warn },
  isAllowedFolder: async () => false,
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
