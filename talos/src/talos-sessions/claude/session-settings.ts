import { MOD_PLUGIN_ID } from "../constants";

// Env vars an on-disk `env` block could set to hijack the mod helper's
// interpreter: prepend bun/node args, inject a library, or attach a debugger.
// Pinned empty in --settings, which outranks a project's own settings. (A
// session as the same OS user can still tamper with the interpreter itself:
// the same-uid limit in MODULES.md.)
const PINNED_EMPTY_ENV = {
  BUN_OPTIONS: "",
  NODE_OPTIONS: "",
  BUN_INSPECT: "",
  BUN_INSPECT_CONNECT_TO: "",
  DYLD_INSERT_LIBRARIES: "",
  DYLD_LIBRARY_PATH: "",
  LD_PRELOAD: "",
  LD_LIBRARY_PATH: "",
};

// The --settings value every session gets. It adds to the person's own
// settings rather than replacing them, and outranks a project's, so a session
// can't write .claude/settings.local.json to switch talos off for the next
// session in its folder: hooks stay on, talos's mod stays enabled, and the env
// the mod reads stays as talos set it.
// Messages name their images by path (talos's mod can't attach them), so
// Claude may read the session's uploads folder, and nothing around it (the
// home also holds the runner's sockets). `//` starts an absolute path in a rule.
export const buildSessionSettings = (sessionEnv: Record<string, string>, uploadsFolder: string): string =>
  JSON.stringify({
    disableAllHooks: false,
    enabledPlugins: { [MOD_PLUGIN_ID]: true },
    permissions: { allow: [`Read(/${uploadsFolder}/**)`] },
    env: { ...PINNED_EMPTY_ENV, ...sessionEnv },
  });
