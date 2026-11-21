import { expect, test } from "bun:test";
import { createConnections } from "../../connections";
import { createMachineRoutes } from "../../machine-routes";
import { decideSocket } from "../../server-routes";
import { hashSecret } from "../../utils/crypto";

// The server under things happening at once: real sockets where order matters
// (fakes don't run close handlers the way Bun does).
const quiet = { event: () => {}, detail: () => {}, warn: () => {} };
const fake = (data: unknown) => {
  const sent: string[] = [];
  return { data, sent, send: (text: string) => sent.push(text), close: () => {}, ping: () => {} };
};

test("two starts at once get different session names", async () => {
  const table = { listMachines: async () => [{ machineId: "m1", machineName: "atlas", ownerPersonId: "joe" }] };
  const c = createConnections(table as never, quiet, 10);
  const h = c.websocketHandlers as unknown as Record<string, (...a: unknown[]) => unknown>;
  const machine = fake({ role: "machine", machineId: "m1", machineName: "atlas", ownerPersonId: "joe", checkedAtMs: 0 });
  const pageData = { role: "page", personId: "joe", displayName: "joe", expiresAtMs: Date.now() + 60_000, checkedAtMs: -1 };
  const phone = fake(pageData), laptop = fake(pageData);
  h.open(machine); h.open(phone); h.open(laptop);
  await Bun.sleep(5);
  h.message(machine, JSON.stringify({ type: "folders", folders: [{ folderName: "talos", path: "/tmp/talos" }] }));
  h.message(machine, JSON.stringify({ type: "sessions", sessions: [] }));
  h.message(phone, JSON.stringify({ type: "start-session", machineId: "m1", folderName: "talos" }));
  h.message(laptop, JSON.stringify({ type: "start-session", machineId: "m1", folderName: "talos" }));
  const names = machine.sent.map((t) => JSON.parse(t)).filter((m) => m.type === "start-session").map((m) => m.sessionName);
  expect(names).toEqual(["talos", "talos-2"]);
});

test("an older read that worked is still sent when a newer one fails", async () => {
  const reads: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  const table = { listMachines: () => new Promise((resolve, reject) => reads.push({ resolve, reject })) };
  const c = createConnections(table as never, quiet, 10);
  const h = c.websocketHandlers as unknown as Record<string, (...a: unknown[]) => unknown>;
  const page = fake({ role: "page", personId: "joe", displayName: "joe", expiresAtMs: Date.now() + 60_000, checkedAtMs: 0 });
  h.open(page);
  await Bun.sleep(1);
  const second = c.sendMachineListToPages("joe").catch(() => "failed");
  reads[1].reject(new Error("throttled"));
  await second;
  reads[0].resolve([{ machineId: "m1", machineName: "atlas", ownerPersonId: "joe" }]);
  await Bun.sleep(500);
  const lists = page.sent.map((t) => JSON.parse(t)).filter((m) => m.type === "machines");
  expect(lists.length).toBe(1);
});

test("a machine removed while its socket is opening is cut off", async () => {
  const secret = "s".repeat(40);
  const records = new Map([["m1", { machineId: "m1", machineName: "atlas", ownerPersonId: "joe", keyHash: hashSecret(secret), pairedAtMs: 0 }]]);
  let findDelayMs = 0;
  const table = {
    findMachine: async (id: string) => { const r = records.get(id) ?? null; await Bun.sleep(findDelayMs); return r; },
    removeMachine: async (id: string) => void records.delete(id),
    listMachines: async () => [...records.values()],
    saveMachine: async () => {},
  };
  const checks = { readTrustedPerson: async () => ({ personId: "joe", displayName: "joe", signInId: "x", expiresAtMs: Date.now() + 60_000 }), readSignedInPerson: async () => null };
  const connections = createConnections(table as never, quiet, 10);
  const routes = createMachineRoutes(table as never, checks as never, connections, quiet);
  const server = Bun.serve({
    port: 0,
    async fetch(request, srv) {
      const decision = await decideSocket(request, checks as never, routes, quiet);
      if (!decision || "response" in decision) return new Response("no", { status: 401 });
      return srv.upgrade(request, { data: decision.data }) ? undefined : new Response("x", { status: 400 });
    },
    websocket: connections.websocketHandlers,
  });
  // Machine connects; its key lookup takes 50 ms (a slow DynamoDB read).
  findDelayMs = 50;
  const ws = new WebSocket(`ws://localhost:${server.port}/api/sockets/machine`, { headers: { authorization: `Bearer m1.${secret}` } } as never);
  let closedCode: number | null = null;
  ws.addEventListener("close", (e) => (closedCode = e.code));
  const received: string[] = [];
  ws.addEventListener("message", (e) => received.push(String(e.data)));
  await Bun.sleep(10);
  // Owner presses remove during the key lookup.
  findDelayMs = 0;
  const response = await routes.remove(Object.assign(new Request("http://x/", { method: "DELETE" }), { params: { machineId: "m1" } }) as never);
  expect(response.status).toBe(204);
  await Bun.sleep(300);
  expect(records.has("m1")).toBe(false);
  connections.sendFolderRename("m1", "a", "b");
  await Bun.sleep(50);
  expect(ws.readyState).toBe(WebSocket.CLOSED);
  expect(received.some((text) => text.includes("rename-folder"))).toBe(false);
  ws.close(); server.stop(true);
});

const MACHINES = 2;
const SESSIONS = 50;

test("a page that opens gets every kept history, however much there is", async () => {
  const records = Array.from({ length: MACHINES }, (_, i) => ({ machineId: `m${i}`, machineName: `n${i}`, ownerPersonId: "joe" }));
  const c = createConnections({ listMachines: async () => records } as never, quiet, 10);
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const u = new URL(req.url);
      const data = u.pathname === "/m"
        ? { role: "machine", machineId: u.searchParams.get("id"), machineName: "x", ownerPersonId: "joe", checkedAtMs: 0 }
        : { role: "page", personId: "joe", displayName: "d", expiresAtMs: Date.now() + 1e6, checkedAtMs: 0 };
      return srv.upgrade(req, { data } as never) ? undefined : new Response("x");
    },
    websocket: c.websocketHandlers as never,
  });
  const open = (path: string) => new Promise<WebSocket>((res) => { const ws = new WebSocket(`ws://localhost:${server.port}${path}`); ws.onopen = () => res(ws); });
  const sessions = Array.from({ length: SESSIONS }, (_, s) => ({ sessionName: `s${s}`, folderName: "f", state: "idle" }));
  for (const r of records) {
    const m = await open(`/m?id=${r.machineId}`);
    m.send(JSON.stringify({ type: "sessions", sessions }));
    for (let s = 0; s < SESSIONS; s++) {
      const entries = Array.from({ length: 10 }, (_, e) => ({ kind: "text", entryId: `e${e}`, position: e, text: "é".repeat(20_000) }));
      m.send(JSON.stringify({ type: "session-entries", sessionName: `s${s}`, entries }));
      await Bun.sleep(2); // stay inside the 32 MB/s ingress budget
    }
  }
  await Bun.sleep(300);
  const got = new Set<string>();
  const page = new WebSocket(`ws://localhost:${server.port}/p`);
  page.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type === "session-entries") got.add(`${m.machineId}/${m.sessionName}`); };
  await Bun.sleep(4000);
  page.close(); server.stop(true);
  expect(got.size).toBe(MACHINES * SESSIONS);
}, 60000);
