import { existsSync } from "node:fs";
import { realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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

// What the session runner set in one folder's settings (after), and what they
// were before, so they can be put back. A setting missing from before had no
// value (it's kept as JSON, which leaves out undefined).
export type TrustChange = { folderPath: string; before: Record<string, unknown>; after: Record<string, unknown> };

const isMap = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Settings shaped the way Claude Code writes them: a map, with a map of projects
// that are maps. Anything else is left alone rather than reshaped.
const isReadableConfig = (value: unknown): value is ClaudeConfig =>
  isMap(value) && (value.projects === undefined || (isMap(value.projects) && Object.values(value.projects).every(isMap)));

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
// keeps for the folder. A setting that's no longer what the session runner set
// was answered since, by the person in Claude Code, and stays.
export const restoreTrusted = (claudeConfig: ClaudeConfig, { folderPath, before, after }: TrustChange): ClaudeConfig => {
  const projects = projectsOf(claudeConfig);
  const project = projects[folderPath];
  if (!project) return claudeConfig;
  const isOurs = (setting: string) => setting in after && project[setting] === after[setting];
  const kept = Object.fromEntries(Object.entries(project).filter(([setting]) => !isOurs(setting)));
  const restored = Object.fromEntries(Object.entries(before).filter(([setting, value]) => value !== undefined && isOurs(setting)));
  return { ...claudeConfig, projects: { ...projects, [folderPath]: { ...kept, ...restored } } };
};

// One change to the file at a time, each read fresh, so two at once can't lose
// each other. Written to a new file with the old one's permissions (it holds the
// account) and swapped in, so Claude Code never reads a half-written settings
// file. A link to the file stays a link: the file it points to is changed.
// Claude Code writes the file too, so a change made while ours was worked out
// starts ours over.
// shortcut: a write landing between the last check and the swap is still lost;
// nothing closes that without Claude Code locking the file.
let changing: Promise<unknown> = Promise.resolve();
let writeCount = 0;
const CHANGE_TRIES = 3;

const readText = async (file: string): Promise<string> => ((await Bun.file(file).exists()) ? Bun.file(file).text() : "{}");

const changeConfig = <T>(configFile: string, change: (claudeConfig: ClaudeConfig) => { next: ClaudeConfig | null; value: T }): Promise<T> => {
  const run = async (triesLeft = CHANGE_TRIES): Promise<T> => {
    const target = await realpath(configFile).catch(() => configFile);
    const text = await readText(target);
    const claudeConfig = parseJsonOrNull(text);
    if (!isReadableConfig(claudeConfig)) throw new Error(`${configFile} isn't readable settings; it won't be changed`);
    const { next, value } = change(claudeConfig);
    if (!next) return value;
    const mode = await stat(target).then(({ mode }) => mode & 0o777, () => 0o600);
    writeCount += 1;
    const newFile = `${target}.talos-${process.pid}-${writeCount}`;
    await writeFile(newFile, JSON.stringify(next, null, 2), { mode });
    if (triesLeft > 1 && (await readText(target)) !== text) {
      await rm(newFile, { force: true });
      return run(triesLeft - 1);
    }
    await rename(newFile, target);
    return value;
  };
  const result = changing.then(() => run(), () => run());
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
    const changed = changedSettings(project);
    const before = Object.fromEntries(changed.map((setting) => [setting, project?.[setting]]));
    const after = Object.fromEntries(changed.map((setting) => [setting, answersFor(project)[setting]]));
    return { next, value: next ? { folderPath: realFolderPath, before, after } : null };
  });
};

export const restoreTrust = (changes: readonly TrustChange[], configFile = CLAUDE_CONFIG_FILE): Promise<void> =>
  changeConfig(configFile, (claudeConfig) => ({ next: changes.reduce(restoreTrusted, claudeConfig), value: undefined }));
