import { CheckIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { IconButton } from "@/components/icon-button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LIMITS } from "talos-shared";

type RenameDialogProps = {
  title: string;
  currentName: string | null;
  onClose: () => void;
  // Resolves to null when renamed, or the reason it wasn't.
  onRename: (name: string) => Promise<string | null>;
};

// Open while currentName is set; the field starts with the current name.
export const RenameDialog = ({ title, currentName, onClose, onRename }: RenameDialogProps) => {
  const [typedName, setTypedName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setTypedName(currentName ?? "");
    setProblem(null);
  }, [currentName]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    const renameProblem = await onRename(typedName).finally(() => setIsSaving(false));
    if (renameProblem) return setProblem(renameProblem);
    onClose();
  };

  return (
    <Dialog open={currentName !== null} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-sm" aria-describedby={undefined}>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="flex gap-2">
            <Input
              value={typedName}
              maxLength={LIMITS.maxNameTextLength}
              onChange={(event) => setTypedName(event.target.value)}
              autoComplete="off"
              autoFocus
              required
            />
            <IconButton label="Save" icon={<CheckIcon />} variant="default" type="submit" disabled={isSaving} />
          </div>
          {problem && <p className="text-sm text-destructive">{problem}</p>}
        </form>
      </DialogContent>
    </Dialog>
  );
};
