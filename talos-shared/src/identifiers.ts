import { LIMITS } from "./limits";
// Identifiers name things the same way everywhere (see docs/GLOSSARY.md):
// talos:machines:work-mac. The page address (/machines/work-mac) and the
// command (talos machines work-mac) are the same parts with other separators.

export const IDENTIFIER_ROOT = "talos";
const IDENTIFIER_SEPARATOR = ":";
const FALLBACK_NAME = "unnamed";

export const buildIdentifier = (parts: string[]): string => [IDENTIFIER_ROOT, ...parts].join(IDENTIFIER_SEPARATOR);

// The parts after "talos", or null if this isn't a Talos identifier.
export const parseIdentifier = (identifier: string): string[] | null => {
  const [root, ...parts] = identifier.split(IDENTIFIER_SEPARATOR);
  const isTalosIdentifier = root === IDENTIFIER_ROOT && parts.every((part) => part.length > 0);
  return isTalosIdentifier ? parts : null;
};

export const buildPagePath = (parts: string[]): string => `/${parts.map(encodeURIComponent).join("/")}`;

// Turns any text (a computer's name, a folder's name) into a name that's safe
// in identifiers, page addresses and commands: "Joe's MacBook Pro.local" → "joes-macbook-pro".
export const toIdentifierName = (text: string): string => {
  const withoutLocalSuffix = text.replace(/\.local$/i, "");
  const identifierName = withoutLocalSuffix
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LIMITS.maxIdentifierLength)
    .replace(/-+$/, "");
  return identifierName || FALLBACK_NAME;
};

// A name already in identifier form ("fix-login"), so it can't carry path
// pieces like "../.." or anything else unexpected into a command or a path.
export const isIdentifierName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && toIdentifierName(value) === value;

// Names are unique among siblings: a second "work-mac" becomes "work-mac-2".
export const pickUniqueName = (wantedName: string, takenNames: string[]): string => {
  const takenNameSet = new Set(takenNames);
  if (!takenNameSet.has(wantedName)) return wantedName;
  const firstFreeNumber = Array.from({ length: takenNames.length + 1 }, (_, index) => index + 2).find(
    (number) => !takenNameSet.has(`${wantedName}-${number}`),
  );
  return `${wantedName}-${firstFreeNumber}`;
};
