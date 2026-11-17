import { expect, test } from "bun:test";
import { createMachineKey, formatMachineKey, parseMachineKey } from "./machine-keys";

test("a formatted key parses back to itself", () => {
  const machineKey = createMachineKey();
  expect(parseMachineKey(`Bearer ${formatMachineKey(machineKey)}`)).toEqual(machineKey);
});

test("each new key is different", () => {
  const firstKey = createMachineKey();
  const secondKey = createMachineKey();
  expect(firstKey.machineId).not.toBe(secondKey.machineId);
  expect(firstKey.secret).not.toBe(secondKey.secret);
});

test.each([
  ["no header", null],
  ["empty header", ""],
  ["no Bearer prefix", "id.secret"],
  ["lowercase prefix", "bearer id.secret"],
  ["no secret", "Bearer id"],
  ["empty secret", "Bearer id."],
  ["empty id", "Bearer .secret"],
  ["too many parts", "Bearer id.secret.extra"],
])("rejects %s", (_label, authorizationHeader) => {
  expect(parseMachineKey(authorizationHeader)).toBeNull();
});
