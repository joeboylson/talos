import { expect, test } from "bun:test";
import { buildSessionSettings } from "../claude/session-settings";

test("buildSessionSettings pins what keeps talos on, and adds no hooks", () => {
  const settings = JSON.parse(buildSessionSettings({ TALOS_LINK_SOCKET: "/sock" }, "/home/uploads/s1"));
  expect(settings.hooks).toBeUndefined();
  // A project's own disableAllHooks:true or enabledPlugins can't turn talos's mod off.
  expect(settings.disableAllHooks).toBe(false);
  expect(settings.enabledPlugins).toEqual({ "talos@inline": true });
  // Claude may open the images a message names, from its own uploads only.
  expect(settings.permissions.allow).toEqual(["Read(//home/uploads/s1/**)"]);
  // A project's own `env` can't blank what the mod reads.
  expect(settings.env.TALOS_LINK_SOCKET).toBe("/sock");
});

test("every interpreter and loader variable is pinned empty", () => {
  const { env } = JSON.parse(buildSessionSettings({}, "/home/uploads/s1"));
  const pinned = ["BUN_OPTIONS", "NODE_OPTIONS", "BUN_INSPECT", "BUN_INSPECT_CONNECT_TO", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"];
  expect(Object.fromEntries(pinned.map((name) => [name, env[name]]))).toEqual(Object.fromEntries(pinned.map((name) => [name, ""])));
});
