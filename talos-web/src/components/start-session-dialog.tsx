import { ArrowRightIcon, PlusIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { MachineSummary } from "talos-shared";
import { IconButton } from "@/components/icon-button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { buildFolderRows } from "@/folder-rows";

type StartSessionDialogProps = {
  machines: MachineSummary[];
  onStart: (machineId: string, folderName: string, sessionName?: string) => void;
};

const FOLDER_CHOICE_SEPARATOR = "\n";

// A session starts in one of the folders a connected machine allows. The
// name is optional: left blank, the machine names it after the folder.
export const StartSessionDialog = ({ machines, onStart }: StartSessionDialogProps) => {
  const folderRows = buildFolderRows(machines);
  const [isOpen, setIsOpen] = useState(false);
  const [folderChoice, setFolderChoice] = useState("");
  const [sessionName, setSessionName] = useState("");

  const changeOpen = (isNowOpen: boolean) => {
    setIsOpen(isNowOpen);
    setFolderChoice("");
    setSessionName("");
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const [machineId, folderName] = folderChoice.split(FOLDER_CHOICE_SEPARATOR);
    if (!machineId || !folderName) return;
    onStart(machineId, folderName, sessionName.trim() || undefined);
    changeOpen(false);
  };

  return (
    <>
      <IconButton
        label="Start a session"
        icon={<PlusIcon />}
        variant="default"
        size="icon-sm"
        disabled={folderRows.length === 0}
        onClick={() => changeOpen(true)}
      />
      <Dialog open={isOpen} onOpenChange={changeOpen}>
        <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Start a session</DialogTitle>
            </DialogHeader>
            <Select value={folderChoice} onValueChange={setFolderChoice}>
              <SelectTrigger className="w-full" aria-label="Folder">
                <SelectValue placeholder="Folder" />
              </SelectTrigger>
              <SelectContent>
                {folderRows.map(({ machineId, machineName, folderName }) => (
                  <SelectItem
                    key={`${machineId}:${folderName}`}
                    value={`${machineId}${FOLDER_CHOICE_SEPARATOR}${folderName}`}
                  >
                    {folderName}
                    <span className="text-muted-foreground">{machineName}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Input
                value={sessionName}
                onChange={(event) => setSessionName(event.target.value)}
                placeholder="Name"
                aria-label="Session name"
                autoComplete="off"
              />
              <IconButton
                label="Start"
                icon={<ArrowRightIcon />}
                variant="default"
                type="submit"
                disabled={!folderChoice}
              />
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
