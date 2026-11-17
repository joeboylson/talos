import { expect, test } from "bun:test";
import { pickMachineKey } from "./credentials";

const SERVER_URL = "ws://localhost:7070";

test("returns the key saved for this server", () => {
  expect(pickMachineKey({ serverUrl: SERVER_URL, machineKey: "id.secret" }, SERVER_URL)).toBe("id.secret");
});

test.each([
  ["nothing saved", null],
  ["not an object", "id.secret"],
  ["a key for another server", { serverUrl: "wss://other.example.com", machineKey: "id.secret" }],
  ["no key", { serverUrl: SERVER_URL }],
  ["a key that isn't text", { serverUrl: SERVER_URL, machineKey: 42 }],
])("returns null for %s", (_label, savedValue) => {
  expect(pickMachineKey(savedValue, SERVER_URL)).toBeNull();
});
