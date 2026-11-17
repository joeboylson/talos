import { timingSafeEqual } from "node:crypto";
import { BEARER_PREFIX } from "talos-shared";

// Compares in constant time so the key can't be guessed one character at a time.
export const isMachineKeyValid = (authorizationHeader: string | null, expectedKey: string): boolean => {
  if (!authorizationHeader?.startsWith(BEARER_PREFIX)) return false;
  if (expectedKey.length === 0) return false;

  const givenKeyBytes = Buffer.from(authorizationHeader.slice(BEARER_PREFIX.length));
  const expectedKeyBytes = Buffer.from(expectedKey);
  const hasSameLength = givenKeyBytes.length === expectedKeyBytes.length;
  return hasSameLength && timingSafeEqual(givenKeyBytes, expectedKeyBytes);
};
