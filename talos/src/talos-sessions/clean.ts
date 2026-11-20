import { removeControlCharacters } from "./terminal";

// Text from a session lands in a shared table row, a card and the logs, so it
// can't carry terminal escapes, line breaks, or characters that hide or reorder
// text: format characters (zero-width, bidi, tags), the Hangul fillers that show
// as blank, and combining marks with nothing before them.
const INVISIBLE_CHARACTERS = /[\p{Cf}ᅟᅠㅤﾠ]/gu;
const LEADING_MARKS = /^\p{M}+/u;
export const cleanLine = (text: string): string =>
  removeControlCharacters(text).replace(INVISIBLE_CHARACTERS, "").replace(/\s+/g, " ").trim().replace(LEADING_MARKS, "");

// Shown text must say something a person can read.
export const saysSomething = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);

// Text typed into a session as the person's own message, which Claude Code acts
// on: / runs a slash command or skill, ! a shell command, # a memory note (at
// the start), and @ attaches a file, / a skill (anywhere after a space).
// Check it on cleaned text, which is what gets typed.
export const hasCommandMarker = (text: string): boolean => /(^|\s)[@/!#]/.test(text);
