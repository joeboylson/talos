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
const SPARK_FOLDERS = [{ folderName: "talos", path: "/home/joe/talos" }];

test("a person sees only their own machines, sorted, with connections and folders, and no key hashes", () => {
  const foldersByMachineId = new Map([["2", SPARK_FOLDERS], ["3", []]]);
  expect(buildMachineSummaries(MACHINES, foldersByMachineId, "joe")).toEqual([
    { machineId: "1", machineName: "atlas", isConnected: false, folders: null },
    { machineId: "2", machineName: "spark", isConnected: true, folders: SPARK_FOLDERS },
  ]);
});

test("another person sees none of Joe's machines", () => {
  const foldersByMachineId = new Map([["1", []], ["2", []], ["3", []]]);
  expect(buildMachineSummaries(MACHINES, foldersByMachineId, "sam")).toEqual([
    { machineId: "3", machineName: "laptop", isConnected: true, folders: [] },
  ]);
});

test("someone with no machines sees an empty list", () => {
  expect(buildMachineSummaries(MACHINES, new Map(), "new-person")).toEqual([]);
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
