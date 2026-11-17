import type { SessionState } from "talos-shared";
import { Badge } from "@/components/ui/badge";

const STATE_LOOKS: Record<SessionState, { label: string; dotClass: string }> = {
  starting: { label: "Starting", dotClass: "animate-pulse bg-muted-foreground" },
  idle: { label: "Ready", dotClass: "bg-green-500" },
  working: { label: "Working", dotClass: "animate-pulse bg-blue-500" },
  "needs-you": { label: "Needs you", dotClass: "bg-amber-500" },
};

export const SessionStateBadge = ({ state }: { state: SessionState }) => (
  <Badge variant="outline" className="px-1.5 text-muted-foreground">
    <span className={`size-2 rounded-full ${STATE_LOOKS[state].dotClass}`} />
    {STATE_LOOKS[state].label}
  </Badge>
);
