import { expect, test } from "bun:test";
import fc from "fast-check";
import { quietLog } from "../helpers/fakes";
import { createConnections, type SocketData } from "../../connections";
import type { MachineRecord, MachinesTable } from "../../machines-table";

// Rule: whatever machines and owners exist, and whatever any page or machine
// sends, a person's pages only ever get their own machines' data, and a
// machine only ever gets commands from its owner's pages, for folders and
// running sessions it reported.

const PEOPLE = ["p0", "p1", "p2"];
const MACHINE_COUNT = 5;
const FOLDERS = ["f0", "f1"];
const SESSIONS = ["s0", "s1", "s2"];
const COMMAND_TYPES = ["start-session", "stop-session", "send-to-session", "ask-for-output", "answer-output"] as const;

// No coalescing wait, so each step settles in one tick.
const RELAY_COALESCE_MS = 0;

const settle = () => new Promise((resolve) => setImmediate(resolve));
const settleTimers = () => new Promise((resolve) => setTimeout(resolve, 0));

type FakeSocket = { data: SocketData; sent: string[]; isClosed: boolean; send: (t: string) => void; close: () => void; ping: () => void };

const pick = (n: number) => fc.nat({ max: n - 1 });
const weighted = <T,>(weight: number, arbitrary: fc.Arbitrary<T>) => ({ weight, arbitrary });
const action = fc.oneof(
  weighted(3, fc.record({ kind: fc.constant("open-machine" as const), machine: pick(MACHINE_COUNT) })),
  weighted(1, fc.record({ kind: fc.constant("close-machine" as const), machine: pick(MACHINE_COUNT) })),
  weighted(3, fc.record({ kind: fc.constant("open-page" as const), person: pick(PEOPLE.length) })),
  weighted(1, fc.record({ kind: fc.constant("close-page" as const), page: fc.nat() })),
  weighted(1, fc.record({ kind: fc.constant("sign-out" as const), person: pick(PEOPLE.length) })),
  weighted(
    4,
    fc.record({
      kind: fc.constant("report" as const),
      machine: pick(MACHINE_COUNT),
      folders: fc.subarray(FOLDERS),
      sessions: fc.subarray(SESSIONS),
    }),
  ),
  weighted(2, fc.record({ kind: fc.constant("entries" as const), machine: pick(MACHINE_COUNT), session: fc.constantFrom(...SESSIONS) })),
  weighted(1, fc.record({ kind: fc.constant("machine-error" as const), machine: pick(MACHINE_COUNT) })),
  weighted(1, fc.record({ kind: fc.constant("pong" as const), machine: pick(MACHINE_COUNT) })),
  weighted(2, fc.record({ kind: fc.constant("ping" as const), page: fc.nat(), machine: fc.option(pick(MACHINE_COUNT + 1)) })),
  weighted(
    6,
    fc.record({
      kind: fc.constant("command" as const),
      page: fc.nat(),
      machine: pick(MACHINE_COUNT + 1),
      type: fc.constantFrom(...COMMAND_TYPES),
      folder: fc.constantFrom(...FOLDERS),
      session: fc.constantFrom(...SESSIONS),
    }),
  ),
);

type Action = typeof action extends fc.Arbitrary<infer T> ? T : never;

const machineIdOf = (index: number) => `m${index}`;

const runScenario = async (owners: number[], actions: Action[]) => {
  const records: MachineRecord[] = owners.map((owner, index) => ({
    machineId: machineIdOf(index),
    machineName: machineIdOf(index),
    ownerPersonId: PEOPLE[owner] ?? "p0",
    keyHash: "h",
    pairedAtMs: 0,
  }));
  const ownerOf = new Map(records.map((record) => [record.machineId, record.ownerPersonId]));
  const machinesTable = { listMachines: async () => records } as unknown as MachinesTable;
  const connections = createConnections(machinesTable, quietLog, RELAY_COALESCE_MS);
  const handlers = connections.websocketHandlers as unknown as Record<string, (...args: unknown[]) => void>;

  const fakeSocket = (data: SocketData): FakeSocket => {
    const socket: FakeSocket = {
      data,
      sent: [],
      isClosed: false,
      send: (text) => void (socket.isClosed || socket.sent.push(text)),
      // Bun calls the close handler later, not inside close().
      close: () => {
        if (socket.isClosed) return;
        socket.isClosed = true;
        queueMicrotask(() => handlers.close?.(socket));
      },
      ping: () => {},
    };
    return socket;
  };

  const machineSockets = new Map<string, FakeSocket>();
  const pages: FakeSocket[] = [];
  // What each machine last reported, so commands can be checked against it.
  const reported = new Map<string, { folders: string[]; sessions: string[] }>();
  const allMachineSockets: FakeSocket[] = [];

  const openPages = () => pages.filter((page) => !page.isClosed);
  const sendRaw = (socket: FakeSocket, message: unknown) => handlers.message?.(socket, JSON.stringify(message));

  for (const step of actions) {
    const before = new Map(allMachineSockets.map((socket) => [socket, socket.sent.length]));
    let commandFrom: string | null = null;
    let commandTo: string | null = null;

    if (step.kind === "open-machine") {
      const machineId = machineIdOf(step.machine);
      const socket = fakeSocket({ role: "machine", machineId, machineName: machineId, ownerPersonId: ownerOf.get(machineId) ?? "", checkedAtMs: 0 });
      machineSockets.set(machineId, socket);
      allMachineSockets.push(socket);
      reported.set(machineId, { folders: [], sessions: [] });
      handlers.open?.(socket);
    } else if (step.kind === "close-machine") {
      machineSockets.get(machineIdOf(step.machine))?.close();
    } else if (step.kind === "open-page") {
      const personId = PEOPLE[step.person] ?? "p0";
      const page = fakeSocket({ role: "page", personId, displayName: personId, expiresAtMs: Date.now() + 3_600_000, checkedAtMs: Date.now() });
      pages.push(page);
      handlers.open?.(page);
    } else if (step.kind === "sign-out") {
      const personId = PEOPLE[step.person] ?? "p0";
      const openBefore = openPages();
      connections.disconnectPersonPages(personId);
      // Signing out closes every page of that person, and no one else's.
      for (const page of openBefore) {
        if (page.data.role !== "page") continue;
        expect({ person: page.data.personId, closed: page.isClosed }).toEqual({ person: page.data.personId, closed: page.data.personId === personId });
      }
    } else if (step.kind === "close-page") {
      const page = openPages()[step.page % Math.max(1, openPages().length)];
      page?.close();
    } else {
      const machineId = "machine" in step && step.machine !== null ? machineIdOf(step.machine) : undefined;
      const machine = machineId ? machineSockets.get(machineId) : undefined;
      const liveMachine = machine && !machine.isClosed ? machine : undefined;

      if (step.kind === "report" && liveMachine && machineId) {
        sendRaw(liveMachine, { type: "folders", folders: step.folders.map((folderName) => ({ folderName, path: `/x/${folderName}` })) });
        sendRaw(liveMachine, { type: "sessions", sessions: step.sessions.map((sessionName) => ({ sessionName, folderName: "f0", state: "idle" })) });
        reported.set(machineId, { folders: step.folders, sessions: step.sessions });
      } else if (step.kind === "entries" && liveMachine) {
        sendRaw(liveMachine, { type: "session-entries", sessionName: step.session, entries: [{ kind: "text", position: 0, entryId: "e1", text: "secret" }] });
      } else if (step.kind === "machine-error" && liveMachine) {
        sendRaw(liveMachine, { type: "error", message: "something" });
      } else if (step.kind === "pong" && liveMachine) {
        const lastPing = [...liveMachine.sent].reverse().map((text) => JSON.parse(text)).find((message) => message.type === "ping");
        if (lastPing) sendRaw(liveMachine, { type: "pong", id: lastPing.id });
      } else if (step.kind === "ping" || step.kind === "command") {
        const page = openPages()[step.page % Math.max(1, openPages().length)];
        if (page && page.data.role === "page") {
          commandFrom = page.data.personId;
          commandTo = machineId ?? null;
          if (step.kind === "ping") {
            sendRaw(page, machineId ? { type: "ping", machineId } : { type: "ping" });
          } else {
            const target = machineId ?? "nobody";
            const base = { type: step.type, machineId: target };
            const byType = {
              "start-session": { ...base, folderName: step.folder },
              "stop-session": { ...base, sessionName: step.session },
              "send-to-session": { ...base, sessionName: step.session, text: "hello" },
              "ask-for-output": { ...base, sessionName: step.session, kind: "summary" },
              "answer-output": { ...base, sessionName: step.session, outputId: "o1", choice: 0 },
            };
            sendRaw(page, byType[step.type]);
          }
        }
      }
    }
    await settle();

    // Every machine got commands only from its owner, only for what it reported.
    for (const socket of allMachineSockets) {
      if (socket.data.role !== "machine") continue;
      const newMessages = socket.sent.slice(before.get(socket) ?? 0).map((text) => JSON.parse(text));
      for (const message of newMessages) {
        if (message.type === "machine-name" || message.type === "rename-folder") continue;
        expect({ to: socket.data.machineId, owner: socket.data.ownerPersonId, from: commandFrom }).toEqual({
          to: socket.data.machineId,
          owner: socket.data.ownerPersonId,
          from: socket.data.ownerPersonId,
        });
        if (message.type === "ping") continue;
        expect(commandTo).toBe(socket.data.machineId);
        const report = reported.get(socket.data.machineId);
        if (message.type === "start-session") expect(report?.folders).toContain(message.folderName);
        else expect(report?.sessions).toContain(message.sessionName);
      }
    }
  }

  await settleTimers();
  // Every message any page ever got names only its own person's machines.
  for (const page of pages) {
    if (page.data.role !== "page") continue;
    const personId = page.data.personId;
    for (const message of page.sent.map((text) => JSON.parse(text))) {
      if (message.type === "machines") {
        for (const summary of message.machines) expect({ machine: summary.machineId, owner: ownerOf.get(summary.machineId) }).toEqual({ machine: summary.machineId, owner: personId });
      } else if (message.type === "session-entries" || message.type === "pong") {
        expect({ machine: message.machineId, owner: ownerOf.get(message.machineId) }).toEqual({ machine: message.machineId, owner: personId });
      } else if (message.type === "error") {
        const machineName = /^(m\d+): /.exec(message.message)?.[1];
        if (machineName) expect({ machine: machineName, owner: ownerOf.get(machineName) }).toEqual({ machine: machineName, owner: personId });
      }
    }
  }
};

test("rule: a person only sees their own machines' data, and only commands their own machines", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(pick(PEOPLE.length), { minLength: MACHINE_COUNT, maxLength: MACHINE_COUNT }),
      fc.array(action, { minLength: 10, maxLength: 40, size: "max" }),
      runScenario,
    ),
    { seed: 20261120, numRuns: 500 },
  );
}, 60_000);
