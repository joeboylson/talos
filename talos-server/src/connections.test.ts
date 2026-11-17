import { expect, test } from "bun:test";
import { buildMachineSummaries } from "./connections";

const machine = (machineId: string, machineName: string) => ({ machineId, machineName, keyHash: "hash", pairedAtMs: 0 });

test("buildMachineSummaries marks connected machines, sorts by name, and drops key hashes", () => {
  const machines = [machine("2", "spark"), machine("1", "atlas")];
  expect(buildMachineSummaries(machines, new Set(["2"]))).toEqual([
    { machineId: "1", machineName: "atlas", isConnected: false },
    { machineId: "2", machineName: "spark", isConnected: true },
  ]);
});

test("buildMachineSummaries with no machines", () => {
  expect(buildMachineSummaries([], new Set())).toEqual([]);
});
