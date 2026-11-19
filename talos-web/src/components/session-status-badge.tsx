import type { SessionStatus } from "talos-shared";
import { Badge } from "@/components/ui/badge";

// The structured status a session reports when asked (plus the host's "pending"
// and "no-response"). Mirrors SessionStateBadge; dots use fixed status colors.
const STATUS_LOOKS: Record<SessionStatus["state"], { label: string; dotClass: string }> = {
  working: { label: "Working", dotClass: "bg-blue-500" },
  waiting: { label: "Waiting", dotClass: "bg-amber-500" },
  done: { label: "Done", dotClass: "bg-green-500" },
  stuck: { label: "Stuck", dotClass: "bg-red-500" },
  pending: { label: "Asking…", dotClass: "animate-pulse bg-muted-foreground" },
  "no-response": { label: "No response", dotClass: "bg-muted-foreground" },
};

export const SessionStatusBadge = ({ status }: { status: SessionStatus }) => (
  <div className="flex min-w-0 items-center gap-2">
    <Badge variant="outline" className="shrink-0 px-1.5 text-muted-foreground">
      <span className={`size-2 rounded-full ${STATUS_LOOKS[status.state].dotClass}`} />
      {STATUS_LOOKS[status.state].label}
    </Badge>
    {status.note && <span className="truncate text-sm text-muted-foreground">{status.note}</span>}
  </div>
);
