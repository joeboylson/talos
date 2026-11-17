import { expect, test } from "bun:test";
import type { MachineSummary } from "talos-shared";
import { buildSessionRows, findSessionRow, removeAnsweredPrompt } from "../../session-rows";

const machine = (machineName: string, sessions: MachineSummary["sessions"]): MachineSummary => ({
  machineId: `${machineName}-id`,
  machineName,
  isConnected: sessions !== null,
  folders: [],
  sessions,
});

const MACHINES = [
  machine("spark", [{ sessionName: "fix-login", folderName: "talos", state: "working" }]),
  machine("atlas", [
    { sessionName: "web", folderName: "website", state: "idle" },
    { sessionName: "api", folderName: "talos", state: "needs-you" },
  ]),
  machine("laptop", null),
];

test("lists every connected machine's sessions, by machine then session", () => {
  expect(buildSessionRows(MACHINES).map((row) => `${row.machineName}/${row.sessionName}/${row.state}`)).toEqual([
    "atlas/api/needs-you",
    "atlas/web/idle",
    "spark/fix-login/working",
  ]);
});

test("findSessionRow finds by machine and session name", () => {
  expect(findSessionRow(MACHINES, "spark", "fix-login")?.machineId).toBe("spark-id");
  expect(findSessionRow(MACHINES, "spark", "web")).toBeNull();
});

test("removeAnsweredPrompt clears the first matching waiting message only", () => {
  expect(removeAnsweredPrompt(["hi", "again", "hi"], "hi")).toEqual(["again", "hi"]);
  expect(removeAnsweredPrompt(["hi"], "typed in the terminal")).toEqual(["hi"]);
  expect(removeAnsweredPrompt([" hi "], " hi ")).toEqual([" hi "]);
});
