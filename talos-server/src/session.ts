import { parseJsonOrNull } from "talos-shared";
import { isSameSecret, signText } from "./utils/crypto";

export type SessionPerson = { personId: string; signInId: string; displayName: string };

// What a session cookie says: who, when it was made, and the sign-in's
// sign-out count then. Signing out everywhere bumps the count, which ends every
// older session, even a copied cookie, whatever any clock says.
export type SessionClaim = SessionPerson & SessionStamp;

type SessionStamp = { issuedAtMs: number; expiresAtMs: number; signOutCount: number };

// A session is "<payload>.<signature>". Only the server knows the signing
// secret, so a browser can't make or change one.
export const createSessionToken = (person: SessionPerson, times: SessionStamp, sessionSecret: string): string => {
  const payloadText = Buffer.from(JSON.stringify({ ...person, ...times })).toString("base64url");
  return `${payloadText}.${signText(payloadText, sessionSecret)}`;
};

export const readSessionClaim = (
  sessionToken: string | null,
  sessionSecret: string,
  nowMs: number,
): SessionClaim | null => {
  const [payloadText, signature, ...extraParts] = sessionToken?.split(".") ?? [];
  if (!payloadText || !signature || extraParts.length > 0) return null;
  if (!isSameSecret(signature, signText(payloadText, sessionSecret))) return null;

  const payload = parseJsonOrNull(Buffer.from(payloadText, "base64url").toString());
  if (!isSessionPayload(payload)) return null;
  if (payload.expiresAtMs <= nowMs) return null;
  const { personId, signInId, displayName, signOutCount, issuedAtMs, expiresAtMs } = payload;
  return { personId, signInId, displayName, signOutCount, issuedAtMs, expiresAtMs };
};

type SessionPayload = SessionClaim;

const isSessionPayload = (value: unknown): value is SessionPayload => {
  const isObject = typeof value === "object" && value !== null;
  return (
    isObject &&
    typeof Reflect.get(value, "personId") === "string" &&
    typeof Reflect.get(value, "signInId") === "string" &&
    typeof Reflect.get(value, "displayName") === "string" &&
    typeof Reflect.get(value, "expiresAtMs") === "number" &&
    typeof Reflect.get(value, "issuedAtMs") === "number" &&
    Number.isSafeInteger(Reflect.get(value, "signOutCount"))
  );
};
