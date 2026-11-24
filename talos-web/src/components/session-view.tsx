import { CircleAlertIcon, CircleStopIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import type { SessionEntry } from "talos-shared";
import { DecisionCard } from "@/components/decision-card";
import { IconButton } from "@/components/icon-button";
import { PermissionCard } from "@/components/permission-card";
import { MessageComposer } from "@/components/message-composer";
import { EntryBoundary, SessionEntryView, WaitingPromptBubble } from "@/components/session-entry";
import { SessionStateBadge } from "@/components/session-state-badge";
import type { PreparedImage } from "@/images";
import type { ReturnedMessage } from "@/page-state";
import { othersWaiting, type SessionRow, type WaitingPrompt } from "@/session-rows";

// isLoading: the machine list hasn't arrived yet, so a missing row isn't
// "no such session" yet. draftKey: which session's unsent message to keep.
type SessionViewProps = {
  sessionRow: SessionRow | null;
  isLoading: boolean;
  draftKey: string;
  entries: SessionEntry[];
  waitingPrompts: WaitingPrompt[];
  onSend: (text: string, images: PreparedImage[]) => boolean;
  onAnswer: (outputId: string, choice: number) => void;
  onInterrupt: () => void;
  onAnswerPermission: (toolUseId: string, isAllowed: boolean) => void;
  returned?: ReturnedMessage;
  onReturnedTaken: () => void;
  // What the person tried here and couldn't do (a closed question, a refused send).
  notice: string | null;
};

// One session's conversation as it happens: messages, Claude's text, and each
// tool Claude runs, then a box to send it a message.
export const SessionView = (props: SessionViewProps) => {
  const { sessionRow, isLoading, draftKey, entries, waitingPrompts, onSend, onAnswer, onInterrupt, onAnswerPermission, returned, onReturnedTaken, notice } = props;
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastEntry = entries.at(-1);
  const scrollTrigger = `${entries.length}:${lastEntry?.entryId}:${lastEntry?.kind === "tool" ? lastEntry.outcome : ""}:${waitingPrompts.length}:${sessionRow?.decision !== undefined}`;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [scrollTrigger]);

  if (isLoading) return null;
  if (!sessionRow) return <p className="px-4 text-center text-sm text-muted-foreground lg:px-6">No such session</p>;

  // Offline, the conversation stays, but nothing can reach the session.
  const isOnline = sessionRow.isMachineConnected;
  const isWorking = isOnline && sessionRow.state === "working";
  // A running turn can be interrupted, a permission prompt's included.
  const canInterrupt = isWorking || (isOnline && sessionRow.isPromptShowing);
  const fromOtherPages = othersWaiting(sessionRow.waitingMessages ?? [], waitingPrompts);
  // Shown once the turn is over, so a click never lands mid-turn. While it's
  // shown, its question isn't shown again in the conversation.
  // Not while Claude asks permission: a click then would only wait.
  const openDecision = isOnline && sessionRow.state === "needs-you" && !sessionRow.isPromptShowing ? sessionRow.decision : undefined;

  return (
    <div className="flex flex-1 flex-col gap-4 px-4 lg:px-6">
      <div className="flex items-center justify-end gap-2">
        {canInterrupt && <IconButton label="Interrupt" icon={<CircleStopIcon />} size="icon" className="size-7" onClick={onInterrupt} />}
        <SessionStateBadge state={sessionRow.state} isMachineConnected={isOnline} link={sessionRow.link} isSelfStarted={sessionRow.isSelfStarted} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {entries.filter((entry) => entry.entryId !== openDecision?.id).map((entry) => (
          <EntryBoundary key={entry.entryId}>
            <SessionEntryView entry={entry} />
          </EntryBoundary>
        ))}
        {fromOtherPages.map((text, index) => (
          <WaitingPromptBubble key={`other:${index}:${text}`} waitingPrompt={{ text, imagePreviewUrls: [] }} />
        ))}
        {waitingPrompts.map((waitingPrompt, index) => (
          <WaitingPromptBubble key={`${index}:${waitingPrompt.text}`} waitingPrompt={waitingPrompt} />
        ))}
        {isWorking && (
          <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" aria-label="Working" role="status" />
        )}
        {isOnline && sessionRow.permissionAsks?.map((ask) => (
          <PermissionCard key={ask.id} ask={ask} onAnswer={(isAllowed) => onAnswerPermission(ask.id, isAllowed)} />
        ))}
        {isOnline && sessionRow.isPromptShowing && !sessionRow.permissionAsks && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleAlertIcon className="size-4" aria-hidden />
            Not responding
          </p>
        )}
        {openDecision && <DecisionCard key={openDecision.id} decision={openDecision} onChoose={(choice) => onAnswer(openDecision.id, choice)} />}
        <div ref={bottomRef} />
      </div>
      {notice && <p className="text-sm text-destructive">{notice}</p>}
      <MessageComposer key={draftKey} draftKey={draftKey} canSend={isOnline} onSend={onSend} returned={returned} onReturnedTaken={onReturnedTaken} />
    </div>
  );
};
