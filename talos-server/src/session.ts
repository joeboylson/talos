import { parseJsonOrNull } from "talos-shared";
import { isSameSecret, signText } from "./utils/crypto";

export type SessionPerson = { personId: string; signInId: string; displayName: string };

// A session is "<payload>.<signature>". Only the server knows the signing
// secret, so a browser can't make or change one.
export const createSessionToken = (person: SessionPerson, expiresAtMs: number, sessionSecret: string): string => {
  const payloadText = Buffer.from(JSON.stringify({ ...person, expiresAtMs })).toString("base64url");
  return `${payloadText}.${signText(payloadText, sessionSecret)}`;
};

export const readSessionPerson = (
  sessionToken: string | null,
  sessionSecret: string,
  nowMs: number,
): SessionPerson | null => {
  const [payloadText, signature, ...extraParts] = sessionToken?.split(".") ?? [];
  if (!payloadText || !signature || extraParts.length > 0) return null;
  if (!isSameSecret(signature, signText(payloadText, sessionSecret))) return null;

  const payload = parseJsonOrNull(Buffer.from(payloadText, "base64url").toString());
  if (!isSessionPayload(payload)) return null;
  if (payload.expiresAtMs <= nowMs) return null;
  const { personId, signInId, displayName } = payload;
  return { personId, signInId, displayName };
};

type SessionPayload = SessionPerson & { expiresAtMs: number };

const isSessionPayload = (value: unknown): value is SessionPayload => {
  const isObject = typeof value === "object" && value !== null;
  return (
    isObject &&
    typeof Reflect.get(value, "personId") === "string" &&
    typeof Reflect.get(value, "signInId") === "string" &&
    typeof Reflect.get(value, "displayName") === "string" &&
    typeof Reflect.get(value, "expiresAtMs") === "number"
  );
};
