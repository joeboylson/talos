import { PencilIcon } from "lucide-react";
import { useState } from "react";
import type { MachineSummary } from "talos-shared";
import { renameFolder } from "@/api";
import { IconButton } from "@/components/icon-button";
import { RenameDialog } from "@/components/rename-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { buildFolderRows, type FolderRow } from "@/folder-rows";

// Folders are added on each machine with `talos folders add`. Here they can
// only be renamed; a folder's path never changes.
export const FoldersTable = ({ machines }: { machines: MachineSummary[] }) => {
  const folderRows = buildFolderRows(machines);
  const [folderBeingRenamed, setFolderBeingRenamed] = useState<FolderRow | null>(null);

  return (
    <div className="px-4 lg:px-6">
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead>Folder</TableHead>
              <TableHead>Machine</TableHead>
              <TableHead>Path</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {folderRows.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  No folders
                </TableCell>
              </TableRow>
            )}
            {folderRows.map((folderRow) => (
              <TableRow key={`${folderRow.machineId}:${folderRow.folderName}`}>
                <TableCell className="font-medium">{folderRow.folderName}</TableCell>
                <TableCell>{folderRow.machineName}</TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground">{folderRow.path}</TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <IconButton
                      label={`Rename ${folderRow.folderName}`}
                      icon={<PencilIcon />}
                      onClick={() => setFolderBeingRenamed(folderRow)}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <RenameDialog
        title="Rename folder"
        currentName={folderBeingRenamed?.folderName ?? null}
        onClose={() => setFolderBeingRenamed(null)}
        onRename={(name) =>
          renameFolder(folderBeingRenamed?.machineId ?? "", folderBeingRenamed?.folderName ?? "", name)
        }
      />
    </div>
  );
};
