import { BotIcon, TerminalIcon, UnplugIcon, type LucideIcon } from "lucide-react";
import type { LinkState, SessionState } from "talos-shared";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const STATE_LOOKS: Record<SessionState, { label: string; dotClass: string }> = {
  starting: { label: "Starting", dotClass: "animate-pulse bg-muted-foreground" },
  idle: { label: "Ready", dotClass: "bg-green-500" },
  working: { label: "Working", dotClass: "animate-pulse bg-blue-500" },
  "needs-you": { label: "Needs you", dotClass: "bg-amber-500" },
  stopped: { label: "Stopped", dotClass: "bg-slate-500" },
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

export const SessionStateBadge = ({ state, link, isSelfStarted }: { state: SessionState; link?: LinkState; isSelfStarted?: true }) => (
  <span className="inline-flex items-center gap-1.5">
    <Badge variant="outline" className="px-1.5 text-muted-foreground">
      <span className={`size-2 rounded-full ${STATE_LOOKS[state].dotClass}`} />
      {STATE_LOOKS[state].label}
    </Badge>
    {state === "stopped" && <SessionMark icon={TerminalIcon} label="Continue in its terminal" />}
    {isSelfStarted && <SessionMark icon={BotIcon} label="Started by Claude Code" />}
    {link === "lost" && <SessionMark icon={UnplugIcon} label="Link lost" />}
  </span>
);
