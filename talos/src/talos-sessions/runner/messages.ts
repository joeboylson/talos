// Typing a message, with any images, into a session.
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SentImage } from "../shapes";
import { HOME_MODE, IMAGE_PASTE_SETTLE_MS, UPLOAD_FILE_MODE, steadyNow } from "../constants";
import { paths } from "./inputs";
import { noSuchSession, refuse } from "./refuse";
import { SESSION_LIMITS } from "../limits";
import { ENTER_KEY, buildMessageWithImages, buildPastedText } from "../terminal";
import { applyLaneEvent } from "./session-state";
import { heldSessions, isPromptShowing, typeInTurn, updateHeldSession, type HeldSession, type TypedMessage } from "./store";

// The message counts as a draft until its Enter (an image paste waits a second
// first), and Enter sends any draft along with it, so the box is empty after.
// One at a time (see typeInTurn). Old images go only once a message is in, so
// none waiting to be typed is lost.
// False when a permission prompt came up first: its Enter would approve it.
export const typeIntoSession = (session: HeldSession, message: TypedMessage): Promise<boolean> =>
  typeInTurn(session.summary.sessionName, () => typeOne(session, message));

// Checked again just before each write, since the prompt can come up while the
// message waits its turn or for its images.
const isPromptShowingNow = (sessionName: string): boolean => {
  const current = heldSessions.get(sessionName);
  return current !== undefined && isPromptShowing(current);
};

// A message stopped before its Enter stays in the box as a draft.
const typeOne = async (session: HeldSession, { text, hasImages, imagePaths = [] }: TypedMessage): Promise<boolean> => {
  const { sessionName } = session.summary;
  if (isPromptShowingNow(sessionName)) return false;
  updateHeldSession(sessionName, session.hookToken, { hasDraft: true, draftAtMs: steadyNow() });
  session.terminal.write(buildPastedText(text));
  if (hasImages) await Bun.sleep(IMAGE_PASTE_SETTLE_MS);
  if (isPromptShowingNow(sessionName)) return false;
  session.terminal.write(ENTER_KEY);
  updateHeldSession(sessionName, session.hookToken, { hasDraft: false });
  if (hasImages) await dropOldImages(sessionName, imagePaths).catch(() => {});
  return true;
};

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
const dropOldImages = async (sessionName: string, justTyped: readonly string[]): Promise<void> => {
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

export const sendToSession = async (sessionName: string, text: string, images: SentImage[]): Promise<Response> => {
  const waiting = heldSessions.get(sessionName);
  if (!waiting) return noSuchSession(sessionName);
  if (waiting.summary.state === "starting" && waiting.queuedMessages.length >= SESSION_LIMITS.maxQueuedMessages) {
    return refuse("still-starting", "It's still starting; send that once it's ready");
  }
  // Typed into a permission prompt, the message would answer it (its Enter
  // approves) and be lost, so it waits for the person to answer the prompt.
  if (isPromptShowing(waiting)) return refusePromptShowing();
  // Esc in the terminal stopped it: only the person continues it, there.
  if (waiting.summary.state === "stopped") return refuse("stopped", "It was stopped in its terminal; continue it there");
  if (waiting.summary.link === "lost") return refuseLinkLost();
  // A session that ends while its images are saved takes its uploads folder with it.
  const imagePaths = await saveImages(sessionName, images).catch((error: unknown) => {
    if (heldSessions.has(sessionName)) throw error;
    return null;
  });
  const session = heldSessions.get(sessionName);
  if (!session || !imagePaths) return noSuchSession(sessionName);
  const message = { text: buildMessageWithImages(text, imagePaths), hasImages: images.length > 0, imagePaths };
  if (session.summary.state === "starting") {
    heldSessions.set(sessionName, { ...session, queuedMessages: [...session.queuedMessages, message] });
  } else {
    applyLaneEvent(sessionName, { type: "person-typed", isTurnChanging: true });
    if (!(await typeIntoSession(session, message))) return refusePromptShowing();
  }
  return new Response(null, { status: 204 });
};

// Its mod is gone, so talos can't see where it is: what's sent could land
// anywhere. It runs on, and its terminal still works.
export const refuseLinkLost = (): Response => refuse("link-lost", "talos lost touch with it; use its terminal");

const refusePromptShowing = (): Response => refuse("prompt-showing", "Claude is asking permission; answer it first");
