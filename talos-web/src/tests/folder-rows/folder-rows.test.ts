import { expect, test } from "bun:test";
import { buildFolderRows } from "../../folder-rows";

const machine = (machineName: string, folders: { folderName: string; path: string }[] | null) => ({
  machineId: machineName,
  machineName,
  isConnected: folders !== null,
  folders,
  sessions: folders === null ? null : [],
});

test("lists every connected machine's folders, by machine then folder", () => {
  const machines = [
    machine("spark", [{ folderName: "talos", path: "/s/talos" }]),
    machine("atlas", [
      { folderName: "web", path: "/a/web" },
      { folderName: "api", path: "/a/api" },
    ]),
  ];
  expect(buildFolderRows(machines)).toEqual([
    { machineId: "atlas", machineName: "atlas", folderName: "api", path: "/a/api" },
    { machineId: "atlas", machineName: "atlas", folderName: "web", path: "/a/web" },
    { machineId: "spark", machineName: "spark", folderName: "talos", path: "/s/talos" },
  ]);
});

test("offline machines add nothing", () => {
  expect(buildFolderRows([machine("atlas", null), machine("spark", [])])).toEqual([]);
});
