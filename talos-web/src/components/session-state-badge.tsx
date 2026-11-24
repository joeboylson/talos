import { BotIcon, UnplugIcon, type LucideIcon } from "lucide-react";
import type { LinkState, SessionState } from "talos-shared";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const STATE_LOOKS: Record<SessionState, { label: string; dotClass: string }> = {
  starting: { label: "Starting", dotClass: "animate-pulse bg-muted-foreground" },
  idle: { label: "Ready", dotClass: "bg-green-500" },
  working: { label: "Working", dotClass: "animate-pulse bg-blue-500" },
  "needs-you": { label: "Needs you", dotClass: "bg-amber-500" },
};

// An icon that says one thing about the session, its words on hover.
const SessionMark = ({ icon: Icon, label }: { icon: LucideIcon; label: string }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span role="img" aria-label={label} className="text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
);

// While its machine is offline, the state it last had isn't known to hold.
const OFFLINE_LOOK = { label: "Offline", dotClass: "bg-muted-foreground" };

type SessionStateBadgeProps = { state: SessionState; isMachineConnected: boolean; link?: LinkState; isSelfStarted?: true };

export const SessionStateBadge = ({ state, isMachineConnected, link, isSelfStarted }: SessionStateBadgeProps) => {
  const look = isMachineConnected ? STATE_LOOKS[state] : OFFLINE_LOOK;
  return (
  <span className="inline-flex items-center gap-1.5">
    <Badge variant="outline" className="px-1.5 text-muted-foreground">
      <span className={`size-2 rounded-full ${look.dotClass}`} />
      {look.label}
    </Badge>
    {isSelfStarted && <SessionMark icon={BotIcon} label="Started by Claude Code" />}
    {link === "lost" && <SessionMark icon={UnplugIcon} label="Link lost" />}
  </span>
  );
};
