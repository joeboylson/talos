import { CircleCheckIcon, CircleXIcon, ImageIcon, LoaderCircleIcon } from "lucide-react";
import type { SessionEntry, ToolOutcome } from "talos-shared";
import { MarkdownText } from "@/components/markdown-text";
import type { WaitingPrompt } from "@/session-rows";

const TOOL_OUTCOME_ICONS: Record<ToolOutcome, { icon: typeof LoaderCircleIcon; label: string; className: string }> = {
  running: { icon: LoaderCircleIcon, label: "Running", className: "animate-spin text-muted-foreground" },
  done: { icon: CircleCheckIcon, label: "Done", className: "text-muted-foreground" },
  failed: { icon: CircleXIcon, label: "Failed", className: "text-destructive" },
};

// A message someone sent. Images show as previews while it's waiting, and as
// one icon each once Claude Code has saved it (the page doesn't keep them).
export const PromptBubble = ({
  text,
  imageCount = 0,
  imagePreviewUrls = [],
  isWaiting = false,
}: {
  text: string;
  imageCount?: number;
  imagePreviewUrls?: string[];
  isWaiting?: boolean;
}) => (
  <div className="ml-auto flex max-w-[85%] items-start gap-2">
    {isWaiting && <LoaderCircleIcon className="mt-2 size-4 shrink-0 animate-spin text-muted-foreground" />}
    <div className="flex flex-col items-end gap-2 rounded-lg bg-muted px-3 py-2">
      {imagePreviewUrls.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {imagePreviewUrls.map((previewUrl) => (
            <img key={previewUrl} src={previewUrl} alt="" className="max-h-32 rounded-md border object-cover" />
          ))}
        </div>
      )}
      {imagePreviewUrls.length === 0 && imageCount > 0 && (
        <div className="flex gap-1 text-muted-foreground" aria-label={`${imageCount} image(s)`}>
          {Array.from({ length: imageCount }, (_, index) => (
            <ImageIcon key={index} className="size-4" />
          ))}
        </div>
      )}
      {text && <p className="text-sm whitespace-pre-wrap break-words">{text}</p>}
    </div>
  </div>
);

export const WaitingPromptBubble = ({ waitingPrompt }: { waitingPrompt: WaitingPrompt }) => (
  <PromptBubble text={waitingPrompt.text} imagePreviewUrls={waitingPrompt.imagePreviewUrls} isWaiting />
);

const ToolRow = ({ entry }: { entry: Extract<SessionEntry, { kind: "tool" }> }) => {
  const outcome = TOOL_OUTCOME_ICONS[entry.outcome];
  const OutcomeIcon = outcome.icon;
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <OutcomeIcon className={`size-3.5 shrink-0 ${outcome.className}`} aria-label={outcome.label} />
      <span className="shrink-0 font-medium text-foreground">{entry.toolName}</span>
      <span className="truncate font-mono">{entry.summary}</span>
    </div>
  );
};

export const SessionEntryView = ({ entry }: { entry: SessionEntry }) => {
  if (entry.kind === "prompt") return <PromptBubble text={entry.text} imageCount={entry.imageCount} />;
  if (entry.kind === "tool") return <ToolRow entry={entry} />;
  return (
    <div className="max-w-[85%]">
      <MarkdownText text={entry.text} />
    </div>
  );
};
