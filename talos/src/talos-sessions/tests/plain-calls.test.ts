import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectToSessions } from "../client/plain-calls";
import { RUNNER_ROUTES, sessionRoute } from "../client/runner-protocol";
import { homePaths } from "../constants";

// A stand-in session runner on a real socket, answering each route the way the
// real one can: done, refused, a malformed request, or broken.
const home = mkdtempSync(join(tmpdir(), "talos-calls-"));
const refused = (code: string, reason: string, status = 409) => Response.json({ code, reason }, { status });
const fake = Bun.serve({
  unix: homePaths(home).runnerSocket,
  routes: {
    [RUNNER_ROUTES.health]: new Response("ok"),
    [RUNNER_ROUTES.sessions]: { GET: () => Response.json([{ sessionName: "fix", folderName: "talos", state: "idle", asks: {}, openOutputs: [] }]) },
    [sessionRoute("fix", "send")]: { POST: () => new Response(null, { status: 204 }) },
    [sessionRoute("fix", "answer")]: { POST: () => refused("closed", "That question has closed") },
    [sessionRoute("ghost", "stop")]: { POST: () => refused("no-such-session", "no session ghost", 404) },
    [sessionRoute("fix", "ask")]: { POST: () => new Response("expected a kind that can be asked for", { status: 400 }) },
    [sessionRoute("fix", "stop")]: { POST: () => new Response("<html>boom</html>", { status: 500 }) },
    [sessionRoute("fix", "resize")]: { POST: () => refused("made-up-code", "?") },
    [RUNNER_ROUTES.events]: {
      GET: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "notice", sessionName: "fix", message: "hi" })}\n`));
              controller.close();
            },
          }),
        ),
    },
  },
});
afterAll(() => {
  fake.stop(true);
  rmSync(home, { recursive: true, force: true });
});
const calls = connectToSessions({ home, runnerScript: "/nowhere.ts" });

describe("the plain calls", () => {
  test("a done request is ok", async () => {
    expect(await calls.send("fix", "hi")).toEqual({ ok: true });
  });
  test("a refusal carries its code and reason", async () => {
    expect(await calls.answer("fix", "q1", 0)).toEqual({ ok: false, code: "closed", reason: "That question has closed" });
    expect(await calls.stop("ghost")).toEqual({ ok: false, code: "no-such-session", reason: "no session ghost" });
  });
  test.each([
    ["a malformed request", () => calls.ask("fix", "nope")],
    ["a broken session runner's error page", () => calls.stop("fix")],
    ["a refusal with a code it doesn't know", () => calls.resize("fix", 80, 24)],
  ])("%s throws, so it's never taken for a refusal", async (_name, call) => {
    await expect(call()).rejects.toThrow();
  });
  test("the session list is read and checked", async () => {
    expect((await calls.sessions()).map(({ sessionName }) => sessionName)).toEqual(["fix"]);
  });
  test("following gives every event, and says when the stream ended", async () => {
    const seen: unknown[] = [];
    const { ended } = calls.follow((event) => seen.push(event));
    await ended;
    expect(seen).toEqual([{ type: "notice", sessionName: "fix", message: "hi" }]);
  });
  test("following ends, with no error, when the session runner goes away mid-stream", async () => {
    const goneHome = mkdtempSync(join(tmpdir(), "talos-calls-gone-"));
    const gone = Bun.serve({
      unix: homePaths(goneHome).runnerSocket,
      routes: {
        [RUNNER_ROUTES.events]: {
          GET: () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "notice", sessionName: "fix", message: "bye" })}\n`));
                  setTimeout(() => controller.error(new Error("gone")), 50);
                },
              }),
            ),
        },
      },
    });
    const seen: unknown[] = [];
    const { ended } = connectToSessions({ home: goneHome, runnerScript: "/nowhere.ts" }).follow((event) => seen.push(event));
    await expect(ended).resolves.toBeUndefined();
    expect(seen).toEqual([{ type: "notice", sessionName: "fix", message: "bye" }]);
    gone.stop(true);
    rmSync(goneHome, { recursive: true, force: true });
  });
  test("a session runner that isn't there throws, and isn't running", async () => {
    const elsewhere = connectToSessions({ home: join(home, "none"), runnerScript: "/nowhere.ts" });
    expect(await elsewhere.isRunning()).toBe(false);
    await expect(elsewhere.send("fix", "hi")).rejects.toThrow();
  });
});
