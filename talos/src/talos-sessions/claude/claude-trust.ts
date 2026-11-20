import { realpath, rename } from "node:fs/promises";
import { parseJsonOrNull } from "../json";
import { CLAUDE_CONFIG_FILE } from "../constants";

// Claude Code asks "Do you trust the files in this folder?" the first time it
// runs in a folder, which would stop a session nobody is watching. A folder
// the program allowed is trusted, so the session runner answers it ahead of
// time, the same way Claude Code records the answer.

type ClaudeConfig = Record<string, unknown>;
type Projects = Record<string, Record<string, unknown>>;

// What one folder's trust setting was before the session runner changed it, so
// it can be put back. undefined: the folder had no setting at all.
export type TrustChange = { folderPath: string; before: unknown };

const projectsOf = (claudeConfig: ClaudeConfig): Projects => (claudeConfig.projects ?? {}) as Projects;

export const markTrusted = (claudeConfig: ClaudeConfig, folderPath: string): ClaudeConfig | null => {
  const projects = projectsOf(claudeConfig);
  if (projects[folderPath]?.hasTrustDialogAccepted === true) return null;
  const project = { ...projects[folderPath], hasTrustDialogAccepted: true };
  return { ...claudeConfig, projects: { ...projects, [folderPath]: project } };
};

// Puts back only the one setting changed, leaving everything else Claude Code
// keeps for the folder.
export const restoreTrusted = (claudeConfig: ClaudeConfig, { folderPath, before }: TrustChange): ClaudeConfig => {
  const projects = projectsOf(claudeConfig);
  const project = projects[folderPath];
  if (!project) return claudeConfig;
  const { hasTrustDialogAccepted: _changed, ...rest } = project;
  const restored = before === undefined ? rest : { ...rest, hasTrustDialogAccepted: before };
  return { ...claudeConfig, projects: { ...projects, [folderPath]: restored } };
};

// One change to the file at a time, each read fresh, so two at once can't lose
// each other. Written to a new file and swapped in, so Claude Code never reads
// a half-written settings file.
let changing: Promise<unknown> = Promise.resolve();
let writeCount = 0;

const changeConfig = <T>(configFile: string, change: (claudeConfig: ClaudeConfig) => { next: ClaudeConfig | null; value: T }): Promise<T> => {
  const run = async (): Promise<T> => {
    const file = Bun.file(configFile);
    const claudeConfig = parseJsonOrNull((await file.exists()) ? await file.text() : "{}");
    if (typeof claudeConfig !== "object" || claudeConfig === null) {
      throw new Error(`${configFile} isn't readable settings; it won't be changed`);
    }
    const { next, value } = change(claudeConfig as ClaudeConfig);
    if (next) {
      writeCount += 1;
      const newFile = `${configFile}.talos-${process.pid}-${writeCount}`;
      await Bun.write(newFile, JSON.stringify(next, null, 2));
      await rename(newFile, configFile);
    }
    return value;
  };
  const result = changing.then(run, run);
  changing = result.catch(() => {});
  return result;
};

// Claude Code records trust under the folder's real path, so a path through a
// link (like macOS's /var, which is /private/var) is resolved first. Gives back
// what changed, or null if the folder was already trusted.
export const trustFolder = async (folderPath: string, configFile = CLAUDE_CONFIG_FILE): Promise<TrustChange | null> => {
  const realFolderPath = await realpath(folderPath);
  return changeConfig(configFile, (claudeConfig) => {
    const next = markTrusted(claudeConfig, realFolderPath);
    return { next, value: next ? { folderPath: realFolderPath, before: projectsOf(claudeConfig)[realFolderPath]?.hasTrustDialogAccepted } : null };
  });
};

export const restoreTrust = (changes: readonly TrustChange[], configFile = CLAUDE_CONFIG_FILE): Promise<void> =>
  changeConfig(configFile, (claudeConfig) => ({ next: changes.reduce(restoreTrusted, claudeConfig), value: undefined }));
