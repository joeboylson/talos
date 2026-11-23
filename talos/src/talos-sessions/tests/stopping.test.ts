import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { connectToSessions } from "../index";
import { homePaths } from "../constants";

// Stopping sessions and the session runner, on the real session runner with the
// fake Claude (tests/fake/): nothing may keep running, and trust is always put
// back, however the stop comes. Each test has its own home and runner.
const homes: string[] = [];
const runnerScript = new URL("./fake/fake-runner.ts", import.meta.url).pathname;

const newHome = () => {
  const home = mkdtempSync(join(tmpdir(), "talos-stopping-"));
  homes.push(home);
  return { home, calls: connectToSessions({ home, runnerScript }) };
};
const folderIn = (home: string, name: string) => {
  mkdirSync(join(home, name));
  return join(home, name);
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidIn = (file: string): number => Number(readFileSync(file, "utf8"));
const waitUntil = async (isDone: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> => {
  const giveUpAt = Date.now() + ms;
  while (!(await isDone())) {
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
};
const fileExists = (path: string) => Bun.file(path).exists();
const trustOf = (home: string, folder: string) => JSON.parse(readFileSync(join(home, "claude.json"), "utf8")).projects?.[realpathSync(folder)];

afterAll(async () => {
  await Promise.all(homes.map((home) => connectToSessions({ home, runnerScript }).stopRunner().catch(() => {})));
  homes.forEach((home) => rmSync(home, { recursive: true, force: true }));
});

test(
  "a stop sent while a session is starting stops it once it has",
  async () => {
    const { home, calls } = newHome();
    await calls.ensureRunning();
    const work = folderIn(home, "slow");
    const starting = calls.start("slow", "slow", work);
    await Bun.sleep(100);
    expect(await calls.stop("slow")).toEqual({ ok: true });
    expect(await starting).toEqual({ ok: true });
    expect(await calls.sessions()).toEqual([]);
    // Ended so soon it may not have saved its id yet; if it did, it's gone.
    await Bun.sleep(500);
    expect((await fileExists(join(work, "claude.pid"))) && isAlive(pidIn(join(work, "claude.pid")))).toBe(false);
  },
  20_000,
);

test(
  "a start while the session runner stops is turned down, and nothing is left running",
  async () => {
    const { home, calls } = newHome();
    await calls.ensureRunning();
    const stubborn = folderIn(home, "stubborn");
    expect(await calls.start("stubborn", "stubborn", stubborn)).toEqual({ ok: true });
    await waitUntil(() => fileExists(join(stubborn, "claude.pid")), "Claude to start");
    const stopping = calls.stopRunner();
    await Bun.sleep(300);
    await expect(calls.start("late", "late", folderIn(home, "late"))).rejects.toThrow();
    await stopping;
    expect(isAlive(pidIn(join(stubborn, "claude.pid")))).toBe(false);
    expect(await fileExists(join(home, "late", "claude.pid"))).toBe(false);
  },
  20_000,
);

test(
  "what a session started goes with it, even if it ignores the terminal closing",
  async () => {
    const { home, calls } = newHome();
    await calls.ensureRunning();
    const spawner = folderIn(home, "spawner");
    expect(await calls.start("spawner", "spawner", spawner)).toEqual({ ok: true });
    await waitUntil(() => fileExists(join(spawner, "child.pid")), "the child to start");
    expect(await calls.stop("spawner")).toEqual({ ok: true });
    await waitUntil(() => !isAlive(pidIn(join(spawner, "child.pid"))), "the child to be gone", 3000);
  },
  20_000,
);

test(
  "trust is put back after a runner is killed outright (by the next one) or told to stop by the system",
  async () => {
    const { home, calls } = newHome();
    const runnerPid = () => pidIn(homePaths(home).runnerLock);
    for (const signal of ["SIGKILL", "SIGTERM"] as const) {
      await calls.ensureRunning();
      const work = folderIn(home, `work-${signal}`);
      expect(await calls.start(signal.toLowerCase(), "work", work)).toEqual({ ok: true });
      expect(trustOf(home, work)?.hasTrustDialogAccepted).toBe(true);
      const killed = runnerPid();
      process.kill(killed, signal);
      await waitUntil(() => !isAlive(killed), "the runner to be gone");
      if (signal === "SIGKILL") await calls.ensureRunning();
      await waitUntil(() => trustOf(home, work)?.hasTrustDialogAccepted === undefined, `trust put back after ${signal}`);
    }
  },
  30_000,
);

test(
  "two programs starting the runner on one home at once share one runner",
  async () => {
    for (const _try of [1, 2, 3]) {
      const { home, calls } = newHome();
      const other = connectToSessions({ home, runnerScript });
      await Promise.all([calls.ensureRunning(), other.ensureRunning()]);
      const work = folderIn(home, "work");
      expect(await other.start("one", "work", work)).toEqual({ ok: true });
      expect((await calls.sessions()).map(({ sessionName }) => sessionName)).toEqual(["one"]);
      const runners = Bun.spawnSync(["pgrep", "-f", `fake-runner.ts ${home}`]).stdout.toString().trim().split("\n");
      expect(runners).toHaveLength(1);
      await calls.stopRunner();
    }
  },
  30_000,
);

test("a malformed ask or answer throws even for a session that isn't there", async () => {
  const { calls } = newHome();
  await calls.ensureRunning();
  await expect(calls.ask("nobody", "no-such-kind")).rejects.toThrow();
  await expect(calls.answer("nobody", "q1", 1.5)).rejects.toThrow();
  expect(await calls.answer("nobody", "q1", 0)).toMatchObject({ ok: false, code: "no-such-session" });
});

test(
  "a runner whose home was taken over leaves the new runner's trust record alone",
  async () => {
    const { home, calls } = newHome();
    await calls.ensureRunning();
    // The old runner has trust of its own to put back, in a folder outside the home.
    const { home: elsewhere } = newHome();
    expect(await calls.start("old", "old", folderIn(elsewhere, "old"))).toEqual({ ok: true });
    const oldRunner = pidIn(homePaths(home).runnerLock);
    rmSync(home, { recursive: true, force: true });
    // Another program starts a new runner there and a session in it.
    const index = new URL("../index.ts", import.meta.url).pathname;
    const script = `import { connectToSessions } from ${JSON.stringify(index)}; import { mkdirSync } from "node:fs";
const calls = connectToSessions({ home: ${JSON.stringify(home)}, runnerScript: ${JSON.stringify(runnerScript)} });
await calls.ensureRunning(); mkdirSync(${JSON.stringify(join(home, "work"))}); await calls.start("new", "work", ${JSON.stringify(join(home, "work"))});`;
    expect(Bun.spawnSync([process.execPath, "-e", script]).exitCode).toBe(0);
    expect(existsSync(homePaths(home).trustChanges)).toBe(true);
    await waitUntil(() => !isAlive(oldRunner), "the old runner to stop", 15_000);
    expect(existsSync(homePaths(home).trustChanges)).toBe(true);
  },
  30_000,
);

test(
  "trust a crashed runner left that can't be put back at the next start is still put back later",
  async () => {
    const { home, calls } = newHome();
    await calls.ensureRunning();
    const first = folderIn(home, "first");
    expect(await calls.start("first", "first", first)).toEqual({ ok: true });
    const crashed = pidIn(homePaths(home).runnerLock);
    process.kill(crashed, "SIGKILL");
    await waitUntil(() => !isAlive(crashed), "the runner to be gone");
    // The settings file can't be read for a moment, so the put-back at start fails.
    chmodSync(join(home, "claude.json"), 0o000);
    await calls.ensureRunning();
    chmodSync(join(home, "claude.json"), 0o600);
    expect(await calls.start("second", "second", folderIn(home, "second"))).toEqual({ ok: true });
    await calls.stopRunner();
    expect(trustOf(home, first)?.hasTrustDialogAccepted).toBeUndefined();
  },
  30_000,
);

test(
  "what a killed runner's sessions started is ended by the next runner",
  async () => {
    const { home, calls } = newHome();
    await calls.ensureRunning();
    const spawner = folderIn(home, "spawner");
    expect(await calls.start("spawner", "spawner", spawner)).toEqual({ ok: true });
    await waitUntil(() => fileExists(join(spawner, "child.pid")), "the child to start");
    const killed = pidIn(homePaths(home).runnerLock);
    process.kill(killed, "SIGKILL");
    await waitUntil(() => !isAlive(killed), "the runner to be gone");
    await Bun.sleep(500);
    expect(isAlive(pidIn(join(spawner, "child.pid")))).toBe(true);
    await calls.ensureRunning();
    await waitUntil(() => !isAlive(pidIn(join(spawner, "child.pid"))), "the child to be gone", 3000);
  },
  30_000,
);

test(
  "right after stopRunner, the runner reads as gone",
  async () => {
    const { calls } = newHome();
    await calls.ensureRunning();
    expect(await calls.sessions()).toEqual([]);
    await calls.stopRunner();
    expect(await calls.isRunning()).toBe(false);
  },
  20_000,
);

test(
  "a lock left from before the machine started is taken over, even if its process number is alive again",
  async () => {
    const { home, calls } = newHome();
    // This test's own process stands in for whatever got the old runner's number.
    writeFileSync(homePaths(home).runnerLock, String(process.pid), { mode: 0o600 });
    const beforeBoot = new Date(Date.now() - uptime() * 1000 - 3_600_000);
    utimesSync(homePaths(home).runnerLock, beforeBoot, beforeBoot);
    await calls.ensureRunning();
    expect(pidIn(homePaths(home).runnerLock)).not.toBe(process.pid);
    await calls.stopRunner();
  },
  30_000,
);

const groupsFile = (home: string) => homePaths(home).sessionGroups;
const readGroups = (home: string): { groupId: number; atMs: number }[] => JSON.parse(readFileSync(groupsFile(home), "utf8"));

test(
  "a killed runner's session that had run for hours still has what it started ended",
  async () => {
    const { home, calls } = newHome();
    await calls.ensureRunning();
    const spawner = folderIn(home, "spawner");
    expect(await calls.start("spawner", "spawner", spawner)).toEqual({ ok: true });
    await waitUntil(() => fileExists(join(spawner, "child.pid")), "the child to start");
    const killed = pidIn(homePaths(home).runnerLock);
    process.kill(killed, "SIGKILL");
    await waitUntil(() => !isAlive(killed), "the runner to be gone");
    // As if it had started hours ago (but since the machine started).
    const hoursAgoMs = Date.now() - Math.min(3 * 3_600_000, (uptime() * 1000) / 2);
    writeFileSync(groupsFile(home), JSON.stringify(readGroups(home).map((group) => ({ ...group, atMs: hoursAgoMs }))));
    await Bun.sleep(500);
    await calls.ensureRunning();
    await waitUntil(() => !isAlive(pidIn(join(spawner, "child.pid"))), "the child to be gone", 3000);
  },
  30_000,
);

test(
  "a recorded group number another process has since is left alone",
  async () => {
    const { home, calls } = newHome();
    // A process leading its own group, as if it got a dead session's number.
    const stranger = Bun.spawn(["perl", "-e", "setpgrp; sleep 30"], { stdio: ["ignore", "ignore", "ignore"] });
    await Bun.sleep(300);
    writeFileSync(groupsFile(home), JSON.stringify([{ groupId: stranger.pid, atMs: Date.now() - 10 * 60_000 }]), { mode: 0o600 });
    try {
      await calls.ensureRunning();
      await Bun.sleep(300);
      expect(isAlive(stranger.pid)).toBe(true);
    } finally {
      stranger.kill("SIGKILL");
      await calls.stopRunner().catch(() => {});
    }
  },
  30_000,
);

test(
  "a session whose start never comes needs the person, and nothing goes into it",
  async () => {
    const { home, calls } = newHome();
    process.env.FAKE_START_WAIT_MS = "500";
    try {
      await calls.ensureRunning();
    } finally {
      delete process.env.FAKE_START_WAIT_MS;
    }
    expect(await calls.start("mute", "mute", folderIn(home, "mute"))).toEqual({ ok: true });
    expect(await calls.send("mute", "sent while starting")).toEqual({ ok: true });
    const stateOf = async () => (await calls.sessions()).find(({ sessionName }) => sessionName === "mute");
    await waitUntil(async () => (await stateOf())?.state === "needs-you", "the session to need the person");
    expect((await stateOf())?.isTurnOver).toBe(false);
    // What's sent waits: with no mod to send it through, nothing goes in.
    expect(await calls.send("mute", "and again")).toEqual({ ok: true });
    // Esc on its screen doesn't make it look ready.
    expect(await calls.keys("mute", "\x1b")).toEqual({ ok: true });
    expect((await stateOf())?.state).toBe("needs-you");
    await calls.stopRunner();
  },
  20_000,
);

test(
  "trust changed for sessions started together is all kept, so all of it is put back",
  async () => {
    const { home, calls } = newHome();
    await calls.ensureRunning();
    const names = ["t1", "t2", "t3", "t4", "t5", "t6"];
    const folders = names.map((name) => folderIn(home, name));
    expect(await Promise.all(names.map((name, at) => calls.start(name, name, folders[at]!)))).toEqual(names.map(() => ({ ok: true })));
    const kept = JSON.parse(readFileSync(homePaths(home).trustChanges, "utf8")) as unknown[];
    expect(kept).toHaveLength(names.length);
    await calls.stopRunner();
  },
  30_000,
);

test(
  "a lock whose process number another process has since is taken over",
  async () => {
    const { home, calls } = newHome();
    // A process started after the lock was written, as if it got the dead runner's number.
    const stranger = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      writeFileSync(homePaths(home).runnerLock, String(stranger.pid), { mode: 0o600 });
      const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
      utimesSync(homePaths(home).runnerLock, tenMinutesAgo, tenMinutesAgo);
      await calls.ensureRunning();
      expect(pidIn(homePaths(home).runnerLock)).not.toBe(stranger.pid);
      expect(isAlive(stranger.pid)).toBe(true);
    } finally {
      stranger.kill("SIGKILL");
      await calls.stopRunner().catch(() => {});
    }
  },
  30_000,
);

test(
  "a session shown as stuck that starts after all becomes ready and types what was sent meanwhile",
  async () => {
    const { home, calls } = newHome();
    process.env.FAKE_START_WAIT_MS = "500";
    try {
      await calls.ensureRunning();
    } finally {
      delete process.env.FAKE_START_WAIT_MS;
    }
    const late = folderIn(home, "late");
    expect(await calls.start("late", "late", late)).toEqual({ ok: true });
    expect(await calls.send("late", "sent while starting")).toEqual({ ok: true });
    const stateOf = async () => (await calls.sessions()).find(({ sessionName }) => sessionName === "late")?.state;
    await waitUntil(async () => (await stateOf()) === "needs-you", "the session to look stuck");
    await waitUntil(() => readFileSync(join(late, "transcript.jsonl"), "utf8").includes("sent while starting"), "the message to be typed", 10_000);
    await waitUntil(async () => (await stateOf()) === "idle", "the session to be ready", 10_000);
    await calls.stopRunner();
  },
  30_000,
);
