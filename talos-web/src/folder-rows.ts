import type { MachineSummary } from "talos-shared";

export type FolderRow = { machineId: string; machineName: string; folderName: string; path: string };

// Every folder on the person's connected machines, by machine then folder.
// Offline machines' folders aren't known, so they don't show.
export const buildFolderRows = (machines: MachineSummary[]): FolderRow[] =>
  machines
    .flatMap(({ machineId, machineName, folders }) =>
      (folders ?? []).map(({ folderName, path }) => ({ machineId, machineName, folderName, path })),
    )
    .sort(
      (first, second) =>
        first.machineName.localeCompare(second.machineName) || first.folderName.localeCompare(second.folderName),
    );
