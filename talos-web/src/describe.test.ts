import { expect, test } from "bun:test";
import { describeLocalStatus, describeMachineList, describeServerMessage, formatLogLine } from "./describe";

test("describeMachineList", () => {
  expect(describeMachineList([])).toBe("No machines connected");
  expect(describeMachineList(["atlas"])).toBe("Connected: atlas");
  expect(describeMachineList(["atlas", "spark"])).toBe("Connected: atlas, spark");
});

test("describeLocalStatus", () => {
  expect(describeLocalStatus({ machineName: "atlas", isConnected: true })).toBe(
    "atlas: talos is running, connected to the server",
  );
  expect(describeLocalStatus({ machineName: "atlas", isConnected: false })).toBe(
    "atlas: talos is running, not connected to the server",
  );
});

test("formatLogLine puts the time before the text", () => {
  const loggedAt = new Date(2026, 10, 17, 9, 5, 7);
  expect(formatLogLine("ping", loggedAt)).toBe(`${loggedAt.toLocaleTimeString()}  ping`);
});

test("describeServerMessage", () => {
  expect(describeServerMessage({ type: "pong", machineName: "atlas", roundTripMs: 12 })).toBe(
    "pong from atlas (12 ms)",
  );
  expect(describeServerMessage({ type: "error", message: "No machines connected" })).toBe(
    "No machines connected",
  );
  expect(describeServerMessage({ type: "machines", machineNames: ["atlas"] })).toBeNull();
});
