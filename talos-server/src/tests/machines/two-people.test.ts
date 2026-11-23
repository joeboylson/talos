import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { LIMITS } from "talos-shared";
import { CLOSE_CODES, NO_MACHINES_MESSAGE } from "../../constants";
import { createConnections, type SocketData } from "../../connections";
import { SERVER_LIMITS } from "../../limits";
import type { MachinesTable } from "../../machines-table";
import { fakeSocket, machineData, pageData, parsedMessages, quietLog } from "../helpers/fakes";

// Joe's machine is connected; Joe and Eve each have a page open.
const JOE_MACHINE = "joe-mac";
const NO_COALESCE_MS = 0;
const machinesTable = {
  listMachines: async () => [{ machineId: JOE_MACHINE, machineName: JOE_MACHINE, ownerPersonId: "joe", keyHash: "h", pairedAtMs: 0 }],
} as unknown as MachinesTable;

type Socket = ReturnType<typeof fakeSocket>;

const setUp = async () => {
  const connections = createConnections(machinesTable, quietLog, NO_COALESCE_MS);
  const handlers = connections.websocketHandlers as unknown as Record<string, (...args: unknown[]) => void>;
  const send = (socket: Socket, message: unknown) => handlers.message?.(socket, JSON.stringify(message));
  const open = async (data: SocketData) => {
    const socket = fakeSocket(data);
    handlers.open?.(socket);
    await Bun.sleep(0);
    return socket;
  };
  const machine = await open(machineData(JOE_MACHINE, "joe"));
  send(machine, { type: "folders", folders: [{ folderName: "talos", path: "/home/joe/talos" }] });
  send(machine, { type: "sessions", sessions: [{ sessionName: "fix", folderName: "talos", state: "idle" }] });
  const joePage = await open(pageData("joe"));
  const evePage = await open(pageData("eve"));
  return { connections, handlers, send, open, machine, joePage, evePage };
};

const entryFor = (sessionName: string) => ({ type: "session-entries", sessionName, entries: [{ kind: "text", position: 0, entryId: "e1", text: "secret" }] });
const lastError = (socket: Socket) => parsedMessages(socket.record.sent).filter((message) => message.type === "error").at(-1)?.message;
const mentionsJoesMachine = (socket: Socket) =>
  parsedMessages(socket.record.sent).some((message) => message.machineId === JOE_MACHINE || String(message.message ?? "").startsWith(`${JOE_MACHINE}:`));

afterEach(() => setSystemTime());

describe("another person's page", () => {
  test.each([
    { type: "start-session", machineId: JOE_MACHINE, folderName: "talos" },
    { type: "stop-session", machineId: JOE_MACHINE, sessionName: "fix" },
    { type: "send-to-session", machineId: JOE_MACHINE, sessionName: "fix", text: "hi" },
    { type: "ask-for-output", machineId: JOE_MACHINE, sessionName: "fix", kind: "summary" },
    { type: "answer-output", machineId: JOE_MACHINE, sessionName: "fix", outputId: "o1", choice: 0 },
  ])("can't $type on Joe's machine", async (command) => {
    const { send, machine, evePage } = await setUp();
    const machineSentBefore = machine.record.sent.length;
    send(evePage, command);
    expect(machine.record.sent.length).toBe(machineSentBefore);
    expect(lastError(evePage)).toBe("That machine isn't connected");
  });

  test.each([{ type: "ping", machineId: JOE_MACHINE }, { type: "ping" }])("can't ping Joe's machine (%p)", async (ping) => {
    const { send, machine, evePage } = await setUp();
    const machineSentBefore = machine.record.sent.length;
    send(evePage, ping);
    expect(machine.record.sent.length).toBe(machineSentBefore);
    expect(lastError(evePage)).toBe(NO_MACHINES_MESSAGE);
  });

  test("gets none of Joe's entries, errors or pongs", async () => {
    const { send, machine, joePage, evePage } = await setUp();
    send(joePage, { type: "ping", machineId: JOE_MACHINE });
    const ping = parsedMessages(machine.record.sent).find((message) => message.type === "ping");
    send(machine, { type: "pong", id: ping?.id });
    send(machine, entryFor("fix"));
    send(machine, { type: "error", message: "That question has closed" });
    expect(mentionsJoesMachine(evePage)).toBe(false);
    expect(parsedMessages(joePage.record.sent).map((message) => message.type)).toEqual(expect.arrayContaining(["pong", "session-entries", "error"]));
  });

  test("opening a page gets only that person's kept entries", async () => {
    const { send, open, machine } = await setUp();
    send(machine, entryFor("fix"));
    const lateEvePage = await open(pageData("eve"));
    const lateJoePage = await open(pageData("joe"));
    expect(mentionsJoesMachine(lateEvePage)).toBe(false);
    expect(parsedMessages(lateJoePage.record.sent).some((message) => message.type === "session-entries")).toBe(true);
  });

  test("signing out closes only that person's pages", async () => {
    const { connections, joePage, evePage } = await setUp();
    connections.disconnectPersonPages("joe");
    expect(joePage.record.closedWith).toBe(CLOSE_CODES.signedOut);
    expect(evePage.record.closedWith).toBeNull();
  });

  test("a page whose sign-in check began before a sign-out is closed too, and gets nothing", async () => {
    const { connections, open, send, machine } = await setUp();
    const checkedBefore = { ...pageData("joe"), checkedAtMs: Date.now() - 1000 } as SocketData;
    connections.disconnectPersonPages("joe");
    const latePage = await open(checkedBefore);
    send(machine, entryFor("fix"));
    expect(latePage.record.closedWith).toBe(CLOSE_CODES.signedOut);
    expect(latePage.record.sent).toEqual([]);
    const afterSignIn = await open({ ...pageData("joe"), checkedAtMs: Date.now() + 1 } as SocketData);
    expect(afterSignIn.record.closedWith).toBeNull();
  });
});

describe("commands from the owner", () => {
  test("starting a session needs a folder the machine reported", async () => {
    const { send, machine, joePage } = await setUp();
    const sentBefore = machine.record.sent.length;
    send(joePage, { type: "start-session", machineId: JOE_MACHINE, folderName: "elsewhere" });
    expect(machine.record.sent.length).toBe(sentBefore);
    expect(lastError(joePage)).toBe("That folder isn't on that machine");
    send(joePage, { type: "start-session", machineId: JOE_MACHINE, folderName: "talos" });
    expect(parsedMessages(machine.record.sent).at(-1)).toEqual({ type: "start-session", folderName: "talos", sessionName: "talos" });
  });

  test("asking for an output needs a running session", async () => {
    const { send, machine, joePage } = await setUp();
    const sentBefore = machine.record.sent.length;
    send(joePage, { type: "ask-for-output", machineId: JOE_MACHINE, sessionName: "made-up", kind: "summary" });
    expect(machine.record.sent.length).toBe(sentBefore);
    send(joePage, { type: "ask-for-output", machineId: JOE_MACHINE, sessionName: "fix", kind: "summary" });
    expect(parsedMessages(machine.record.sent).at(-1)).toEqual({ type: "ask-for-output", sessionName: "fix", kind: "summary" });
  });

  test("text alone is sent; a message with no text and no images isn't", async () => {
    const { send, machine, joePage } = await setUp();
    send(joePage, { type: "send-to-session", machineId: JOE_MACHINE, sessionName: "fix", text: " hi " });
    expect(parsedMessages(machine.record.sent).at(-1)).toEqual({ type: "send-to-session", sessionName: "fix", text: "hi", images: [] });
    const sentBefore = machine.record.sent.length;
    send(joePage, { type: "send-to-session", machineId: JOE_MACHINE, sessionName: "fix", text: "   " });
    expect(machine.record.sent.length).toBe(sentBefore);
    expect(lastError(joePage)).toBe("That message can't be sent");
  });
});

describe("machine bookkeeping", () => {
  test("a session that's gone takes its kept entries with it", async () => {
    const { send, open, machine } = await setUp();
    send(machine, entryFor("fix"));
    send(machine, { type: "sessions", sessions: [] });
    send(machine, { type: "sessions", sessions: [{ sessionName: "fix", folderName: "talos", state: "idle" }] });
    const latePage = await open(pageData("joe"));
    expect(parsedMessages(latePage.record.sent).some((message) => message.type === "session-entries")).toBe(false);
  });

  test("a second ping while one is unanswered isn't sent, and a pong with the wrong id is ignored", async () => {
    const { send, machine, joePage } = await setUp();
    send(joePage, { type: "ping", machineId: JOE_MACHINE });
    send(joePage, { type: "ping", machineId: JOE_MACHINE });
    const pings = parsedMessages(machine.record.sent).filter((message) => message.type === "ping");
    expect(pings.length).toBe(1);
    const pongsTo = () => parsedMessages(joePage.record.sent).filter((message) => message.type === "pong").length;
    send(machine, { type: "pong", id: "wrong-id" });
    expect(pongsTo()).toBe(0);
    send(machine, { type: "pong", id: pings[0]?.id });
    expect(pongsTo()).toBe(1);
  });

  test("a reconnect closes the old connection, and the old one closing late leaves the new one", async () => {
    const { handlers, send, open, machine, joePage } = await setUp();
    const newer = await open(machineData(JOE_MACHINE, "joe"));
    expect(machine.record.closedWith).toBe(CLOSE_CODES.machineReplaced);
    handlers.close?.(machine);
    await Bun.sleep(0);
    send(newer, { type: "sessions", sessions: [{ sessionName: "fix", folderName: "talos", state: "idle" }] });
    send(joePage, { type: "stop-session", machineId: JOE_MACHINE, sessionName: "fix" });
    expect(parsedMessages(newer.record.sent).at(-1)).toEqual({ type: "stop-session", sessionName: "fix" });
  });

  test("a socket whose handling throws doesn't take the server down", async () => {
    const { handlers } = await setUp();
    const brokenPage = { ...fakeSocket(pageData("joe")), send: () => { throw new Error("socket gone"); } };
    expect(() => handlers.message?.(brokenPage, "not json")).not.toThrow();
  });
});

describe("per-socket budgets", () => {
  // Each frame the server parses here isn't JSON, so it answers each with one error.
  const repliesFrom = (socket: Socket) => socket.record.sent.filter((text) => JSON.parse(text).type === "error").length;
  // A frame of this many bytes, without building it.
  const frameOf = (size: number) => ({ length: size, toString: () => "not json" });

  test("past the message count in one window, messages are dropped", async () => {
    const { handlers, joePage, evePage } = await setUp();
    setSystemTime(new Date(Date.now()));
    Array.from({ length: SERVER_LIMITS.maxSocketMessagesPerWindow + 1 }).forEach(() => handlers.message?.(joePage, "not json"));
    expect(repliesFrom(joePage)).toBe(SERVER_LIMITS.maxSocketMessagesPerWindow);
    handlers.message?.(evePage, "not json");
    expect(repliesFrom(evePage)).toBe(1);
  });

  test("past the byte budget in one window, frames are dropped", async () => {
    const { handlers, joePage, evePage } = await setUp();
    setSystemTime(new Date(Date.now()));
    const overHalf = LIMITS.maxSocketIngressBytes / 2 + 1;
    handlers.message?.(joePage, frameOf(overHalf));
    handlers.message?.(joePage, frameOf(overHalf));
    expect(repliesFrom(joePage)).toBe(1);
    handlers.message?.(evePage, frameOf(overHalf));
    expect(repliesFrom(evePage)).toBe(1);
  });

  test("the budget counts bytes, not characters", async () => {
    const { handlers, joePage } = await setUp();
    const threeByteCharacter = "€";
    const overBudgetInBytes = threeByteCharacter.repeat(Math.floor(LIMITS.maxSocketIngressBytes / 3) + 1);
    handlers.message?.(joePage, overBudgetInBytes);
    expect(repliesFrom(joePage)).toBe(0);
  });
});

describe("a refusal goes back to the page that asked", () => {
  test("only that page sees it, under its own id, and the machine never sees the page's id", async () => {
    const { open, send, machine } = await setUp();
    const laptop = await open(pageData("joe"));
    const phone = await open(pageData("joe"));
    send(laptop, { type: "answer-output", machineId: JOE_MACHINE, sessionName: "fix", outputId: "o1", choice: 0, requestId: "laptop-1" });
    const forwarded = parsedMessages(machine.record.sent).find((message) => message.type === "answer-output");
    expect(forwarded?.requestId).toBeString();
    expect(forwarded?.requestId).not.toBe("laptop-1");
    send(machine, { type: "error", message: "That question has closed", requestId: forwarded?.requestId });
    expect(parsedMessages(laptop.record.sent).filter((message) => message.type === "error")).toEqual([{ type: "error", message: `${JOE_MACHINE}: That question has closed`, requestId: "laptop-1" }]);
    expect(lastError(phone)).toBeUndefined();
  });
  test("another person's flood of requests can't push out this page's", async () => {
    const { open, send, machine } = await setUp();
    const laptop = await open(pageData("joe"));
    const stranger = await open(pageData("sam"));
    send(laptop, { type: "answer-output", machineId: JOE_MACHINE, sessionName: "fix", outputId: "o1", choice: 0, requestId: "laptop-1" });
    const forwarded = parsedMessages(machine.record.sent).find((message) => message.type === "answer-output");
    for (let at = 0; at < 1500; at += 1) send(stranger, { type: "stop-session", machineId: "nowhere", sessionName: "x", requestId: `flood-${at}` });
    send(machine, { type: "error", message: "That question has closed", requestId: forwarded?.requestId });
    expect(parsedMessages(laptop.record.sent).filter((message) => message.type === "error")).toEqual([{ type: "error", message: `${JOE_MACHINE}: That question has closed`, requestId: "laptop-1" }]);
  });
  test("an error that names no request goes to all the owner's pages", async () => {
    const { open, send, machine } = await setUp();
    const laptop = await open(pageData("joe"));
    const phone = await open(pageData("joe"));
    send(machine, { type: "error", message: "The session runner stopped" });
    expect([lastError(laptop), lastError(phone)]).toEqual([`${JOE_MACHINE}: The session runner stopped`, `${JOE_MACHINE}: The session runner stopped`]);
  });
});
