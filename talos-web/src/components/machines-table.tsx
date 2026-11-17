import { PencilIcon, RadioIcon, TrashIcon } from "lucide-react";
import { useState } from "react";
import { renameMachine } from "@/api";
import type { LocalStatus, MachineSummary } from "talos-shared";
import { IconButton } from "@/components/icon-button";
import { PairMachineDialog } from "@/components/pair-machine-dialog";
import { RenameDialog } from "@/components/rename-dialog";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatRoundTrip } from "@/describe";

type MachinesTableProps = {
  machines: MachineSummary[];
  roundTripMsByMachineId: Record<string, number>;
  localStatus: LocalStatus | null;
  notice: string | null;
  canPing: boolean;
  onPing: (machineId?: string) => void;
  onRemove: (machine: MachineSummary) => void;
};

const StatusBadge = ({ isConnected }: { isConnected: boolean }) => (
  <Badge variant="outline" className="px-1.5 text-muted-foreground">
    <span className={isConnected ? "size-2 rounded-full bg-green-500" : "size-2 rounded-full bg-muted-foreground"} />
    {isConnected ? "Connected" : "Offline"}
  </Badge>
);

// One table, with its actions in a toolbar above it, like the table in
// shadcn's dashboard-01 block.
export const MachinesTable = (props: MachinesTableProps) => {
  const { machines, roundTripMsByMachineId, localStatus, notice, canPing, onPing, onRemove } = props;
  const hasMachines = machines.length > 0;
  const [machineBeingRenamed, setMachineBeingRenamed] = useState<MachineSummary | null>(null);

  return (
    <div className="flex flex-col gap-4 px-4 lg:px-6">
      <div className="flex items-center justify-end gap-2">
        {notice && <p className="mr-auto text-sm text-destructive">{notice}</p>}
        <div className="flex items-center gap-2">
          <IconButton
            label="Ping all"
            icon={<RadioIcon />}
            variant="outline"
            size="icon-sm"
            disabled={!canPing || !hasMachines}
            onClick={() => onPing()}
          />
          <PairMachineDialog />
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last ping</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {!hasMachines && (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  No machines
                </TableCell>
              </TableRow>
            )}
            {machines.map((machine) => (
              <TableRow key={machine.machineId}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    {machine.machineName}
                    {localStatus?.machineName === machine.machineName && (
                      <Badge variant="secondary">This machine</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge isConnected={machine.isConnected} />
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {formatRoundTrip(roundTripMsByMachineId[machine.machineId])}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <IconButton
                      label={`Ping ${machine.machineName}`}
                      icon={<RadioIcon />}
                      disabled={!canPing || !machine.isConnected}
                      onClick={() => onPing(machine.machineId)}
                    />
                    <IconButton
                      label={`Rename ${machine.machineName}`}
                      icon={<PencilIcon />}
                      onClick={() => setMachineBeingRenamed(machine)}
                    />
                    <IconButton
                      label={`Remove ${machine.machineName}`}
                      icon={<TrashIcon />}
                      onClick={() => onRemove(machine)}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <RenameDialog
        title="Rename machine"
        currentName={machineBeingRenamed?.machineName ?? null}
        onClose={() => setMachineBeingRenamed(null)}
        onRename={(name) => renameMachine(machineBeingRenamed?.machineId ?? "", name)}
      />
    </div>
  );
};
