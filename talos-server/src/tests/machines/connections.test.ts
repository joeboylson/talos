import { describe, expect, test } from "bun:test";
import { buildMachineSummaries, chooseMachinesToPing, chooseSessionName, type MachineReport } from "../../connections";

const machine = (machineId: string, machineName: string, ownerPersonId: string) => ({
  machineId,
  machineName,
  ownerPersonId,
  keyHash: "hash",
  pairedAtMs: 0,
});

const MACHINES = [machine("2", "spark", "joe"), machine("1", "atlas", "joe"), machine("3", "laptop", "sam")];
const SPARK_REPORT: MachineReport = {
  folders: [{ folderName: "talos", path: "/home/joe/talos" }],
  sessions: [{ sessionName: "fix-login", folderName: "talos", state: "idle", asks: {}, openOutputs: [] }],
};
const EMPTY_REPORT: MachineReport = { folders: [], sessions: [] };

test("a person sees only their own machines, sorted, with what each connected one reported, and no key hashes", () => {
  const reports = new Map([
    ["2", SPARK_REPORT],
    ["3", EMPTY_REPORT],
  ]);
  expect(buildMachineSummaries(MACHINES, reports, "joe")).toEqual([
    { machineId: "1", machineName: "atlas", isConnected: false, folders: null, sessions: null },
    { machineId: "2", machineName: "spark", isConnected: true, ...SPARK_REPORT },
  ]);
});

test("another person sees none of Joe's machines", () => {
  const reports = new Map([
    ["1", EMPTY_REPORT],
    ["2", EMPTY_REPORT],
    ["3", EMPTY_REPORT],
  ]);
  expect(buildMachineSummaries(MACHINES, reports, "sam")).toEqual([
    { machineId: "3", machineName: "laptop", isConnected: true, folders: [], sessions: [] },
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

describe("chooseSessionName", () => {
  test("uses the typed name, cleaned up", () => {
    expect(chooseSessionName("Fix Login", "talos", [])).toBe("fix-login");
  });

  test("no name, or a blank one, uses the folder's", () => {
    expect(chooseSessionName(undefined, "talos", [])).toBe("talos");
    expect(chooseSessionName("   ", "talos", [])).toBe("talos");
  });

  test("a name already running gets -2", () => {
    expect(chooseSessionName(undefined, "talos", ["talos"])).toBe("talos-2");
  });
});
