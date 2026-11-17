import { LoaderCircleIcon, SendIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Exchange } from "talos-shared";
import { IconButton } from "@/components/icon-button";
import { SessionStateBadge } from "@/components/session-state-badge";
import { Textarea } from "@/components/ui/textarea";
import type { SessionRow } from "@/session-rows";

type SessionViewProps = {
  sessionRow: SessionRow | null;
  exchanges: Exchange[];
  waitingPrompts: string[];
  onSend: (text: string) => void;
};

const PromptBubble = ({ text, isWaiting }: { text: string; isWaiting?: boolean }) => (
  <div className="ml-auto flex max-w-[80%] items-start gap-2">
    {isWaiting && <LoaderCircleIcon className="mt-2 size-4 shrink-0 animate-spin text-muted-foreground" />}
    <p className="rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{text}</p>
  </div>
);

// One session's conversation, as far as Talos has seen it, and a box to send
// it a message. Enter sends; Shift+Enter starts a new line.
export const SessionView = ({ sessionRow, exchanges, waitingPrompts, onSend }: SessionViewProps) => {
  const [typedText, setTypedText] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [exchanges.length, waitingPrompts.length]);

  if (!sessionRow) return <p className="px-4 text-center text-sm text-muted-foreground lg:px-6">No such session</p>;

  const sendTypedText = () => {
    if (!typedText.trim()) return;
    onSend(typedText);
    setTypedText("");
  };
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    sendTypedText();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    sendTypedText();
  };

  return (
    <div className="flex flex-1 flex-col gap-4 px-4 lg:px-6">
      <div className="flex justify-end">
        <SessionStateBadge state={sessionRow.state} />
      </div>
      <div className="flex flex-1 flex-col gap-4">
        {exchanges.map((exchange) => (
          <div key={exchange.finishedAtMs} className="flex flex-col gap-3">
            <PromptBubble text={exchange.prompt} />
            <p className="max-w-[80%] text-sm whitespace-pre-wrap">{exchange.reply}</p>
          </div>
        ))}
        {waitingPrompts.map((prompt, index) => (
          <PromptBubble key={`${index}:${prompt}`} text={prompt} isWaiting />
        ))}
        <div ref={bottomRef} />
      </div>
      <form onSubmit={handleSubmit} className="sticky bottom-4 flex items-end gap-2 rounded-lg border bg-background p-2">
        <Textarea
          value={typedText}
          onChange={(event) => setTypedText(event.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Message"
          className="max-h-48 min-h-10 resize-none border-0 shadow-none focus-visible:ring-0"
        />
        <IconButton label="Send" icon={<SendIcon />} variant="default" type="submit" disabled={!typedText.trim()} />
      </form>
    </div>
  );
};
