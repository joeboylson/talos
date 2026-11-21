import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real talos (runConnect) between a stand-in session runner that turns every
// request down and a stand-in server that plays the page's commands: whatever
// the owner tried and couldn't do comes back to the page as an error.
const home = mkdtempSync(join(tmpdir(), "talos-refusals-"));
const REFUSALS: Record<string, { code: string; reason: string }> = {
  "/sessions": { code: "folder-not-allowed", reason: "That folder isn't allowed" },
  "/sessions/web/send": { code: "not-sendable", reason: "That message can't be sent" },
  "/sessions/web/stop": { code: "no-such-session", reason: "No such session" },
  "/sessions/web/answer": { code: "closed", reason: "That question closed" },
  // A code this talos doesn't know yet.
  "/sessions/web/ask": { code: "made-up-later", reason: "?" },
};
const runner = Bun.serve({
  unix: join(home, "runner.sock"),
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ok");
    if (path === "/events") {
      const line = JSON.stringify({ type: "sessions", sessions: [{ sessionName: "web", folderName: "proj", state: "idle", asks: {}, openOutputs: [] }] });
      return new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode(`${line}\n`)) }));
    }
    const refusal = REFUSALS[path];
    return refusal ? Response.json(refusal, { status: 409 }) : new Response("?", { status: 404 });
  },
});
const fromTalos: { type: string; message?: string; sessions?: unknown[] }[] = [];
let machineSocket: { send: (text: string) => void } | null = null;
const server = Bun.serve({
  port: 0,
  fetch(request, upgrader) {
    const path = new URL(request.url).pathname;
    if (path === "/api/machine/check") return Response.json({ machineName: "m" });
    if (path === "/api/sockets/machine" && upgrader.upgrade(request)) return;
    return new Response("?", { status: 404 });
  },
  websocket: {
    open: (socket) => void (machineSocket = socket),
    message: (_socket, raw) => void fromTalos.push(JSON.parse(String(raw))),
  },
});
let stopTalos = () => {};
afterAll(() => {
  stopTalos();
  runner.stop(true);
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

test(
  "start, send, stop, answer and ask that are turned down, for any reason, are shown on the page",
  async () => {
    const serverUrl = `ws://127.0.0.1:${server.port}`;
    writeFileSync(join(home, "credentials.json"), JSON.stringify({ serverUrl, machineKey: "k", machineName: "m" }));
    writeFileSync(join(home, "folders.json"), JSON.stringify([{ folderName: "proj", path: home }]));
    // Its own process, so it reads this home and no other test's settings.
    const connect = new URL("../../connect.ts", import.meta.url).pathname;
    const talos = Bun.spawn([process.execPath, "-e", `import { runConnect } from ${JSON.stringify(connect)}; await runConnect();`], {
      env: { ...process.env, TALOS_HOME: home, TALOS_SERVER_URL: serverUrl },
      stdout: "ignore",
      stderr: "ignore",
    });
    stopTalos = () => talos.kill();
    while (!fromTalos.some((message) => message.type === "sessions" && (message.sessions?.length ?? 0) > 0)) await Bun.sleep(50);
    const commands = [
      { type: "start-session", folderName: "proj", sessionName: "web2" },
      { type: "start-session", folderName: "nowhere", sessionName: "web3" },
      { type: "send-to-session", sessionName: "web", text: "hi", images: [] },
      { type: "stop-session", sessionName: "web" },
      { type: "answer-output", sessionName: "web", outputId: "o1", choice: 0 },
      { type: "ask-for-output", sessionName: "web", kind: "status" },
    ];
    const told = [];
    for (const command of commands) {
      const before = fromTalos.length;
      machineSocket?.send(JSON.stringify(command));
      const giveUpAt = Date.now() + 3000;
      while (!fromTalos.slice(before).some(({ type }) => type === "error") && Date.now() < giveUpAt) await Bun.sleep(25);
      told.push(fromTalos.slice(before).find(({ type }) => type === "error")?.message ?? "NOTHING");
    }
    // A folder list talos can't read says so, rather than blaming the runner.
    writeFileSync(join(home, "folders.json"), '[{"folderName":"proj"');
    const before = fromTalos.length;
    machineSocket?.send(JSON.stringify({ type: "start-session", folderName: "proj", sessionName: "web4" }));
    const giveUpAt = Date.now() + 3000;
    while (!fromTalos.slice(before).some(({ type }) => type === "error") && Date.now() < giveUpAt) await Bun.sleep(25);
    expect(fromTalos.slice(before).find(({ type }) => type === "error")?.message).toContain("isn't a folder list");
    expect(told).toEqual([
      "That folder isn't allowed",
      "There's no folder called nowhere",
      "That message can't be sent",
      "No such session",
      "That question closed",
      "That didn't reach the session runner; try again",
    ]);
  },
  30_000,
);
