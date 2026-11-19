import { expect, test } from "bun:test";
import type { Logger } from "talos-shared";
import { createConnections, type SocketData } from "../../connections";
import type { MachinesTable } from "../../machines-table";

const quietLog: Logger = { event: () => {}, detail: () => {}, warn: () => {} };
const fakeSocket = (data: SocketData) => ({ data, sent: [] as string[], send: (t: string) => {}, close: () => {} });

// A flood of session updates from one machine must not scan the shared machines
// table once per message — they coalesce into a handful of scans per window.
test("a burst of machine session updates is coalesced into few table scans", async () => {
  let scans = 0;
  const machinesTable = { listMachines: async () => (scans++, []) } as unknown as MachinesTable;
  const connections = createConnections(machinesTable, quietLog);
  const handlers = connections.websocketHandlers as unknown as Record<string, (...a: unknown[]) => unknown>;
  const machine = fakeSocket({ role: "machine", machineId: "m1", machineName: "atlas", ownerPersonId: "joe" });
  const page = fakeSocket({ role: "page", personId: "joe", displayName: "joe", expiresAtMs: Date.now() + 60_000 });
  handlers.open?.(machine);
  handlers.open?.(page);
  await Bun.sleep(30);
  const scansBefore = scans;
  for (let i = 0; i < 100; i += 1) handlers.message?.(machine, JSON.stringify({ type: "sessions", sessions: [] }));
  await Bun.sleep(250);
  expect(scans - scansBefore).toBeLessThanOrEqual(3);
});
