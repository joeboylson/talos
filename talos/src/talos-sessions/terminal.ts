// Bracketed paste: Claude Code takes the whole text as one message, even with
// line breaks, instead of sending at the first one. Enter then sends it.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
export const ENTER_KEY = "\r";
// Pressed before anything talos types: it says no to a permission prompt and
// does nothing in an empty input box. The pause keeps Claude Code from reading
// it and the paste that follows as one key.
export const ESC_KEY = "\x1b";
export const ESC_PAUSE_MS = 150;
export const buildPastedText = (text: string): string => `${PASTE_START}${removeControlCharacters(text)}${PASTE_END}`;

// Control characters would act as keys in Claude Code instead of text: one
// escape sequence ends the paste early and the rest gets typed as keystrokes
// (Enter, answers to permission prompts). Only line breaks and tabs stay.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
export const removeControlCharacters = (text: string): string => text.replace(CONTROL_CHARACTERS, "");

// Keys from an attached terminal that start the next turn: Enter sends a
// message, and Esc or Ctrl-C interrupts. Arrow keys, scrolling and other escape
// sequences don't, so they mustn't end a running asked-for turn.
const ESC_BYTE = 0x1b;
const CTRL_C_BYTE = 0x03;
// Esc and Ctrl-C as a terminal sends them once Claude Code turns on kitty or
// modifyOtherKeys key encoding.
const ENCODED_CTRL_C_KEYS = ["\x1b[99;5u", "\x1b[27;5;99~"];
const ENCODED_INTERRUPT_KEYS = ["\x1b[27u", ...ENCODED_CTRL_C_KEYS];
// What's pasted is text, whatever bytes it holds: a line break in it isn't
// Enter, and Option-Enter (Esc, Enter) only adds a line.
const PASTED = /\x1b\[200~[\s\S]*?(\x1b\[201~|$)/g;
const keysOutsidePastes = (keys: Uint8Array): string => new TextDecoder().decode(keys).replace(PASTED, "").replaceAll("\x1b\r", "");

export const isTurnChangingKeys = (keys: Uint8Array): boolean => {
  const isOnlyEsc = keys.length > 0 && keys.every((byte) => byte === ESC_BYTE);
  const keysText = keysOutsidePastes(keys);
  const hasEncodedInterrupt = ENCODED_INTERRUPT_KEYS.some((sequence) => keysText.includes(sequence));
  return keysText.includes("\r") || keysText.includes("\x03") || isOnlyEsc || hasEncodedInterrupt;
};

// Keys that stop Claude Code's running turn: Esc or Ctrl-C. It sends no Stop
// for an interrupted turn, so these end it.
export const isInterruptKeys = (keys: Uint8Array): boolean => {
  const keysText = new TextDecoder().decode(keys);
  const isOnlyEsc = keys.length > 0 && keys.every((byte) => byte === ESC_BYTE);
  return isOnlyEsc || keys.includes(CTRL_C_BYTE) || ENCODED_INTERRUPT_KEYS.some((sequence) => keysText.includes(sequence));
};

// The session runner guesses whether the input box holds unsent text from the keys sent
// to it, since it can't see the box.
// shortcut: a few edits fool the guess (Backspace back to empty, Ctrl-W, undo,
// backslash then Enter), so a draft untouched for a while stops counting (see
// SESSION_LIMITS.draftForgetMs); upgrade by reading the box from the screen output.

// Keys that put text in the input box: typing, a paste, or Up and Down, which
// recall an old message. Other arrow keys and the reports a terminal sends on
// its own (focus in or out, cursor position) are escape sequences and don't. A
// chunk can hold several keys, so any text left after removing the escape
// sequences counts.
const DRAFT_ESCAPE_KEYS = [PASTE_START, "\x1b[A", "\x1b[B", "\x1bOA", "\x1bOB"];
const ESCAPE_SEQUENCE = /\x1b(\[[0-9;:?<>=]*[ -\/]*[@-~]|O[@-~]|\][^\x07]*\x07|[ -~])?/g;
const FIRST_TEXT_CHARACTER = 0x20;
// Backspace (0x7f) takes text away, so it can't make a draft.
const BACKSPACE_CHARACTER = 0x7f;
export const isDraftChangingKeys = (keys: Uint8Array): boolean => {
  const keysText = new TextDecoder().decode(keys).replace(`${PASTE_START}${PASTE_END}`, "");
  if (DRAFT_ESCAPE_KEYS.some((sequence) => keysText.includes(sequence))) return true;
  const textKeys = keysText.replace(ESCAPE_SEQUENCE, "");
  return [...textKeys].some((character) => character.charCodeAt(0) >= FIRST_TEXT_CHARACTER && character.charCodeAt(0) !== BACKSPACE_CHARACTER);
};

// Keys that empty the input box: Enter sends it and Ctrl-C clears it. Judged by
// the last key, since a paste can hold a line break and still leave a draft.
// Esc then Enter (Option-Enter) only adds a line.
// Ctrl-U deletes the line, and Esc twice clears the box.
const CTRL_U = "\x15";
export const isDraftClearingKeys = (keys: Uint8Array): boolean => {
  const keysText = keysOutsidePastes(keys);
  const endsWithSend = new TextDecoder().decode(keys).endsWith("\r") && keysText.endsWith("\r");
  const endsWithCtrlC = keys.at(-1) === CTRL_C_BYTE || ENCODED_CTRL_C_KEYS.some((sequence) => keysText.endsWith(sequence));
  return endsWithSend || endsWithCtrlC || keysText.endsWith(CTRL_U) || keysText.endsWith("\x1b\x1b");
};

// The message typed into Claude Code: the text, then each image's saved path.
// Claude Code turns a pasted image path into an attached image.
export const buildMessageWithImages = (text: string, imagePaths: string[]): string =>
  [text.trim(), ...imagePaths].filter(Boolean).join("\n\n");

// Keeps the most recent output, so someone attaching sees the current screen.
// Where it's cut, it starts at the next escape code or line (within a few KB),
// so the screen never begins with half of one shown as text; failing that,
// past any half of a character.
const CLEAN_START_SEARCH_BYTES = 4096;
const cleanStart = (cut: Uint8Array): number => {
  const searched = cut.subarray(0, CLEAN_START_SEARCH_BYTES);
  const escAt = searched.indexOf(0x1b);
  const lineAt = searched.indexOf(0x0a);
  const starts = [escAt, lineAt === -1 ? -1 : lineAt + 1].filter((at) => at >= 0);
  if (starts.length > 0) return Math.min(...starts);
  const firstWhole = searched.findIndex((byte) => (byte & 0xc0) !== 0x80);
  return firstWhole === -1 ? 0 : firstWhole;
};
export const appendOutput = (output: Uint8Array, chunk: Uint8Array, maxBytes: number): Uint8Array => {
  const combined = new Uint8Array(output.length + chunk.length);
  combined.set(output);
  combined.set(chunk, output.length);
  if (combined.length <= maxBytes) return combined;
  const cut = combined.subarray(combined.length - maxBytes);
  return cut.slice(cleanStart(cut));
};

// A Ctrl key as a terminal sends it: its byte, or once Claude Code turns on
// kitty or modifyOtherKeys key encoding, a sequence naming the key.
export const isCtrlKey = (keys: Uint8Array, ctrlByte: number): boolean => {
  const base = ctrlByte | 0x40;
  const keyCode = base >= 0x41 && base <= 0x5a ? base | 0x20 : base;
  const keysText = new TextDecoder().decode(keys);
  return keys.includes(ctrlByte) || keysText.includes(`\x1b[${keyCode};5u`) || keysText.includes(`\x1b[27;5;${keyCode}~`);
};

// Turns off what Claude Code turned on in a terminal attached to it: kitty
// keys, bracketed paste, focus reports, mouse reports, the other screen, and a
// hidden cursor. Written when someone detaches, so their shell works as before.
export const TERMINAL_RESET = "\x1b[<u\x1b[?2004l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h";
