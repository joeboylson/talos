import { expect, test } from "bun:test";
import { pickCredentials } from "../../credentials";

const SERVER_URL = "ws://localhost:7070";

test("returns what was saved for this server", () => {
  expect(pickCredentials({ serverUrl: SERVER_URL, machineKey: "id.secret", machineName: "work-mac" }, SERVER_URL)).toEqual({
    serverUrl: SERVER_URL,
    machineKey: "id.secret",
    machineName: "work-mac",
  });
});

test("a file from before machine names has no name yet", () => {
  expect(pickCredentials({ serverUrl: SERVER_URL, machineKey: "id.secret" }, SERVER_URL)?.machineName).toBeNull();
});

test.each([
  ["nothing saved", null],
  ["not an object", "id.secret"],
  ["a key for another server", { serverUrl: "wss://other.example.com", machineKey: "id.secret" }],
  ["no key", { serverUrl: SERVER_URL }],
  ["a key that isn't text", { serverUrl: SERVER_URL, machineKey: 42 }],
])("returns null for %s", (_label, savedValue) => {
  expect(pickCredentials(savedValue, SERVER_URL)).toBeNull();
});
