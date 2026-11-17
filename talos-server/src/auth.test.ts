import { expect, test } from "bun:test";
import { isMachineKeyValid } from "./auth";

const MACHINE_KEY = "secret-key";

test("accepts the right key", () => {
  expect(isMachineKeyValid(`Bearer ${MACHINE_KEY}`, MACHINE_KEY)).toBe(true);
});

test.each([
  ["no header", null],
  ["empty header", ""],
  ["wrong key", "Bearer wrong-key!"],
  ["key with no Bearer prefix", MACHINE_KEY],
  ["lowercase prefix", `bearer ${MACHINE_KEY}`],
  ["key with extra text", `Bearer ${MACHINE_KEY}x`],
  ["empty key", "Bearer "],
])("rejects %s", (_label, authorizationHeader) => {
  expect(isMachineKeyValid(authorizationHeader, MACHINE_KEY)).toBe(false);
});

test("rejects everything when the expected key is empty", () => {
  expect(isMachineKeyValid("Bearer ", "")).toBe(false);
});
