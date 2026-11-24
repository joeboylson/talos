import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectToSessions } from "../index";
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

// The messages the fake Claude was sent, in order: their text, and how many
// images each carried.
type SentLine = { text: string; imageCount: number };
const sentMessages = (dir: string): SentLine[] =>
  readFileSync(join(dir, "transcript.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((line) => line.type === "user" && line.isReplay === true)
    .map(({ message: { content } }) =>
      typeof content === "string"
        ? { text: content, imageCount: 0 }
        : { text: content.filter((block: { type: string }) => block.type === "text").map((block: { text: string }) => block.text).join("\n"), imageCount: content.filter((block: { type: string }) => block.type === "image").length },
    );
const userLines = (dir: string) => (existsSync(join(dir, "transcript.jsonl")) ? sentMessages(dir).map(({ text }) => text) : []);
const png = { mediaType: "image/png" as const, dataBase64: Buffer.from("png").toString("base64") };

test(
  "a long log is moved aside when the runner starts",
  async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(homePaths(home).log, "x".repeat(SESSION_LIMITS.maxRunnerLogBytes + 1));
    await calls.ensureRunning();
    expect(existsSync(`${homePaths(home).log}.1`)).toBe(true);
    expect(statSync(homePaths(home).log).size).toBeLessThan(SESSION_LIMITS.maxRunnerLogBytes);
  },
  20_000,
);

test(
  "a message's images go in with it",
  async () => {
    const dir = folder("pics");
    expect(await calls.start("pics", "pics", dir)).toEqual({ ok: true });
    await waitUntil(async () => (await calls.sessions()).find(({ sessionName }) => sessionName === "pics")?.state === "idle", "the session to be ready");
    expect(await calls.send("pics", "look", [png, png])).toEqual({ ok: true });
    await waitUntil(() => userLines(dir).includes("look"), "the message to go in");
    expect(sentMessages(dir)).toEqual([{ text: "look", imageCount: 2 }]);
  },
  20_000,
);

test(
  "a session that never finishes starting takes only so many messages",
  async () => {
    expect(await calls.start("mute", "mute", folder("mute"))).toEqual({ ok: true });
    const results = [];
    for (let sent = 0; sent <= SESSION_LIMITS.maxQueuedMessages; sent += 1) results.push(await calls.send("mute", `message ${sent}`));
    expect(results.slice(0, -1).every((result) => result.ok)).toBe(true);
    expect(results.at(-1)).toMatchObject({ ok: false, code: "too-many-waiting" });
  },
  20_000,
);

test(
  "a session started and ended while its groups can't be saved (a full disk) still starts, and is gone once it ends",
  async () => {
    const listed = async () => (await calls.sessions()).some(({ sessionName }) => sessionName === "no-disk");
    rmSync(homePaths(home).sessionGroups, { force: true });
    mkdirSync(homePaths(home).sessionGroups);
    try {
      expect(await calls.start("no-disk", "no-disk", folder("no-disk"))).toEqual({ ok: true });
      await waitUntil(async () => (await calls.sessions()).find(({ sessionName }) => sessionName === "no-disk")?.state === "idle", "the session to be ready");
      expect(await calls.stop("no-disk")).toEqual({ ok: true });
      await waitUntil(async () => !(await listed()), "the session to go");
    } finally {
      rmSync(homePaths(home).sessionGroups, { recursive: true, force: true });
    }
  },
  20_000,
);

test(
  "a permission prompt up as a session starts stands, and what was sent goes in once it's answered",
  async () => {
    expect(await calls.start("prompting", "prompting", folder("prompting"))).toEqual({ ok: true });
    expect(await calls.send("prompting", "queued")).toEqual({ ok: true });
    await Bun.sleep(4000);
    const session = (await calls.sessions()).find(({ sessionName }) => sessionName === "prompting");
    expect(session?.state).toBe("needs-you");
    expect(userLines(join(home, "prompting"))).toEqual([]);
    // Once the prompt is answered and the turn is over, what was sent goes in.
    expect(await calls.answerPermission("prompting", session!.permissionAsks![0]!.id, true)).toEqual({ ok: true });
    await waitUntil(() => userLines(join(home, "prompting")).includes("queued"), "the waiting message", 10_000);
    await calls.stop("prompting");
  },
  20_000,
);

test("a start in an allowed folder that's gone is refused", async () => {
  expect(await calls.start("gone", "gone", join(home, "not-there"))).toMatchObject({ ok: false, code: "folder-not-allowed" });
});

test(
  "images sent while a session starts all go in with their messages",
  async () => {
    const dir = folder("queued");
    expect(await calls.start("queued", "queued", dir)).toEqual({ ok: true });
    for (let sent = 0; sent < 6; sent += 1) expect(await calls.send("queued", `msg ${sent}`, [png, png, png, png])).toEqual({ ok: true });
    await waitUntil(() => userLines(dir).includes("msg 5"), "the last message", 30_000);
    expect(sentMessages(dir).map(({ imageCount }) => imageCount)).toEqual([4, 4, 4, 4, 4, 4]);
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
  "a compaction mid-turn leaves an open question showing",
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
  "a send made as a session becomes ready goes after the messages sent while it started, each a turn of its own",
  async () => {
    const dir = folder("order");
    expect(await calls.start("order", "order", dir)).toEqual({ ok: true });
    expect(await calls.send("order", "first", [png])).toEqual({ ok: true });
    expect(await calls.send("order", "second")).toEqual({ ok: true });
    await waitUntil(async () => (await calls.sessions()).find(({ sessionName }) => sessionName === "order")?.state !== "starting", "the session to be ready");
    expect(await calls.send("order", "third")).toEqual({ ok: true });
    await waitUntil(() => userLines(dir).includes("third"), "every message", 10_000);
    expect(userLines(dir).map((line) => line.split(/\s/)[0])).toEqual(["first", "second", "third"]);
  },
  30_000,
);
