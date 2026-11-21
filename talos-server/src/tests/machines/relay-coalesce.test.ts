import { expect, test } from "bun:test";
import type { Logger } from "talos-shared";
import { createConnections, type SocketData } from "../../connections";
import type { MachinesTable } from "../../machines-table";

const quietLog: Logger = { event: () => {}, detail: () => {}, warn: () => {} };
const fakeSocket = (data: SocketData) => {
  const sent: string[] = [];
  return { data, sent, send: (text: string) => sent.push(text), close: () => {} };
};
const machineListsIn = (sent: string[]) => sent.filter((text) => JSON.parse(text).type === "machines");

// Session updates rebuild the list from the machines read at connect, so even a
// flood of them scans the shared machines table not once, and still reaches
// the page, coalesced.
test("a burst of machine session updates scans the table not once and is coalesced", async () => {
  let scans = 0;
  const atlas = { machineId: "m1", machineName: "atlas", ownerPersonId: "joe" };
  const machinesTable = { listMachines: async () => (scans++, [atlas]) } as unknown as MachinesTable;
  const connections = createConnections(machinesTable, quietLog);
  const handlers = connections.websocketHandlers as unknown as Record<string, (...a: unknown[]) => unknown>;
  const machine = fakeSocket({ role: "machine", machineId: "m1", machineName: "atlas", ownerPersonId: "joe", checkedAtMs: 0 });
  const page = fakeSocket({ role: "page", personId: "joe", displayName: "joe", expiresAtMs: Date.now() + 60_000, checkedAtMs: Date.now() });
  handlers.open?.(machine);
  handlers.open?.(page);
  await Bun.sleep(30);
  const scansBefore = scans;
  const listsBefore = machineListsIn(page.sent).length;
  for (let i = 0; i < 100; i += 1) handlers.message?.(machine, JSON.stringify({ type: "sessions", sessions: [] }));
  await Bun.sleep(250);
  expect(scans - scansBefore).toBe(0);
  const newLists = machineListsIn(page.sent).length - listsBefore;
  expect(newLists).toBeGreaterThanOrEqual(1);
  expect(newLists).toBeLessThanOrEqual(3);
});

test("a table read overtaken by a newer one doesn't send its older list", async () => {
  const reads: ((machines: unknown[]) => void)[] = [];
  const machinesTable = { listMachines: () => new Promise((resolve) => reads.push(resolve)) } as unknown as MachinesTable;
  const connections = createConnections(machinesTable, quietLog);
  const handlers = connections.websocketHandlers as unknown as Record<string, (...a: unknown[]) => unknown>;
  const page = fakeSocket({ role: "page", personId: "joe", displayName: "joe", expiresAtMs: Date.now() + 60_000, checkedAtMs: Date.now() });
  handlers.open?.(page);
  await Bun.sleep(10);
  reads.shift()?.([]);
  await Bun.sleep(10);
  const listsBefore = machineListsIn(page.sent).length;
  const older = connections.sendMachineListToPages("joe");
  const newer = connections.sendMachineListToPages("joe");
  const [olderRead, newerRead] = reads;
  newerRead([{ machineId: "m1", machineName: "renamed", ownerPersonId: "joe" }]);
  await newer;
  olderRead([{ machineId: "m1", machineName: "old name", ownerPersonId: "joe" }]);
  await older;
  const lists = machineListsIn(page.sent).slice(listsBefore).map((text) => JSON.parse(text).machines.map((m: { machineName: string }) => m.machineName));
  expect(lists).toEqual([["renamed"]]);
});
