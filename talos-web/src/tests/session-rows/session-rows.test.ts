import { describe, expect, test } from "bun:test";
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

describe("removeAnsweredPrompt", () => {
  const waiting = (text: string, imageCount = 0) => ({ text, imagePreviewUrls: Array.from({ length: imageCount }, () => "blob:x") });
  const saved = (text: string, imageCount = 0) => ({ kind: "prompt", entryId: "e", text, imageCount }) as const;

  test("clears the first matching waiting message only", () => {
    expect(removeAnsweredPrompt([waiting("hi"), waiting("again"), waiting("hi")], saved("hi"))).toEqual([
      waiting("again"),
      waiting("hi"),
    ]);
  });

  test("leaves waiting messages alone for one typed in the terminal", () => {
    expect(removeAnsweredPrompt([waiting("hi")], saved("typed in the terminal"))).toEqual([waiting("hi")]);
  });

  test("matches the number of images too", () => {
    expect(removeAnsweredPrompt([waiting("look", 1), waiting("look", 2)], saved("look", 2))).toEqual([waiting("look", 1)]);
    expect(removeAnsweredPrompt([waiting("", 1)], saved("", 1))).toEqual([]);
  });
});
