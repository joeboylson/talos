import { describe, expect, test } from "bun:test";
import { buildMachineSummaries, chooseMachinesToPing } from "../../connections";

const machine = (machineId: string, machineName: string, ownerPersonId: string) => ({
  machineId,
  machineName,
  ownerPersonId,
  keyHash: "hash",
  pairedAtMs: 0,
});

const MACHINES = [machine("2", "spark", "joe"), machine("1", "atlas", "joe"), machine("3", "laptop", "sam")];

test("a person sees only their own machines, sorted, with connections marked and no key hashes", () => {
  expect(buildMachineSummaries(MACHINES, new Set(["2", "3"]), "joe")).toEqual([
    { machineId: "1", machineName: "atlas", isConnected: false },
    { machineId: "2", machineName: "spark", isConnected: true },
  ]);
});

test("another person sees none of Joe's machines", () => {
  expect(buildMachineSummaries(MACHINES, new Set(["1", "2", "3"]), "sam")).toEqual([
    { machineId: "3", machineName: "laptop", isConnected: true },
  ]);
});

test("someone with no machines sees an empty list", () => {
  expect(buildMachineSummaries(MACHINES, new Set(), "new-person")).toEqual([]);
});

describe("chooseMachinesToPing", () => {
  test("no machine asked for pings all connected machines", () => {
    expect(chooseMachinesToPing(["1", "2"])).toEqual(["1", "2"]);
  });

  test("one machine asked for pings only that one", () => {
    expect(chooseMachinesToPing(["1", "2"], "2")).toEqual(["2"]);
  });

  test("a machine that isn't connected, or isn't theirs, gets no ping", () => {
    expect(chooseMachinesToPing(["1", "2"], "someone-elses")).toEqual([]);
  });

  test("nothing connected means nothing to ping", () => {
    expect(chooseMachinesToPing([])).toEqual([]);
    expect(chooseMachinesToPing([], "1")).toEqual([]);
  });
});
