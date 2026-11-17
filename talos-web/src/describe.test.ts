import { expect, test } from "bun:test";
import {
  describeLocalStatus,
  describeMachine,
  describeMachineCount,
  describeServerMessage,
  formatLogLine,
} from "./describe";

const ATLAS = { machineId: "1", machineName: "atlas", isConnected: true };
const SPARK = { machineId: "2", machineName: "spark", isConnected: false };

test("describeMachine", () => {
  expect(describeMachine(ATLAS)).toBe("atlas: connected");
  expect(describeMachine(SPARK)).toBe("spark: offline");
});

test("describeMachineCount", () => {
  expect(describeMachineCount([])).toBe("No machines paired yet");
  expect(describeMachineCount([ATLAS, SPARK])).toBe("1 of 2 connected");
  expect(describeMachineCount([SPARK])).toBe("0 of 1 connected");
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
  expect(describeServerMessage({ type: "machines", machines: [ATLAS] })).toBeNull();
});
