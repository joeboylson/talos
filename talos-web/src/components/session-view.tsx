import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { SessionEntry } from "talos-shared";
import { DecisionCard } from "@/components/decision-card";
import { MessageComposer } from "@/components/message-composer";
import { SessionEntryView, WaitingPromptBubble } from "@/components/session-entry";
import { SessionStateBadge } from "@/components/session-state-badge";
import type { PreparedImage } from "@/images";
import type { SessionRow, WaitingPrompt } from "@/session-rows";

type SessionViewProps = {
  sessionRow: SessionRow | null;
  entries: SessionEntry[];
  waitingPrompts: WaitingPrompt[];
  onSend: (text: string, images: PreparedImage[]) => void;
};

// One session's conversation as it happens: messages, Claude's text, and each
// tool Claude runs, then a box to send it a message.
export const SessionView = ({ sessionRow, entries, waitingPrompts, onSend }: SessionViewProps) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastEntry = entries.at(-1);
  const scrollTrigger = `${entries.length}:${lastEntry?.entryId}:${lastEntry?.kind === "tool" ? lastEntry.outcome : ""}:${waitingPrompts.length}:${sessionRow?.decision !== undefined}`;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [scrollTrigger]);

  if (!sessionRow) return <p className="px-4 text-center text-sm text-muted-foreground lg:px-6">No such session</p>;

  const isWorking = sessionRow.state === "working";

  return (
    <div className="flex flex-1 flex-col gap-4 px-4 lg:px-6">
      <div className="flex justify-end">
        <SessionStateBadge state={sessionRow.state} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {entries.map((entry) => (
          <SessionEntryView key={entry.entryId} entry={entry} />
        ))}
        {waitingPrompts.map((waitingPrompt, index) => (
          <WaitingPromptBubble key={`${index}:${waitingPrompt.text}`} waitingPrompt={waitingPrompt} />
        ))}
        {isWorking && (
          <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" aria-label="Working" role="status" />
        )}
        {/* Shown once the turn is over, so a click never lands mid-turn. */}
        {sessionRow.decision && sessionRow.state === "needs-you" && (
          <DecisionCard decision={sessionRow.decision} onChoose={(choice) => onSend(choice, [])} />
        )}
        <div ref={bottomRef} />
      </div>
      <MessageComposer onSend={onSend} />
    </div>
  );
};
