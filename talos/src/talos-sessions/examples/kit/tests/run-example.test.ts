import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectToSessions } from "../../../index";
import { claimRun } from "../run-example";

// The module's own fake runner, started by path, so nothing is imported past the kit.
const fakeRunner = new URL("../../../tests/fake/fake-runner.ts", import.meta.url).pathname;
const runExample = new URL("../run-example.ts", import.meta.url).pathname;

const exampleFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), "talos-kit-"));
  mkdirSync(join(folder, "data"));
  writeFileSync(join(folder, "data", "note.txt"), "hi");
  return folder;
};

test(
  "a run's folder isn't taken from another run of the example that's still going",
  async () => {
    const folder = exampleFolder();
    const { home } = await claimRun(folder);
    const other = connectToSessions({ home, runnerScript: fakeRunner });
    await other.ensureRunning();
    await expect(claimRun(folder)).rejects.toThrow("another run");
    expect(await other.isRunning()).toBe(true);
    await other.stopRunner();
    while (await other.isRunning()) await Bun.sleep(50);
    expect((await claimRun(folder)).work).toBe(join(folder, "run", "work"));
    rmSync(folder, { recursive: true, force: true });
  },
  20_000,
);

test("an example run without a terminal says so before it touches anything", () => {
  const folder = exampleFolder();
  const script = `import { runExample } from ${JSON.stringify(runExample)};
await runExample(${JSON.stringify(folder)}, { initial: null, step: (state) => ({ state, actions: [] }), render: () => [] });`;
  writeFileSync(join(folder, "main.ts"), script);
  const ran = Bun.spawnSync([process.execPath, join(folder, "main.ts")], { stdin: "pipe", env: { ...process.env, MODE: "live" } });
  expect(ran.exitCode).not.toBe(0);
  expect(ran.stderr.toString()).toContain("run an example in a terminal");
  expect(existsSync(join(folder, "run"))).toBe(false);
  rmSync(folder, { recursive: true, force: true });
});
