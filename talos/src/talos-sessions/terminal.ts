// Bracketed paste: Claude Code takes the whole text as one message, even with
// line breaks, instead of sending at the first one. Enter then sends it.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
export const ENTER_KEY = "\r";
export const buildPastedText = (text: string): string => `${PASTE_START}${removeControlCharacters(text)}${PASTE_END}`;

// Control characters would act as keys in Claude Code instead of text: one
// escape sequence ends the paste early and the rest gets typed as keystrokes
// (Enter, answers to permission prompts). Only line breaks and tabs stay.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
export const removeControlCharacters = (text: string): string => text.replace(CONTROL_CHARACTERS, "");

// Keys from an attached terminal that start the next turn: Enter sends a
// message, and Esc or Ctrl-C interrupts. Arrow keys, scrolling and other escape
// sequences don't, so they mustn't end a running asked-for turn.
const ENTER_BYTE = 0x0d;
const ESC_BYTE = 0x1b;
const CTRL_C_BYTE = 0x03;
// Esc and Ctrl-C as a terminal sends them once Claude Code turns on kitty or
// modifyOtherKeys key encoding.
const ENCODED_CTRL_C_KEYS = ["\x1b[99;5u", "\x1b[27;5;99~"];
const ENCODED_INTERRUPT_KEYS = ["\x1b[27u", ...ENCODED_CTRL_C_KEYS];
export const isTurnChangingKeys = (keys: Uint8Array): boolean => {
  const isOnlyEsc = keys.length > 0 && keys.every((byte) => byte === ESC_BYTE);
  const keysText = new TextDecoder().decode(keys);
  const hasEncodedInterrupt = ENCODED_INTERRUPT_KEYS.some((sequence) => keysText.includes(sequence));
  return keys.includes(ENTER_BYTE) || keys.includes(CTRL_C_BYTE) || isOnlyEsc || hasEncodedInterrupt;
};

// The session runner guesses whether the input box holds unsent text from the keys sent
// to it, since it can't see the box.
// shortcut: a few edits fool the guess (Backspace back to empty, Enter in a menu
// or permission prompt, backslash then Enter); upgrade by reading the box from
// the screen output.

// Keys that put text in the input box: typing, a paste, or Up and Down, which
// recall an old message. Other arrow keys and the reports a terminal sends on
// its own (focus in or out, cursor position) are escape sequences and don't. A
// chunk can hold several keys, so any text left after removing the escape
// sequences counts.
const DRAFT_ESCAPE_KEYS = [PASTE_START, "\x1b[A", "\x1b[B", "\x1bOA", "\x1bOB"];
const ESCAPE_SEQUENCE = /\x1b(\[[0-9;:?<>=]*[ -\/]*[@-~]|O[@-~]|\][^\x07]*\x07|[ -~])?/g;
const FIRST_TEXT_CHARACTER = 0x20;
export const isDraftChangingKeys = (keys: Uint8Array): boolean => {
  const keysText = new TextDecoder().decode(keys);
  if (DRAFT_ESCAPE_KEYS.some((sequence) => keysText.includes(sequence))) return true;
  const textKeys = keysText.replace(ESCAPE_SEQUENCE, "");
  return [...textKeys].some((character) => character.charCodeAt(0) >= FIRST_TEXT_CHARACTER);
};

// Keys that empty the input box: Enter sends it and Ctrl-C clears it. Judged by
// the last key, since a paste can hold a line break and still leave a draft.
// Esc then Enter (Option-Enter) only adds a line.
export const isDraftClearingKeys = (keys: Uint8Array): boolean => {
  const keysText = new TextDecoder().decode(keys);
  const endsWithSend = keysText.endsWith("\r") && !keysText.endsWith("\x1b\r");
  const endsWithCtrlC = keys.at(-1) === CTRL_C_BYTE || ENCODED_CTRL_C_KEYS.some((sequence) => keysText.endsWith(sequence));
  return endsWithSend || endsWithCtrlC;
};

// The message typed into Claude Code: the text, then each image's saved path.
// Claude Code turns a pasted image path into an attached image.
export const buildMessageWithImages = (text: string, imagePaths: string[]): string =>
  [text.trim(), ...imagePaths].filter(Boolean).join("\n\n");

// Keeps the most recent output, so someone attaching sees the current screen.
export const appendOutput = (output: Uint8Array, chunk: Uint8Array, maxBytes: number): Uint8Array => {
  const combined = new Uint8Array(output.length + chunk.length);
  combined.set(output);
  combined.set(chunk, output.length);
  return combined.length > maxBytes ? combined.slice(combined.length - maxBytes) : combined;
};
