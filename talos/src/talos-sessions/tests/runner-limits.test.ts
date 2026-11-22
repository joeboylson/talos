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

test(
  "Esc while a session starts (say, on a startup dialog) leaves it starting, so its queued messages still go in",
  async () => {
    expect(await calls.start("mute-esc", "mute-esc", folder("mute-esc"))).toEqual({ ok: true });
    expect(await calls.send("mute-esc", "queued")).toEqual({ ok: true });
    expect(await calls.keys("mute-esc", "\x1b")).toEqual({ ok: true });
    const session = (await calls.sessions()).find(({ sessionName }) => sessionName === "mute-esc");
    expect(session?.state).toBe("starting");
  },
  20_000,
);

test("a start in an allowed folder that's gone is refused", async () => {
  expect(await calls.start("gone", "gone", join(home, "not-there"))).toMatchObject({ ok: false, code: "folder-not-allowed" });
});

const userLines = (dir: string) =>
  readFileSync(join(dir, "transcript.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.type === "user").map((line) => line.message.content as string);
const png = { mediaType: "image/png" as const, dataBase64: Buffer.from("png").toString("base64") };

test(
  "images sent while a session starts are all still there when it types them",
  async () => {
    const dir = folder("queued");
    expect(await calls.start("queued", "queued", dir)).toEqual({ ok: true });
    for (let sent = 0; sent < 6; sent += 1) expect(await calls.send("queued", `msg ${sent}`, [png, png, png, png])).toEqual({ ok: true });
    await waitUntil(() => existsSync(join(dir, "transcript.jsonl")) && userLines(dir).some((line) => line.startsWith("msg 5")), "the last message", 30_000);
    expect(readFileSync(join(dir, "transcript.jsonl"), "utf8")).not.toContain("MISSING");
  },
  60_000,
);

test(
  "two messages sent at once go in one after the other, each whole",
  async () => {
    const dir = folder("pair");
    expect(await calls.start("pair", "pair", dir)).toEqual({ ok: true });
    await waitUntil(async () => (await calls.sessions()).find(({ sessionName }) => sessionName === "pair")?.state === "idle", "the session to be ready");
    expect(await Promise.all([calls.send("pair", "first", [png]), calls.send("pair", "second", [png])])).toEqual([{ ok: true }, { ok: true }]);
    await waitUntil(() => userLines(dir).length + readFileSync(join(dir, "transcript.jsonl"), "utf8").split("queued_command").length - 1 >= 2, "both messages", 10_000);
    const typed = readFileSync(join(dir, "transcript.jsonl"), "utf8");
    expect(typed).not.toMatch(/\.pngsecond/);
  },
  60_000,
);

test(
  "a tools listing bigger than a socket takes at once arrives whole",
  async () => {
    const bigHome = mkdtempSync(join(tmpdir(), "talos-big-listing-"));
    process.env.FAKE_NOTE_DESCRIPTION_PAD = "20000";
    const big = connectToSessions({ home: bigHome, runnerScript });
    await big.ensureRunning();
    delete process.env.FAKE_NOTE_DESCRIPTION_PAD;
    const work = join(bigHome, "work");
    mkdirSync(work);
    expect(await big.start("big", "work", work)).toEqual({ ok: true });
    await waitUntil(async () => (await big.sessions())[0]?.state === "idle", "the session to be ready");
    const token = Bun.spawnSync(["ps", "eww", "-o", "command="]).stdout.toString();
    const hookToken = /TALOS_HOOK_TOKEN=([0-9a-f-]{36})/.exec(token.split("\n").find((line) => line.includes(bigHome) && line.includes("TALOS_HOOK_TOKEN")) ?? "")?.[1];
    const answer = await askRunner(homePaths(bigHome).hooksSocket, { sessionName: "big", token: hookToken ?? "", wants: "kinds" });
    await big.stopRunner();
    rmSync(bigHome, { recursive: true, force: true });
    expect(answer?.kind).toBe("tools");
  },
  30_000,
);

test(
  "a compaction mid-turn (a SessionStart) leaves an open question showing",
  async () => {
    const dir = folder("compact");
    expect(await calls.start("compact", "compact", dir)).toEqual({ ok: true });
    await waitUntil(async () => (await calls.sessions()).find(({ sessionName }) => sessionName === "compact")?.state === "idle", "the session to be ready");
    expect(await calls.send("compact", "go-compact")).toEqual({ ok: true });
    await waitUntil(async () => (await calls.sessions()).find(({ sessionName }) => sessionName === "compact")?.state === "needs-you", "the question");
    await Bun.sleep(2000);
    const session = (await calls.sessions()).find(({ sessionName }) => sessionName === "compact");
    expect([session?.state, session?.openOutputs.length]).toEqual(["needs-you", 1]);
  },
  30_000,
);

test(
  "a send made as a session becomes ready goes after the messages queued while it started",
  async () => {
    const dir = folder("order");
    expect(await calls.start("order", "order", dir)).toEqual({ ok: true });
    expect(await calls.send("order", "first", [png])).toEqual({ ok: true });
    expect(await calls.send("order", "second")).toEqual({ ok: true });
    await waitUntil(async () => (await calls.sessions()).find(({ sessionName }) => sessionName === "order")?.state !== "starting", "the session to be ready");
    expect(await calls.send("order", "third")).toEqual({ ok: true });
    await waitUntil(() => readFileSync(join(dir, "transcript.jsonl"), "utf8").includes("BUSY third"), "every message", 10_000);
    const busy = readFileSync(join(dir, "transcript.jsonl"), "utf8").match(/BUSY (second|third)/g);
    expect(busy).toEqual(["BUSY second", "BUSY third"]);
  },
  30_000,
);
