import { USER_CODE_ALPHABET, USER_CODE_GROUP_LENGTH } from "./constants";

const USER_CODE_LENGTH = USER_CODE_GROUP_LENGTH * 2;

// The alphabet has 32 letters, which divides 256 evenly, so every letter is
// equally likely.
export const buildUserCode = (randomBytes: Uint8Array): string => {
  const letters = [...randomBytes.slice(0, USER_CODE_LENGTH)].map(
    (randomByte) => USER_CODE_ALPHABET[randomByte % USER_CODE_ALPHABET.length],
  );
  return formatUserCode(letters.join(""));
};

// Accepts what someone types: any case, with or without the dash or spaces.
export const normalizeUserCode = (typedCode: string): string =>
  formatUserCode(typedCode.toUpperCase().replace(/[^A-Z0-9]/g, ""));

const formatUserCode = (letters: string): string =>
  `${letters.slice(0, USER_CODE_GROUP_LENGTH)}-${letters.slice(USER_CODE_GROUP_LENGTH)}`;

export const createUserCode = (): string =>
  buildUserCode(crypto.getRandomValues(new Uint8Array(USER_CODE_LENGTH)));
