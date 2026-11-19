import { MessageSquareIcon, RefreshCwIcon, SquareIcon } from "lucide-react";
import type { MachineSummary } from "talos-shared";
import { IconButton } from "@/components/icon-button";
import { SessionStateBadge } from "@/components/session-state-badge";
import { SessionStatusBadge } from "@/components/session-status-badge";
import { StartSessionDialog } from "@/components/start-session-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { buildSessionRows, type SessionRow } from "@/session-rows";

type SessionsTableProps = {
  machines: MachineSummary[];
  notice: string | null;
  onStart: (machineId: string, folderName: string, sessionName?: string) => void;
  onOpen: (sessionRow: SessionRow) => void;
  onStop: (sessionRow: SessionRow) => void;
  onAskUpdate: (sessionRow: SessionRow) => void;
};

export const SessionsTable = ({ machines, notice, onStart, onOpen, onStop, onAskUpdate }: SessionsTableProps) => {
  const sessionRows = buildSessionRows(machines);

  return (
    <div className="flex flex-col gap-4 px-4 lg:px-6">
      <div className="flex items-center justify-end gap-2">
        {notice && <p className="mr-auto text-sm text-destructive">{notice}</p>}
        <StartSessionDialog machines={machines} onStart={onStart} />
      </div>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead>Machine</TableHead>
              <TableHead>Folder</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessionRows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  No sessions
                </TableCell>
              </TableRow>
            )}
            {sessionRows.map((sessionRow) => (
              <TableRow key={`${sessionRow.machineId}:${sessionRow.sessionName}`}>
                <TableCell className="font-medium">
                  <button type="button" className="hover:underline" onClick={() => onOpen(sessionRow)}>
                    {sessionRow.sessionName}
                  </button>
                </TableCell>
                <TableCell>{sessionRow.machineName}</TableCell>
                <TableCell>{sessionRow.folderName}</TableCell>
                <TableCell>
                  <SessionStateBadge state={sessionRow.state} />
                </TableCell>
                <TableCell className="max-w-xs">
                  {sessionRow.status && <SessionStatusBadge status={sessionRow.status} />}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <IconButton
                      label={`Ask ${sessionRow.sessionName} for an update`}
                      icon={<RefreshCwIcon />}
                      onClick={() => onAskUpdate(sessionRow)}
                    />
                    <IconButton
                      label={`Open ${sessionRow.sessionName}`}
                      icon={<MessageSquareIcon />}
                      onClick={() => onOpen(sessionRow)}
                    />
                    <IconButton
                      label={`Stop ${sessionRow.sessionName}`}
                      icon={<SquareIcon />}
                      onClick={() => onStop(sessionRow)}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};
