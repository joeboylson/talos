import { ImagePlusIcon, SendIcon, XIcon } from "lucide-react";
import { useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import { IconButton } from "@/components/icon-button";
import { Textarea } from "@/components/ui/textarea";
import { prepareImage, type PreparedImage } from "@/images";
import { LIMITS } from "talos-shared";

type MessageComposerProps = { onSend: (text: string, images: PreparedImage[]) => void };

const imagesOf = (files: Iterable<File>): File[] => [...files].filter((file) => file.type.startsWith("image/"));

// The box for a new message. Enter sends; Shift+Enter starts a new line.
// Images come from the attach button or from pasting.
export const MessageComposer = ({ onSend }: MessageComposerProps) => {
  const [typedText, setTypedText] = useState("");
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canAddImages = images.length < LIMITS.maxImagesPerMessage;
  const canSend = typedText.trim() !== "" || images.length > 0;

  const addImages = async (files: File[]) => {
    const roomLeft = LIMITS.maxImagesPerMessage - images.length;
    const prepared = await Promise.all(files.slice(0, roomLeft).map(prepareImage)).catch((error: unknown) => {
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
    if (!canSend) return;
    onSend(typedText, images);
    setTypedText("");
    setImages([]);
    setProblem(null);
  };
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    sendMessage();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
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
