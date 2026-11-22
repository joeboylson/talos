import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WS_CLOSE_CODES } from "talos-shared";
import { connectToSessions } from "../../talos-sessions";

// Real talos (runConnect, in its own process) between a stand-in session
// runner and a stand-in server.
const connect = new URL("../../connect.ts", import.meta.url).pathname;
const homes: string[] = [];
const cleanups: (() => void)[] = [];
// Once the stand-in runner is gone, talos starts a real one in the home; it's
// stopped here with the rest.
afterAll(async () => {
  cleanups.forEach((cleanup) => cleanup());
  await Promise.all(homes.map((home) => connectToSessions({ home, runnerScript: "" }).stopRunner().catch(() => {})));
  homes.forEach((home) => rmSync(home, { recursive: true, force: true }));
});

// A runner that reports one session, then goes away after endAfterMs, or with
// keepsRunning only cuts off the stream (as it does a reader that fell behind).
const startRunner = (home: string, endAfterMs: number, keepsRunning = false) => {
  const web = { sessionName: "web", folderName: "proj", state: "idle", asks: {}, openOutputs: [] };
  const runner = Bun.serve({
    unix: join(home, "runner.sock"),
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/health") return new Response("ok");
      if (path === "/sessions") return Response.json([web]);
      if (path !== "/events") return new Response("?", { status: 404 });
      const line = JSON.stringify({ type: "sessions", sessions: [web] });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`${line}\n`));
            setTimeout(() => {
              controller.close();
              if (!keepsRunning) runner.stop(true);
            }, endAfterMs);
          },
        }),
      );
    },
  });
  cleanups.push(() => runner.stop(true));
};

const startTalos = (closeFirstWith?: number) => {
  const home = mkdtempSync(join(tmpdir(), "talos-connect-"));
  homes.push(home);
  const fromTalos: { type: string; message?: string }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, upgrader) {
      const path = new URL(request.url).pathname;
      if (path === "/api/machine/check") return Response.json({ machineName: "m" });
      if (path === "/api/sockets/machine" && upgrader.upgrade(request)) return;
      return new Response("?", { status: 404 });
    },
    websocket: {
      open: (socket) => void (closeFirstWith && setTimeout(() => socket.close(closeFirstWith, "replaced"), 200)),
      message: (_socket, raw) => void fromTalos.push(JSON.parse(String(raw))),
    },
  });
  cleanups.push(() => server.stop(true));
  const serverUrl = `ws://127.0.0.1:${server.port}`;
  writeFileSync(join(home, "credentials.json"), JSON.stringify({ serverUrl, machineKey: "k", machineName: "m" }));
  writeFileSync(join(home, "folders.json"), "[]");
  const talos = Bun.spawn([process.execPath, "-e", `import { runConnect } from ${JSON.stringify(connect)}; await runConnect();`], {
    env: { ...process.env, TALOS_HOME: home, TALOS_SERVER_URL: serverUrl },
    stdout: "ignore",
    stderr: "ignore",
  });
  cleanups.push(() => talos.kill());
  return { home, talos, fromTalos };
};

test(
  "a talos another one on the machine replaced stops, instead of replacing it back",
  async () => {
    const { home, talos } = startTalos(WS_CLOSE_CODES.machineReplaced);
    startRunner(home, 60_000);
    const exited = await Promise.race([talos.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
    expect(exited).toBe(true);
  },
  15_000,
);

test(
  "when the runner goes away, the page is told which sessions ended",
  async () => {
    const { home, fromTalos } = startTalos();
    startRunner(home, 1000);
    const giveUpAt = Date.now() + 8000;
    const told = () => fromTalos.find(({ type, message }) => type === "error" && message?.includes("ended web"));
    while (!told() && Date.now() < giveUpAt) await Bun.sleep(50);
    expect(told()?.message).toBe("The session runner stopped; ended web");
  },
  15_000,
);

test(
  "when the runner only cuts off a reader that fell behind, the page isn't told its sessions ended",
  async () => {
    const { home, fromTalos } = startTalos();
    startRunner(home, 500, true);
    await Bun.sleep(4000);
    expect(fromTalos.some(({ type, message }) => type === "error" && message?.includes("ended"))).toBe(false);
  },
  15_000,
);
