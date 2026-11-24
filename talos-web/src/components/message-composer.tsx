import { ImagePlusIcon, SendIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import { IconButton } from "@/components/icon-button";
import { Textarea } from "@/components/ui/textarea";
import { canSendMessage, isSendKey, takeImagesThatFit } from "@/compose-message";
import { prepareImage, previewSentImage, type PreparedImage } from "@/images";
import type { ReturnedMessage } from "@/page-state";
import { LIMITS } from "talos-shared";

// onSend: false when it couldn't be sent, so what was typed stays.
// returned: messages given back (they waited and won't go in), added to
// what's typed, with their images; onReturnedTaken says they're in.
// draftKey: the session the typed text is kept for, in this browser, so a
// refresh or a dropped connection doesn't lose it. canSend: false while the
// session can't be reached; typing still works.
type MessageComposerProps = {
  draftKey: string;
  canSend?: boolean;
  onSend: (text: string, images: PreparedImage[]) => boolean;
  returned?: ReturnedMessage;
  onReturnedTaken?: () => void;
};

const imagesOf = (files: Iterable<File>): File[] => [...files].filter((file) => file.type.startsWith("image/"));

// Browser storage can be off or full (a private window); the draft is only a
// convenience, so then it just isn't kept.
const DRAFT_PREFIX = "talos:draft:";
const readDraft = (draftKey: string): string => {
  try {
    return localStorage.getItem(`${DRAFT_PREFIX}${draftKey}`) ?? "";
  } catch {
    return "";
  }
};
const saveDraft = (draftKey: string, text: string): void => {
  try {
    if (text) localStorage.setItem(`${DRAFT_PREFIX}${draftKey}`, text);
    else localStorage.removeItem(`${DRAFT_PREFIX}${draftKey}`);
  } catch {
    // Not kept; see readDraft.
  }
};

// The box for a new message. Images come from the attach button or from
// pasting.
export const MessageComposer = ({ draftKey, canSend: isReachable = true, onSend, returned, onReturnedTaken }: MessageComposerProps) => {
  const [typedText, setTypedText] = useState(() => readDraft(draftKey));
  useEffect(() => saveDraft(draftKey, typedText), [draftKey, typedText]);
  const [images, setImages] = useState<PreparedImage[]>([]);

  useEffect(() => {
    if (!returned) return;
    setTypedText((current) => (current.trim() ? `${returned.text}\n\n${current}` : returned.text));
    const returnedImages = returned.images.map(previewSentImage);
    setImages((current) => {
      const kept = [...returnedImages, ...current];
      kept.slice(LIMITS.maxImagesPerMessage).forEach(({ previewUrl }) => URL.revokeObjectURL(previewUrl));
      return kept.slice(0, LIMITS.maxImagesPerMessage);
    });
    onReturnedTaken?.();
  }, [returned, onReturnedTaken]);
  const [problem, setProblem] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canAddImages = images.length < LIMITS.maxImagesPerMessage;
  const canSend = isReachable && canSendMessage(typedText, images.length);

  const addImages = async (files: File[]) => {
    const prepared = await Promise.all(takeImagesThatFit(files, images.length).map(prepareImage)).catch((error: unknown) => {
      setProblem(error instanceof Error ? error.message : "Couldn't add that image");
      return [];
    });
    setImages((current) => [...current, ...prepared].slice(0, LIMITS.maxImagesPerMessage));
  };

  const removeImage = (previewUrl: string) => {
    URL.revokeObjectURL(previewUrl);
    setImages((current) => current.filter((image) => image.previewUrl !== previewUrl));
  };

  const sendMessage = () => {
    if (!canSend || !onSend(typedText, images)) return;
    setTypedText("");
    setImages([]);
    setProblem(null);
  };
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    sendMessage();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isSendKey(event)) return;
    event.preventDefault();
    sendMessage();
  };
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedImages = imagesOf(event.clipboardData.files);
    if (pastedImages.length === 0) return;
    event.preventDefault();
    void addImages(pastedImages);
  };

  return (
    <form onSubmit={handleSubmit} className="sticky bottom-4 flex flex-col gap-2 rounded-lg border bg-background p-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-1 pt-1">
          {images.map(({ previewUrl }) => (
            <div key={previewUrl} className="relative">
              <img src={previewUrl} alt="" className="size-16 rounded-md border object-cover" />
              <IconButton
                label="Remove image"
                icon={<XIcon />}
                variant="secondary"
                size="icon"
                className="absolute -top-2 -right-2 size-5 rounded-full [&_svg]:size-3"
                onClick={() => removeImage(previewUrl)}
              />
            </div>
          ))}
        </div>
      )}
      {problem && <p className="px-1 text-xs text-destructive">{problem}</p>}
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label="Image files"
          onChange={(event) => {
            void addImages(imagesOf(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <IconButton
          label="Attach image"
          icon={<ImagePlusIcon />}
          disabled={!canAddImages}
          onClick={() => fileInputRef.current?.click()}
        />
        <Textarea
          value={typedText}
          maxLength={LIMITS.maxSentTextLength}
          onChange={(event) => setTypedText(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          aria-label="Message"
          className="max-h-48 min-h-10 resize-none border-0 shadow-none focus-visible:ring-0"
        />
        <IconButton label="Send" icon={<SendIcon />} variant="default" type="submit" disabled={!canSend} />
      </div>
    </form>
  );
};
