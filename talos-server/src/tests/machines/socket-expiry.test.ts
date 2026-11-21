import { expect, setSystemTime, test } from "bun:test";
import type { Logger } from "talos-shared";
import { CLOSE_CODES } from "../../constants";
import { createConnections, type SocketData } from "../../connections";
import type { MachinesTable } from "../../machines-table";

const quietLog: Logger = { event: () => {}, detail: () => {}, warn: () => {} };
const machinesTable = { listMachines: async () => [] } as unknown as MachinesTable;

// A fake socket that records whether it was pinged and how it was closed.
const fakeSocket = (data: SocketData) => {
  const record = { pinged: false, closedWith: null as number | null };
  return { data, record, send: () => {}, ping: () => (record.pinged = true), close: (code: number) => (record.closedWith = code) };
};

const openOn = (handlers: Record<string, (socket: unknown) => void>, socket: unknown) => handlers.open?.(socket);

test("the keep-alive sweep closes a page socket whose session has expired, and pings a fresh one", async () => {
  const connections = createConnections(machinesTable, quietLog);
  const handlers = connections.websocketHandlers as unknown as Record<string, (socket: unknown) => void>;

  const expired = fakeSocket({ role: "page", personId: "joe", displayName: "joe", expiresAtMs: Date.now() - 1000, checkedAtMs: Date.now() });
  const fresh = fakeSocket({ role: "page", personId: "sam", displayName: "sam", expiresAtMs: Date.now() + 60_000, checkedAtMs: Date.now() });
  const machine = fakeSocket({ role: "machine", machineId: "m1", machineName: "atlas", ownerPersonId: "joe", checkedAtMs: 0 });
  [expired, fresh, machine].forEach((socket) => openOn(handlers, socket));
  await Bun.sleep(0);

  connections.pingAllSockets();

  expect(expired.record.closedWith).toBe(CLOSE_CODES.sessionExpired);
  expect(expired.record.pinged).toBe(false);
  expect(fresh.record.closedWith).toBeNull();
  expect(fresh.record.pinged).toBe(true);
  expect(machine.record.pinged).toBe(true);
});

test("a page whose session ends at this very moment is closed", async () => {
  const nowMs = Date.now();
  setSystemTime(new Date(nowMs));
  const connections = createConnections(machinesTable, quietLog);
  const handlers = connections.websocketHandlers as unknown as Record<string, (socket: unknown) => void>;
  const endingNow = fakeSocket({ role: "page", personId: "joe", displayName: "joe", expiresAtMs: nowMs, checkedAtMs: Date.now() });
  openOn(handlers, endingNow);
  await Bun.sleep(0);
  connections.pingAllSockets();
  setSystemTime();
  expect(endingNow.record.closedWith).toBe(CLOSE_CODES.sessionExpired);
});
