import { ArrowRightIcon, PlusIcon, SquareTerminalIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { MachineSummary } from "talos-shared";
import { approvePairing } from "@/api";
import { IconButton } from "@/components/icon-button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

// Once the code is accepted, the machine asks in its terminal whether the
// person who entered it is its owner, so the dialog says to confirm there.
// It closes on its own once that machine connects.
export const PairMachineDialog = ({ machines }: { machines: MachineSummary[] }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [userCode, setUserCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [isPairing, setIsPairing] = useState(false);
  const [confirmingName, setConfirmingName] = useState<string | null>(null);

  const changeOpen = (isNowOpen: boolean) => {
    setIsOpen(isNowOpen);
    setUserCode("");
    setProblem(null);
    setConfirmingName(null);
  };

  const isConfirmedMachineConnected = machines.some(({ machineName, isConnected }) => isConnected && machineName === confirmingName);
  useEffect(() => {
    if (isConfirmedMachineConnected) changeOpen(false);
  }, [isConfirmedMachineConnected]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setIsPairing(true);
    const approval = await approvePairing(userCode).finally(() => setIsPairing(false));
    if ("problem" in approval) return setProblem(approval.problem);
    setConfirmingName(approval.machineName);
  };

  return (
    <>
      <IconButton
        label="Pair a machine"
        icon={<PlusIcon />}
        variant="default"
        size="icon-sm"
        onClick={() => changeOpen(true)}
      />
      <Dialog open={isOpen} onOpenChange={changeOpen}>
        <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
          {confirmingName ? (
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <SquareTerminalIcon className="size-5" aria-hidden />
                Confirm on {confirmingName}
              </DialogTitle>
            </DialogHeader>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle>Pair a machine</DialogTitle>
              </DialogHeader>
              <div className="flex gap-2">
                <Input
                  value={userCode}
                  onChange={(event) => setUserCode(event.target.value)}
                  placeholder="ABCD-EFGH"
                  autoComplete="off"
                  className="font-mono uppercase"
                  autoFocus
                  required
                />
                <IconButton label="Pair" icon={<ArrowRightIcon />} variant="default" type="submit" disabled={isPairing} />
              </div>
              {problem && <p className="text-sm text-destructive">{problem}</p>}
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
