import { CheckIcon, ShieldQuestionIcon, XIcon } from "lucide-react";
import { useId } from "react";
import type { PermissionAsk } from "talos-shared";
import { IconButton } from "@/components/icon-button";
import { Card, CardContent } from "@/components/ui/card";

// Claude Code asks whether a tool may run. Allow or Deny answers it.
export const PermissionCard = ({ ask, onAnswer }: { ask: PermissionAsk; onAnswer: (isAllowed: boolean) => void }) => {
  const askId = useId();
  return (
    <Card className="py-4" role="group" aria-labelledby={askId}>
      <CardContent className="flex items-center gap-3 px-4">
        <ShieldQuestionIcon className="size-4 shrink-0 text-muted-foreground" role="img" aria-label="Permission" />
        <div id={askId} className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">{ask.tool}</span>
          {ask.summary && <code className="truncate text-xs text-muted-foreground">{ask.summary}</code>}
        </div>
        <IconButton label="Allow" icon={<CheckIcon />} variant="default" size="icon-sm" onClick={() => onAnswer(true)} />
        <IconButton label="Deny" icon={<XIcon />} variant="outline" size="icon-sm" onClick={() => onAnswer(false)} />
      </CardContent>
    </Card>
  );
};
