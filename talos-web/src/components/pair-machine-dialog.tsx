import { ArrowRightIcon, PlusIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { approvePairing } from "@/api";
import { IconButton } from "@/components/icon-button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

// The new machine shows up in the table on its own once it connects, so a
// successful pairing just closes the dialog.
export const PairMachineDialog = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [userCode, setUserCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [isPairing, setIsPairing] = useState(false);

  const changeOpen = (isNowOpen: boolean) => {
    setIsOpen(isNowOpen);
    setUserCode("");
    setProblem(null);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setIsPairing(true);
    const approval = await approvePairing(userCode).finally(() => setIsPairing(false));
    if ("problem" in approval) return setProblem(approval.problem);
    changeOpen(false);
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
        </DialogContent>
      </Dialog>
    </>
  );
};
