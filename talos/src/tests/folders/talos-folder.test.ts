import { expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// talos's own folder holds the machine's key and the folders list: closed to
// everyone else, however it was made before. Each case runs talos's code in a
// process of its own, with its own TALOS_HOME.
const src = new URL("../..", import.meta.url).pathname;
const runIn = (talosHome: string, code: string) => {
  const ran = Bun.spawnSync(["sh", "-c", `umask 000; exec "${process.execPath}" -e '${code}'`], { env: { ...process.env, TALOS_HOME: talosHome }, cwd: src });
  if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
};
const modeOf = (path: string) => statSync(path).mode & 0o777;

test("a folder add closes a talos folder made earlier with loose permissions, and keeps its files private", () => {
  const root = mkdtempSync(join(tmpdir(), "talos-folder-"));
  const talosHome = join(root, "talos");
  mkdirSync(talosHome);
  chmodSync(talosHome, 0o755);
  mkdirSync(join(root, "work"));
  runIn(talosHome, `import { changeFolders, addFolder } from "./folders"; await changeFolders((folders) => addFolder(folders, ${JSON.stringify(join(root, "work"))}));`);
  expect(modeOf(talosHome)).toBe(0o700);
  expect(modeOf(join(talosHome, "folders.json"))).toBe(0o600);
  rmSync(root, { recursive: true, force: true });
});

test("the machine's key replaces a link planted at its path instead of writing through it, and an old loose key is closed when read", () => {
  const root = mkdtempSync(join(tmpdir(), "talos-key-"));
  const talosHome = join(root, "talos");
  mkdirSync(talosHome, { mode: 0o700 });
  writeFileSync(join(root, "victim"), "untouched");
  symlinkSync(join(root, "victim"), join(talosHome, "credentials.json"));
  runIn(talosHome, `import { saveCredentials } from "./credentials"; await saveCredentials({ serverUrl: "ws://localhost:1", machineKey: "SECRET", machineName: "m" });`);
  expect(readFileSync(join(root, "victim"), "utf8")).toBe("untouched");
  expect(lstatSync(join(talosHome, "credentials.json")).isSymbolicLink()).toBe(false);
  expect(modeOf(join(talosHome, "credentials.json"))).toBe(0o600);
  chmodSync(join(talosHome, "credentials.json"), 0o644);
  runIn(talosHome, `import { readCredentials } from "./credentials"; await readCredentials("ws://localhost:1");`);
  expect(modeOf(join(talosHome, "credentials.json"))).toBe(0o600);
  rmSync(root, { recursive: true, force: true });
});
