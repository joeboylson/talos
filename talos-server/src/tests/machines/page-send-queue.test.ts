import { expect, test } from "bun:test";
import type { Logger } from "talos-shared";
import { CLOSE_CODES } from "../../constants";
import { createConnections, type SocketData } from "../../connections";
import { SERVER_LIMITS } from "../../limits";
import type { MachinesTable } from "../../machines-table";

// What goes to a backed-up page waits, in order, until it drains, and a page
// that never drains is closed before the wait grows past its cap.
const quietLog: Logger = { event: () => {}, detail: () => {}, warn: () => {} };
const machinesTable = { listMachines: async () => [{ machineId: "m1", machineName: "atlas", ownerPersonId: "joe" }] } as unknown as MachinesTable;

// A socket whose send answers as Bun's does: 1 sent, -1 sent but backed up, 0 dropped.
const scriptedSocket = (data: SocketData) => {
  const record = { sent: [] as string[], closedWith: null as number | null, answer: 1 };
  const send = (text: string) => {
    if (record.answer !== 0) record.sent.push(text);
    return record.answer;
  };
  return { data, record, send, ping: () => {}, close: (code: number) => void (record.closedWith = code) };
};

const setUp = async () => {
  const connections = createConnections(machinesTable, quietLog, 10);
  const handlers = connections.websocketHandlers as unknown as Record<string, (socket: unknown, message?: string) => void>;
  const machine = scriptedSocket({ role: "machine", machineId: "m1", machineName: "atlas", ownerPersonId: "joe", checkedAtMs: 0 });
  const page = scriptedSocket({ role: "page", personId: "joe", displayName: "joe", expiresAtMs: Date.now() + 60_000, checkedAtMs: Date.now() });
  handlers.open?.(machine);
  handlers.open?.(page);
  await Bun.sleep(50);
  handlers.message?.(machine, JSON.stringify({ type: "sessions", sessions: [{ sessionName: "s", folderName: "f", state: "idle" }] }));
  await Bun.sleep(150);
  const sendEntries = (entries: { entryId: string; text: string }[]) =>
    handlers.message?.(machine, JSON.stringify({ type: "session-entries", sessionName: "s", entries: entries.map((entry, position) => ({ kind: "text", position, ...entry })) }));
  const sendText = (entryId: string, text: string) => sendEntries([{ entryId, text }]);
  return { handlers, page, sendText, sendEntries };
};
const entryIdsSent = (sent: string[]) => sent.map((text) => JSON.parse(text)).filter((m) => m.type === "session-entries").map((m) => m.entries[0].entryId);

test("sends to a backed-up page wait and go out in order when it drains", async () => {
  const { handlers, page, sendText } = await setUp();
  page.record.answer = -1;
  sendText("e1", "one");
  page.record.answer = 0;
  sendText("e2", "two");
  sendText("e3", "three");
  expect(entryIdsSent(page.record.sent)).toEqual(["e1"]);
  page.record.answer = 1;
  handlers.drain?.(page);
  expect(entryIdsSent(page.record.sent)).toEqual(["e1", "e2", "e3"]);
});

test("a page that never drains is closed once what waits for it passes the cap", async () => {
  const { page, sendEntries } = await setUp();
  page.record.answer = 0;
  // Big batches, a few a second, to stay inside the machine's ingress budget.
  const batch = (at: number) => Array.from({ length: 400 }, (_, entry) => ({ entryId: `e${at}-${entry}`, text: "x".repeat(19_000) }));
  const batchBytes = 400 * 19_000;
  for (let at = 0; at * batchBytes <= SERVER_LIMITS.maxWaitingPageBytes && page.record.closedWith === null; at += 1) {
    sendEntries(batch(at));
    await Bun.sleep(300);
  }
  expect(page.record.closedWith).toBe(CLOSE_CODES.tooFarBehind);
}, 20_000);

test("a page closed while it opens is sent nothing after, so nothing waits for it", async () => {
  let release = () => {};
  let isHeld = false;
  // The reads while the machine reports fail, so no machine list is kept.
  const table = {
    listMachines: () =>
      isHeld ? new Promise((resolve) => (release = () => resolve([{ machineId: "m1", machineName: "atlas", ownerPersonId: "joe" }]))) : Promise.reject(new Error("throttled")),
  } as unknown as MachinesTable;
  const connections = createConnections(table, quietLog, 10);
  const handlers = connections.websocketHandlers as unknown as Record<string, (socket: unknown, message?: string) => void>;
  const machine = scriptedSocket({ role: "machine", machineId: "m1", machineName: "atlas", ownerPersonId: "joe", checkedAtMs: 0 });
  handlers.open?.(machine);
  await Bun.sleep(50);
  handlers.message?.(machine, JSON.stringify({ type: "sessions", sessions: [{ sessionName: "s", folderName: "f", state: "idle" }] }));
  handlers.message?.(machine, JSON.stringify({ type: "session-entries", sessionName: "s", entries: [{ kind: "text", entryId: "e1", position: 0, text: "kept" }] }));
  await Bun.sleep(150);
  // With no machine list kept, this page reads the table.
  isHeld = true;
  const page = scriptedSocket({ role: "page", personId: "joe", displayName: "joe", expiresAtMs: Date.now() + 60_000, checkedAtMs: Date.now() });
  handlers.open?.(page);
  await Bun.sleep(10);
  handlers.close?.(page);
  const sentBeforeClose = page.record.sent.map((text) => JSON.parse(text).type);
  release();
  await Bun.sleep(50);
  expect(page.record.sent.map((text) => JSON.parse(text).type)).toEqual(sentBeforeClose);
});
