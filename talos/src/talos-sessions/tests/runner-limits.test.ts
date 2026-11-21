import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectToSessions } from "../index";
import { askRunner } from "../client/hook-client";
import { homePaths } from "../constants";
import { SESSION_LIMITS } from "../limits";

// What a long-running session runner keeps on disk and in memory stays capped,
// on the real session runner with the fake Claude (tests/fake/).
const runnerScript = new URL("./fake/fake-runner.ts", import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), "talos-limits-"));
const calls = connectToSessions({ home, runnerScript });
afterAll(async () => {
  await calls.stopRunner().catch(() => {});
  rmSync(home, { recursive: true, force: true });
});
const waitUntil = async (isDone: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> => {
  const giveUpAt = Date.now() + ms;
  while (!(await isDone())) {
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
};
const folder = (name: string) => {
  mkdirSync(join(home, name));
  return join(home, name);
};

test(
  "a long log is moved aside when the runner starts, and a flood of bad hooks can't fill it or forge lines",
  async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(homePaths(home).log, "x".repeat(SESSION_LIMITS.maxRunnerLogBytes + 1));
    await calls.ensureRunning();
    expect(existsSync(`${homePaths(home).log}.1`)).toBe(true);
    const before = statSync(homePaths(home).log).size;
    const name = `x\nrunner: session admin ended\n${"y".repeat(1_000_000)}`;
    await Promise.all(Array.from({ length: 20 }, () => askRunner(homePaths(home).hooksSocket, { sessionName: name, token: "bad", details: "{}" })));
    const log = readFileSync(homePaths(home).log, "utf8");
    expect(statSync(homePaths(home).log).size - before).toBeLessThan(2000);
    expect(log).not.toContain("\nrunner: session admin ended");
  },
  20_000,
);

test(
  "a session keeps only its newest images",
  async () => {
    expect(await calls.start("pics", "pics", folder("pics"))).toEqual({ ok: true });
    await waitUntil(async () => (await calls.sessions()).find(({ sessionName }) => sessionName === "pics")?.state === "idle", "the session to be ready");
    const image = { mediaType: "image/png" as const, dataBase64: Buffer.from("png").toString("base64") };
    for (let sent = 0; sent < SESSION_LIMITS.maxUploadsKept + 5; sent += 1) await calls.send("pics", `image ${sent}`, [image]);
    expect(readdirSync(join(homePaths(home).uploads, "pics"))).toHaveLength(SESSION_LIMITS.maxUploadsKept);
  },
  60_000,
);

test(
  "a session that never finishes starting takes only so many messages",
  async () => {
    expect(await calls.start("mute", "mute", folder("mute"))).toEqual({ ok: true });
    const results = [];
    for (let sent = 0; sent <= SESSION_LIMITS.maxQueuedMessages; sent += 1) results.push(await calls.send("mute", `message ${sent}`));
    expect(results.slice(0, -1).every((result) => result.ok)).toBe(true);
    expect(results.at(-1)).toMatchObject({ ok: false, code: "still-starting" });
  },
  20_000,
);

test("a start in an allowed folder that's gone is refused", async () => {
  expect(await calls.start("gone", "gone", join(home, "not-there"))).toMatchObject({ ok: false, code: "folder-not-allowed" });
});
