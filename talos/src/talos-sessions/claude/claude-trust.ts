import { rename } from "node:fs/promises";
import { parseJsonOrNull } from "../json";
import { CLAUDE_CONFIG_FILE } from "../constants";

// Claude Code asks "Do you trust the files in this folder?" the first time it
// runs in a folder, which would stop a session nobody is watching. A folder
// the owner allowed with `talos folders add` is trusted, so talos answers it
// ahead of time, the same way Claude Code records the answer.
export const markTrusted = (claudeConfig: Record<string, unknown>, folderPath: string): Record<string, unknown> | null => {
  const projects = (claudeConfig.projects ?? {}) as Record<string, Record<string, unknown>>;
  if (projects[folderPath]?.hasTrustDialogAccepted === true) return null;
  const project = { ...projects[folderPath], hasTrustDialogAccepted: true };
  return { ...claudeConfig, projects: { ...projects, [folderPath]: project } };
};

// Written to a new file and then swapped in, so Claude Code never reads a
// half-written settings file.
export const trustFolder = async (folderPath: string): Promise<void> => {
  const configFile = Bun.file(CLAUDE_CONFIG_FILE);
  const currentText = (await configFile.exists()) ? await configFile.text() : "{}";
  const claudeConfig = parseJsonOrNull(currentText);
  if (typeof claudeConfig !== "object" || claudeConfig === null) {
    throw new Error(`${CLAUDE_CONFIG_FILE} isn't readable settings; talos won't change it`);
  }
  const trustedConfig = markTrusted(claudeConfig as Record<string, unknown>, folderPath);
  if (!trustedConfig) return;
  const newFile = `${CLAUDE_CONFIG_FILE}.talos-${process.pid}`;
  await Bun.write(newFile, JSON.stringify(trustedConfig, null, 2));
  await rename(newFile, CLAUDE_CONFIG_FILE);
};
