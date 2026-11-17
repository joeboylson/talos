import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { RANDOM_SECRET_BYTES } from "../constants";

// Compares in constant time so a secret can't be guessed one character at a time.
export const isSameSecret = (given: string, expected: string): boolean => {
  const givenBytes = Buffer.from(given);
  const expectedBytes = Buffer.from(expected);
  const hasSameLength = givenBytes.length === expectedBytes.length;
  return hasSameLength && timingSafeEqual(givenBytes, expectedBytes);
};

export const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

export const signText = (text: string, signingSecret: string): string =>
  createHmac("sha256", signingSecret).update(text).digest("base64url");

export const createRandomSecret = (): string => randomBytes(RANDOM_SECRET_BYTES).toString("base64url");
