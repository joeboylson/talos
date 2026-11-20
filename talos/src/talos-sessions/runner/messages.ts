// Typing a message, with any images, into a session.
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SentImage } from "../shapes";
import { HOME_MODE, IMAGE_PASTE_SETTLE_MS, UPLOAD_FILE_MODE } from "../constants";
import { paths } from "./inputs";
import { ENTER_KEY, buildMessageWithImages, buildPastedText } from "../terminal";
import { applyLaneEvent } from "./session-state";
import { heldSessions, updateHeldSession, type HeldSession, type TypedMessage } from "./store";

// The message counts as a draft until its Enter (an image paste waits a second
// first), and Enter sends any draft along with it, so the box is empty after.
export const typeIntoSession = async (session: HeldSession, { text, hasImages }: TypedMessage): Promise<void> => {
  const { sessionName } = session.summary;
  updateHeldSession(sessionName, session.hookToken, { hasDraft: true });
  session.terminal.write(buildPastedText(text));
  if (hasImages) await Bun.sleep(IMAGE_PASTE_SETTLE_MS);
  session.terminal.write(ENTER_KEY);
  updateHeldSession(sessionName, session.hookToken, { hasDraft: false });
};

const IMAGE_FILE_EXTENSIONS: Record<SentImage["mediaType"], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const saveImages = async (sessionName: string, images: SentImage[]): Promise<string[]> => {
  if (images.length === 0) return [];
  const sessionUploadsFolder = join(paths().uploads, sessionName);
  await mkdir(sessionUploadsFolder, { recursive: true, mode: HOME_MODE });
  return Promise.all(
    images.map(async ({ mediaType, dataBase64 }) => {
      const imagePath = join(sessionUploadsFolder, `${crypto.randomUUID()}.${IMAGE_FILE_EXTENSIONS[mediaType]}`);
      await Bun.write(imagePath, Buffer.from(dataBase64, "base64"));
      await chmod(imagePath, UPLOAD_FILE_MODE);
      return imagePath;
    }),
  );
};

export const sendToSession = async (sessionName: string, text: string, images: SentImage[]): Promise<Response> => {
  if (!heldSessions.has(sessionName)) return new Response(`no session ${sessionName}`, { status: 404 });
  const message = { text: buildMessageWithImages(text, await saveImages(sessionName, images)), hasImages: images.length > 0 };
  const session = heldSessions.get(sessionName);
  if (!session) return new Response(`no session ${sessionName}`, { status: 404 });
  if (session.summary.state === "starting") {
    heldSessions.set(sessionName, { ...session, queuedMessages: [...session.queuedMessages, message] });
  } else {
    applyLaneEvent(sessionName, { type: "person-typed", isTurnChanging: true });
    await typeIntoSession(session, message);
  }
  return new Response(null, { status: 204 });
};
