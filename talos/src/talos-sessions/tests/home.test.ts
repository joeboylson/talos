import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { connectToSessions } from "../index";
import { homePaths } from "../constants";

// The home folder the module is given, on the real session runner with the
// fake Claude (tests/fake/). Each test has its own home.
const runnerScript = new URL("./fake/fake-runner.ts", import.meta.url).pathname;
const homes: string[] = [];
const newHome = () => {
  const home = mkdtempSync(join(tmpdir(), "talos-home-"));
  homes.push(home);
  return home;
};
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitUntil = async (isDone: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> => {
  const giveUpAt = Date.now() + ms;
  while (!(await isDone())) {
    if (Date.now() > giveUpAt) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
};

afterAll(async () => {
  for (const home of homes) {
    chmodSync(home, 0o700);
    await connectToSessions({ home, runnerScript }).stopRunner().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "a home given as a relative path works like a whole one",
  async () => {
    const home = newHome();
    const calls = connectToSessions({ home: relative(process.cwd(), home), runnerScript });
    await calls.ensureRunning();
    mkdirSync(join(home, "work"));
    expect(await calls.start("rel", "work", join(home, "work"))).toEqual({ ok: true });
    await waitUntil(async () => (await calls.sessions())[0]?.state === "idle", "the session to be ready");
    await calls.stopRunner();
  },
  20_000,
);

test(
  "a home made earlier with loose permissions is closed to everyone else",
  async () => {
    const home = newHome();
    chmodSync(home, 0o777);
    const calls = connectToSessions({ home, runnerScript });
    await calls.ensureRunning();
    expect(statSync(home).mode & 0o777).toBe(0o700);
    await calls.stopRunner();
  },
  20_000,
);

test(
  "a runner whose home was deleted stops, and leaves the new runner there alone",
  async () => {
    const home = newHome();
    const calls = connectToSessions({ home, runnerScript });
    await calls.ensureRunning();
    const oldRunner = Number(readFileSync(homePaths(home).runnerLock, "utf8"));
    rmSync(home, { recursive: true, force: true });
    // Another program starts a new runner there; this one's open connection
    // would still reach the old runner.
    const index = new URL("../index.ts", import.meta.url).pathname;
    const started = Bun.spawnSync([process.execPath, "-e", `import { connectToSessions } from ${JSON.stringify(index)}; await connectToSessions({ home: ${JSON.stringify(home)}, runnerScript: ${JSON.stringify(runnerScript)} }).ensureRunning();`]);
    expect(started.exitCode).toBe(0);
    const newRunner = Number(readFileSync(homePaths(home).runnerLock, "utf8"));
    await waitUntil(() => !isAlive(oldRunner), "the old runner to stop", 15_000);
    expect(isAlive(newRunner)).toBe(true);
    expect(readFileSync(homePaths(home).runnerLock, "utf8")).toBe(String(newRunner));
    expect(existsSync(homePaths(home).runnerSocket)).toBe(true);
    process.kill(newRunner, "SIGTERM");
  },
  30_000,
);

test(
  "a request that fails in the runner says why",
  async () => {
    const home = newHome();
    const calls = connectToSessions({ home, runnerScript });
    await calls.ensureRunning();
    mkdirSync(join(home, "work"));
    expect(await calls.start("img", "work", join(home, "work"))).toEqual({ ok: true });
    await waitUntil(async () => (await calls.sessions())[0]?.state === "idle", "the session to be ready");
    // A file where its uploads folder goes, so saving the image fails.
    writeFileSync(homePaths(home).uploads, "");
    const image = { mediaType: "image/png" as const, dataBase64: Buffer.from("png").toString("base64") };
    const failed = await calls.send("img", "look", [image]).then(() => "", (error: Error) => error.message);
    expect(failed).toContain("the session runner failed");
    expect(failed).not.toContain("<!doctype");
    await calls.stopRunner();
  },
  20_000,
);
