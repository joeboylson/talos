import { expect, test } from "bun:test";
import type { Logger } from "talos-shared";
import { createConnections, type SocketData } from "../../connections";
import type { MachinesTable } from "../../machines-table";

// Fake sockets that record what the server sends them, so the real handlers
// run without a network.
const quietLog: Logger = { event: () => {}, detail: () => {}, warn: () => {} };
const machinesTable = { listMachines: async () => [] } as unknown as MachinesTable;

const fakeSocket = (data: SocketData) => {
  const sent: string[] = [];
  return { data, sent, send: (text: string) => sent.push(text), close: () => {} };
};

const setUp = async () => {
  const connections = createConnections(machinesTable, quietLog);
  const handlers = connections.websocketHandlers as unknown as Record<string, (...args: unknown[]) => unknown>;
  const machine = fakeSocket({ role: "machine", machineId: "m1", machineName: "atlas", ownerPersonId: "joe" });
  const page = fakeSocket({ role: "page", personId: "joe", displayName: "joe", expiresAtMs: Date.now() + 60_000, checkedAtMs: Date.now() });
  handlers.open?.(machine);
  handlers.open?.(page);
  await Bun.sleep(0);
  const send = (socket: typeof machine, message: unknown) => handlers.message?.(socket, JSON.stringify(message));
  send(machine, { type: "folders", folders: [{ folderName: "talos", path: "/tmp/talos" }] });
  send(machine, { type: "sessions", sessions: [{ sessionName: "fix", folderName: "talos", state: "idle" }] });
  return { machine, page, send };
};

test("a session name that isn't text doesn't crash the server, and nothing reaches the machine", async () => {
  const { machine, page, send } = await setUp();
  const sentBefore = machine.sent.length;
  expect(() => send(page, { type: "start-session", machineId: "m1", folderName: "talos", sessionName: 5 })).not.toThrow();
  expect(machine.sent.length).toBe(sentBefore);
});

test("garbage of any kind is dropped quietly", async () => {
  const { machine, page, send } = await setUp();
  [null, 1, "x", [], { type: "send-to-session" }, { type: "start-session", machineId: {} }].forEach((message) => {
    expect(() => send(page, message)).not.toThrow();
    expect(() => send(machine, message)).not.toThrow();
  });
});

test("entries for a session the machine never reported are dropped", async () => {
  const { page, machine, send } = await setUp();
  const pageSentBefore = page.sent.length;
  send(machine, { type: "session-entries", sessionName: "made-up", entries: [{ kind: "text", position: 0, entryId: "e", text: "x" }] });
  expect(page.sent.length).toBe(pageSentBefore);
  send(machine, { type: "session-entries", sessionName: "fix", entries: [{ kind: "text", position: 0, entryId: "e", text: "x" }] });
  expect(page.sent.length).toBe(pageSentBefore + 1);
});

test("a page can't send to a session name that's a path", async () => {
  const { machine, page, send } = await setUp();
  const sentBefore = machine.sent.length;
  send(page, { type: "stop-session", machineId: "m1", sessionName: "../.." });
  expect(machine.sent.length).toBe(sentBefore);
});

test("an answer reaches only a running session on the owner's machine", async () => {
  const { machine, page, send } = await setUp();
  const sentBefore = machine.sent.length;
  send(page, { type: "answer-output", machineId: "m1", sessionName: "made-up", outputId: "o1", choice: 0 });
  expect(machine.sent.length).toBe(sentBefore);
  send(page, { type: "answer-output", machineId: "m1", sessionName: "fix", outputId: "o1", choice: 1 });
  expect(JSON.parse(machine.sent.at(-1) ?? "")).toEqual({ type: "answer-output", sessionName: "fix", outputId: "o1", choice: 1 });
});

test("a machine's error reaches its owner's pages, named for the machine", async () => {
  const { machine, page, send } = await setUp();
  send(machine, { type: "error", message: "That question has closed" });
  expect(JSON.parse(page.sent.at(-1) ?? "")).toEqual({ type: "error", message: "atlas: That question has closed" });
});
