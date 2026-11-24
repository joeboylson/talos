import { MOD_PLUGIN_ID } from "../constants";

// The --settings value every session gets. It adds to the person's own
// settings rather than replacing them, and outranks a project's, so a session
// can't write .claude/settings.local.json to switch talos off for the next
// session in its folder: hooks stay on, talos's mod stays enabled, and the env
// the mod reads stays as talos set it.
export const buildSessionSettings = (sessionEnv: Record<string, string>): string =>
  JSON.stringify({
    disableAllHooks: false,
    enabledPlugins: { [MOD_PLUGIN_ID]: true },
    env: sessionEnv,
  });
