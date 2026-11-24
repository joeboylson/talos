import { expect, test } from "bun:test";
import { LIMITS, type SessionEntry } from "talos-shared";
import { EMPTY_PAGE_STATE, addWaitingPrompt, applyServerMessage, droppedPreviewUrls, forgetReturned } from "../../page-state";
import { sessionKey } from "../../session-rows";

const KEY = sessionKey("m1", "web");
const OTHER_KEY = sessionKey("m1", "api");
const prompt = (entryId: string, text: string): SessionEntry => ({ kind: "prompt", position: 0, entryId, text, imageCount: 0 });
const textEntry = (entryId: string, text: string): SessionEntry => ({ kind: "text", position: 0, entryId, text });
const entriesFor = (sessionName: string, entries: SessionEntry[]) =>
  ({ type: "session-entries", machineId: "m1", sessionName, entries }) as const;

test("a saved prompt clears its waiting copy; other entries don't", () => {
  const waiting = addWaitingPrompt(addWaitingPrompt(EMPTY_PAGE_STATE, "m1", "web", "hi", []), "m1", "web", "hi", []);
  const afterText = applyServerMessage(waiting, entriesFor("web", [textEntry("t1", "hi")]));
  expect(afterText.waitingPromptsBySession[KEY]).toHaveLength(2);
  const afterPrompt = applyServerMessage(afterText, entriesFor("web", [prompt("p1", "hi")]));
  expect(afterPrompt.waitingPromptsBySession[KEY]).toEqual([{ text: "hi", imagePreviewUrls: [] }]);
});

test("new entries add to the kept ones, for that session only", () => {
  const first = applyServerMessage(EMPTY_PAGE_STATE, entriesFor("web", [textEntry("t1", "one")]));
  const second = applyServerMessage(first, entriesFor("web", [textEntry("t2", "two")]));
  const other = applyServerMessage(second, entriesFor("api", [textEntry("t3", "three")]));
  expect(other.entriesBySession[KEY]?.map(({ entryId }) => entryId)).toEqual(["t1", "t2"]);
  expect(other.entriesBySession[OTHER_KEY]?.map(({ entryId }) => entryId)).toEqual(["t3"]);
});

test("a server error becomes the notice", () => {
  expect(applyServerMessage(EMPTY_PAGE_STATE, { type: "error", message: "No such session" }).notice).toBe("No such session");
});

test("machines and ping replies are kept", () => {
  const withMachines = applyServerMessage(EMPTY_PAGE_STATE, { type: "machines", machines: [] });
  const withPong = applyServerMessage(withMachines, { type: "pong", machineId: "m1", machineName: "atlas", roundTripMs: 12 });
  expect(withPong.machines).toEqual([]);
  expect(withPong.roundTripMsByMachineId).toEqual({ m1: 12 });
});

test("entries sent again after a reconnect merge in, so the conversation never blanks", () => {
  const state = addWaitingPrompt(applyServerMessage(EMPTY_PAGE_STATE, entriesFor("web", [textEntry("t1", "one")])), "m1", "web", "hi", []);
  const sentAgain = applyServerMessage(state, entriesFor("web", [textEntry("t1", "one")]));
  expect(sentAgain.entriesBySession[KEY]).toEqual([textEntry("t1", "one")]);
  expect(sentAgain.waitingPromptsBySession[KEY]).toHaveLength(1);
});

test("a machine the server doesn't know about yet keeps the sessions and folders this page last had", () => {
  const sessions = [{ sessionName: "web", folderName: "talos", state: "idle" as const, asks: {}, openOutputs: [] }];
  const folders = [{ folderName: "talos", path: "/home/joe/talos" }];
  const known = applyServerMessage(EMPTY_PAGE_STATE, { type: "machines", machines: [{ machineId: "m1", machineName: "m1", isConnected: true, folders, sessions }] });
  const afterRestart = applyServerMessage(known, { type: "machines", machines: [{ machineId: "m1", machineName: "m1", isConnected: false, folders: null, sessions: null }] });
  expect(afterRestart.machines).toEqual([{ machineId: "m1", machineName: "m1", isConnected: false, folders, sessions }]);
});

test("a waiting message is kept without its outer spaces, with its previews", () => {
  const state = addWaitingPrompt(EMPTY_PAGE_STATE, "m1", "web", "  hi\n", ["blob:a"]);
  expect(state.waitingPromptsBySession[KEY]).toEqual([{ text: "hi", imagePreviewUrls: ["blob:a"] }]);
});

test("a session that's gone forgets its entries, so a new one under its name starts fresh; an offline machine's are kept", () => {
  const session = (sessionName: string) => ({ sessionName, folderName: "talos", state: "idle" as const, asks: {}, openOutputs: [] });
  const machine = (machineId: string, sessions: ReturnType<typeof session>[] | null) => ({ machineId, machineName: machineId, isConnected: sessions !== null, folders: null, sessions });
  const withEntries = [entriesFor("web", [textEntry("t1", "old")]), entriesFor("api", [textEntry("t2", "kept")]), { ...entriesFor("web", [textEntry("t3", "offline")]), machineId: "m2" }]
    .reduce(applyServerMessage, addWaitingPrompt(EMPTY_PAGE_STATE, "m1", "web", "hi", []));
  const afterStop = applyServerMessage(withEntries, { type: "machines", machines: [machine("m1", [session("api")]), machine("m2", null)] });
  expect(Object.keys(afterStop.entriesBySession).sort()).toEqual([OTHER_KEY, sessionKey("m2", "web")]);
  expect(afterStop.waitingPromptsBySession[KEY]).toBeUndefined();
});

test("a message longer than a saved prompt keeps still clears its waiting copy once it's saved", () => {
  const long = "x".repeat(LIMITS.maxEntryTextLength + 500);
  const waiting = addWaitingPrompt(EMPTY_PAGE_STATE, "m1", "web", long, []);
  const saved = applyServerMessage(waiting, entriesFor("web", [prompt("p1", long.slice(0, LIMITS.maxEntryTextLength))]));
  expect(saved.waitingPromptsBySession[KEY]).toEqual([]);
});

test("a waiting message's image previews are let go once it's saved or its session ends", () => {
  const waiting = addWaitingPrompt(addWaitingPrompt(EMPTY_PAGE_STATE, "m1", "web", "look", ["blob:1"]), "m1", "api", "see", ["blob:2"]);
  const saved = applyServerMessage(waiting, entriesFor("web", [{ kind: "prompt", position: 0, entryId: "p1", text: "look", imageCount: 1 }]));
  expect(droppedPreviewUrls(waiting, saved)).toEqual(["blob:1"]);
  const ended = applyServerMessage(saved, { type: "machines", machines: [{ machineId: "m1", machineName: "m1", isConnected: true, folders: [], sessions: [] }] });
  expect(droppedPreviewUrls(saved, ended)).toEqual(["blob:2"]);
});

test("a refused send's waiting copy goes, and only that one", () => {
  const waiting = addWaitingPrompt(addWaitingPrompt(EMPTY_PAGE_STATE, "m1", "web", "first", [], "r1"), "m1", "web", "second", [], "r2");
  const refused = applyServerMessage(waiting, { type: "error", message: "atlas: Claude is asking permission; answer it first", requestId: "r1" });
  expect(refused.waitingPromptsBySession[KEY]?.map(({ text }) => text)).toEqual(["second"]);
  expect(refused.notice).toContain("asking permission");
});

test("a returned message goes back for the session's message box with the images this page sent, and its waiting copy goes", () => {
  const image = { mediaType: "image/png" as const, dataBase64: "cG5n" };
  const waiting = addWaitingPrompt(EMPTY_PAGE_STATE, "m1", "web", "try this", ["blob:1"], "r1", [image]);
  const returned = { type: "message-returned", machineId: "m1", sessionName: "web" } as const;
  const once = applyServerMessage(waiting, { ...returned, text: "try this", requestId: "r1" });
  expect(once.waitingPromptsBySession[KEY]).toEqual([]);
  expect(once.returnedBySession[KEY]).toEqual({ text: "try this", images: [image] });
  const twice = applyServerMessage(once, { ...returned, text: "and this" });
  expect(twice.returnedBySession[KEY]).toEqual({ text: "try this\n\nand this", images: [image] });
  expect(forgetReturned(twice, KEY).returnedBySession).toEqual({});
});
