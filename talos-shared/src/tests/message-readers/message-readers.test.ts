import { describe, expect, test } from "bun:test";
import { isIdentifierName } from "../../identifiers";
import { isSafeServerUrl } from "../../server-url";
import { readMachineToServer, readPageToServer, readServerToMachine } from "../../message-readers";
import { LIMITS } from "../../limits";

test.each([
  ["fix-login", true],
  ["../..", false],
  ["Fix Login", false],
  ["", false],
  [5, false],
])("isIdentifierName %p", (value, expected) => {
  expect(isIdentifierName(value)).toBe(expected);
});

describe("readPageToServer", () => {
  test.each([
    [{ type: "ping" }],
    [{ type: "ping", machineId: "m1" }],
    [{ type: "start-session", machineId: "m1", folderName: "talos" }],
    [{ type: "start-session", machineId: "m1", folderName: "talos", sessionName: "Fix the Login" }],
    [{ type: "send-to-session", machineId: "m1", sessionName: "fix", text: "hi", images: [] }],
    [{ type: "stop-session", machineId: "m1", sessionName: "fix" }],
    [{ type: "ask-for-update", machineId: "m1", sessionName: "fix" }],
    [{ type: "answer-output", machineId: "m1", sessionName: "fix", outputId: "o1", choice: 1 }],
  ])("keeps a good message %#", (message) => {
    expect(readPageToServer(message) as unknown).toEqual(message);
  });

  test("sending with no images is an empty list", () => {
    expect(readPageToServer({ type: "send-to-session", machineId: "m1", sessionName: "fix", text: "hi" })).toEqual({
      type: "send-to-session",
      machineId: "m1",
      sessionName: "fix",
      text: "hi",
      images: [],
    });
  });

  test.each([
    ["a number as the session name (it crashed the server)", { type: "start-session", machineId: "m1", folderName: "talos", sessionName: 5 }],
    ["a path as the session name", { type: "stop-session", machineId: "m1", sessionName: "../.." }],
    ["a path as the folder name", { type: "start-session", machineId: "m1", folderName: "../x" }],
    ["no machine", { type: "stop-session", sessionName: "fix" }],
    ["text that isn't text", { type: "send-to-session", machineId: "m1", sessionName: "fix", text: { a: 1 } }],
    ["text too long", { type: "send-to-session", machineId: "m1", sessionName: "fix", text: "x".repeat(LIMITS.maxSentTextLength + 1) }],
    ["bad images", { type: "send-to-session", machineId: "m1", sessionName: "fix", text: "", images: [{ mediaType: "text/html", dataBase64: "" }] }],
    ["an answer with no output id", { type: "answer-output", machineId: "m1", sessionName: "fix", choice: 0 }],
    ["an answer picking a choice that can't exist", { type: "answer-output", machineId: "m1", sessionName: "fix", outputId: "o1", choice: LIMITS.maxDecisionChoices }],
    ["an answer whose choice isn't a whole number", { type: "answer-output", machineId: "m1", sessionName: "fix", outputId: "o1", choice: 0.5 }],
    ["an unknown type", { type: "delete-everything", machineId: "m1" }],
    ["not an object", "ping"],
  ])("drops %s", (_name, message) => {
    expect(readPageToServer(message)).toBeNull();
  });
});

describe("readServerToMachine", () => {
  test.each([
    [{ type: "ping", id: "p1" }],
    [{ type: "machine-name", machineName: "atlas" }],
    [{ type: "rename-folder", folderName: "talos", newFolderName: "Talos Two" }],
    [{ type: "start-session", folderName: "talos", sessionName: "fix" }],
    [{ type: "send-to-session", sessionName: "fix", text: "hi", images: [] }],
    [{ type: "stop-session", sessionName: "fix" }],
    [{ type: "ask-for-update", sessionName: "fix" }],
    [{ type: "answer-output", sessionName: "fix", outputId: "o1", choice: 0 }],
  ])("keeps a good message %#", (message) => {
    expect(readServerToMachine(message) as unknown).toEqual(message);
  });

  test.each([
    ["a path as the session name (it could delete the home folder)", { type: "start-session", folderName: "talos", sessionName: "../.." }],
    ["a path as the folder name", { type: "rename-folder", folderName: "../..", newFolderName: "x" }],
    ["a machine name with odd characters", { type: "machine-name", machineName: "atlas/../x" }],
    ["an unknown type", { type: "run-command", command: "rm -rf ~" }],
  ])("drops %s", (_name, message) => {
    expect(readServerToMachine(message)).toBeNull();
  });
});

describe("readMachineToServer", () => {
  test("keeps entries for a plainly named session", () => {
    const message = { type: "session-entries", sessionName: "fix", entries: [{ kind: "text", entryId: "a", text: "hi" }] };
    expect(readMachineToServer(message) as unknown).toEqual(message);
  });
  test("leaves an oddly named session out of a session list", () => {
    expect(readMachineToServer({ type: "sessions", sessions: [{ sessionName: "a b", folderName: "talos", state: "idle" }] }) as unknown).toEqual({ type: "sessions", sessions: [] });
  });
  test("keeps a short error", () => {
    expect(readMachineToServer({ type: "error", message: "That question has closed" }) as unknown).toEqual({ type: "error", message: "That question has closed" });
  });

  test.each([
    ["entries for an oddly named session", { type: "session-entries", sessionName: "../x", entries: [] }],
    ["a folder with an odd name", { type: "folders", folders: [{ folderName: "../x", path: "/tmp" }] }],
    ["a pong with no id", { type: "pong" }],
    ["an error too long to show", { type: "error", message: "x".repeat(LIMITS.maxMachineErrorLength + 1) }],
  ])("drops %s", (_name, message) => {
    expect(readMachineToServer(message)).toBeNull();
  });
});

test.each([
  ["wss://talos.example.com", true],
  ["ws://localhost:7070", true],
  ["ws://127.0.0.1:7070", true],
  ["ws://talos.example.com", false],
  ["http://talos.example.com", false],
  ["not a url", false],
])("isSafeServerUrl %p", (serverUrl, expected) => {
  expect(isSafeServerUrl(serverUrl)).toBe(expected);
});
