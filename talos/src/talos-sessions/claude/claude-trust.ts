import { existsSync } from "node:fs";
import { realpath, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseJsonOrNull } from "../json";
import { CLAUDE_CONFIG_FILE } from "../constants";

// Claude Code asks "Do you trust the files in this folder?" the first time it
// runs in a folder, and "Allow external CLAUDE.md file imports?" when a
// CLAUDE.md there (or above it) imports a file from outside. Either would stop a
// session nobody is watching. A folder the program allowed is trusted, and its
// outside imports are left out, so the session runner answers both ahead of
// time, the same way Claude Code records the answers.

type ClaudeConfig = Record<string, unknown>;
type Projects = Record<string, Record<string, unknown>>;

// What one folder's settings were before the session runner changed them, so
// they can be put back. A setting that's missing (undefined) had no value.
export type TrustChange = { folderPath: string; before: Record<string, unknown> };

const projectsOf = (claudeConfig: ClaudeConfig): Projects => (claudeConfig.projects ?? {}) as Projects;

// The settings to give a folder: trusted, and the outside-imports question
// answered "no", unless someone already answered it.
const answersFor = (project: Record<string, unknown> | undefined): Record<string, unknown> => ({
  hasTrustDialogAccepted: true,
  ...(project?.hasClaudeMdExternalIncludesWarningShown !== true && {
    hasClaudeMdExternalIncludesWarningShown: true,
    hasClaudeMdExternalIncludesApproved: false,
  }),
});

const changedSettings = (project: Record<string, unknown> | undefined): string[] =>
  Object.entries(answersFor(project))
    .filter(([setting, value]) => project?.[setting] !== value)
    .map(([setting]) => setting);

export const markTrusted = (claudeConfig: ClaudeConfig, folderPath: string): ClaudeConfig | null => {
  const projects = projectsOf(claudeConfig);
  if (changedSettings(projects[folderPath]).length === 0) return null;
  const project = { ...projects[folderPath], ...answersFor(projects[folderPath]) };
  return { ...claudeConfig, projects: { ...projects, [folderPath]: project } };
};

// Puts back only the settings changed, leaving everything else Claude Code
// keeps for the folder.
export const restoreTrusted = (claudeConfig: ClaudeConfig, { folderPath, before }: TrustChange): ClaudeConfig => {
  const projects = projectsOf(claudeConfig);
  const project = projects[folderPath];
  if (!project) return claudeConfig;
  const kept = Object.fromEntries(Object.entries(project).filter(([setting]) => !(setting in before)));
  const restored = Object.fromEntries(Object.entries(before).filter(([, value]) => value !== undefined));
  return { ...claudeConfig, projects: { ...projects, [folderPath]: { ...kept, ...restored } } };
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

// Claude Code keeps these answers per project: the git repository a folder is
// in, or the folder itself outside one.
const projectFolderOf = (folderPath: string): string => {
  const isRepository = (folder: string) => existsSync(join(folder, ".git"));
  const findUp = (folder: string): string | null => (isRepository(folder) ? folder : dirname(folder) === folder ? null : findUp(dirname(folder)));
  return findUp(folderPath) ?? folderPath;
};

// Claude Code records the answers under the project's real path, so a path
// through a link (like macOS's /var, which is /private/var) is resolved first.
// Gives back what changed, or null if the project was already answered.
export const trustFolder = async (folderPath: string, configFile = CLAUDE_CONFIG_FILE): Promise<TrustChange | null> => {
  const realFolderPath = projectFolderOf(await realpath(folderPath));
  return changeConfig(configFile, (claudeConfig) => {
    const project = projectsOf(claudeConfig)[realFolderPath];
    const next = markTrusted(claudeConfig, realFolderPath);
    const before = Object.fromEntries(changedSettings(project).map((setting) => [setting, project?.[setting]]));
    return { next, value: next ? { folderPath: realFolderPath, before } : null };
  });
};

export const restoreTrust = (changes: readonly TrustChange[], configFile = CLAUDE_CONFIG_FILE): Promise<void> =>
  changeConfig(configFile, (claudeConfig) => ({ next: changes.reduce(restoreTrusted, claudeConfig), value: undefined }));
