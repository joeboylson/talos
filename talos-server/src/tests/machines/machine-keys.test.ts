import { describe, expect, test } from "bun:test";
import { chooseMachineName } from "../../machine-routes";
import { createMachineKey, formatMachineKey, parseMachineKey } from "../../machine-keys";

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

describe("chooseMachineName", () => {
  const machine = (machineId: string, machineName: string) => ({ machineId, machineName, ownerPersonId: "joe", keyHash: "h", pairedAtMs: 0 });
  const MACHINES = [machine("1", "work-mac"), machine("2", "spark")];

  test("cleans up the typed name", () => {
    expect(chooseMachineName("Joe's Laptop", MACHINES, "1")).toBe("joes-laptop");
  });

  test("keeping its own name is fine", () => {
    expect(chooseMachineName("work-mac", MACHINES, "1")).toBe("work-mac");
  });

  test("another machine's name gets -2", () => {
    expect(chooseMachineName("spark", MACHINES, "1")).toBe("spark-2");
  });
});
