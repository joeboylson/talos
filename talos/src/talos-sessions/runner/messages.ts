// Typing a message, with any images, into a session.
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SentImage } from "../shapes";
import { HOME_MODE, UPLOAD_FILE_MODE } from "../constants";
import { paths } from "./inputs";
import { noSuchSession, refuse } from "./refuse";
import { SESSION_LIMITS } from "../limits";
import { buildMessageWithImages } from "../terminal";
import { sendWhenSettled } from "./session-state";
import { heldSessions } from "./store";

const IMAGE_FILE_EXTENSIONS: Record<SentImage["mediaType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// Only the newest images stay: a long session would otherwise keep every one it
// was sent until it ends. Counted in the order they were typed, which the
// runner keeps itself (a file's time moves with the clock).
const typedImages = new Map<string, string[]>();
export const dropOldImages = async (sessionName: string, justTyped: readonly string[]): Promise<void> => {
  const all = [...(typedImages.get(sessionName) ?? []), ...justTyped];
  const kept = all.slice(-SESSION_LIMITS.maxUploadsKept);
  typedImages.set(sessionName, kept);
  await Promise.all(all.slice(0, all.length - kept.length).map((path) => rm(path, { force: true })));
};
export const forgetTypedImages = (sessionName: string): void => void typedImages.delete(sessionName);

const saveImages = async (sessionName: string, images: SentImage[]): Promise<string[]> => {
  if (images.length === 0) return [];
  const sessionUploadsFolder = join(paths().uploads, sessionName);
  await mkdir(sessionUploadsFolder, { recursive: true, mode: HOME_MODE });
  const saved = await Promise.all(
    images.map(async ({ mediaType, dataBase64 }) => {
      const imagePath = join(sessionUploadsFolder, `${crypto.randomUUID()}.${IMAGE_FILE_EXTENSIONS[mediaType]}`);
      await Bun.write(imagePath, Buffer.from(dataBase64, "base64"));
      await chmod(imagePath, UPLOAD_FILE_MODE);
      return imagePath;
    }),
  );
  return saved;
};

// Every message waits its turn in the session's list and goes in once the
// turn is over (see sendWhenSettled): Claude Code can't take back one it has
// queued, and an interrupt or Esc gives the waiting ones back to the page.
export const sendToSession = async (sessionName: string, text: string, images: SentImage[]): Promise<Response> => {
  const waiting = heldSessions.get(sessionName);
  if (!waiting) return noSuchSession(sessionName);
  // Esc in the terminal stopped it: only the person continues it, there.
  if (waiting.summary.state === "stopped") return refuse("stopped", "It was stopped in its terminal; continue it there");
  if (waiting.summary.link === "lost") return refuseLinkLost();
  if (waiting.queuedMessages.length >= SESSION_LIMITS.maxQueuedMessages) return refuse("too-many-waiting", "It has as many messages waiting as it takes");
  // A session that ends while its images are saved takes its uploads folder with it.
  const imagePaths = await saveImages(sessionName, images).catch((error: unknown) => {
    if (heldSessions.has(sessionName)) throw error;
    return null;
  });
  const session = heldSessions.get(sessionName);
  if (!session || !imagePaths) return noSuchSession(sessionName);
  const message = { text: buildMessageWithImages(text, imagePaths), imagePaths };
  heldSessions.set(sessionName, { ...session, queuedMessages: [...session.queuedMessages, message] });
  sendWhenSettled(sessionName);
  return new Response(null, { status: 204 });
};

// Its mod is gone, so talos can't see where it is: what's sent could land
// anywhere. It runs on, and its terminal still works.
export const refuseLinkLost = (): Response => refuse("link-lost", "talos lost touch with it; use its terminal");
