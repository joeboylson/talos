import { expect, test } from "bun:test";
import { buildSessionSettings } from "../claude/session-settings";

test("buildSessionSettings pins what keeps talos on, and adds no hooks", () => {
  const settings = JSON.parse(buildSessionSettings({ TALOS_LINK_SOCKET: "/sock" }));
  expect(settings.hooks).toBeUndefined();
  // A project's own disableAllHooks:true or enabledPlugins can't turn talos's mod off.
  expect(settings.disableAllHooks).toBe(false);
  expect(settings.enabledPlugins).toEqual({ "talos@inline": true });
  // A project's own `env` can't change what the mod reads.
  expect(settings.env).toEqual({ TALOS_LINK_SOCKET: "/sock" });
});
