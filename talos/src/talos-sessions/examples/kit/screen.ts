// Drawing in the terminal with its own colours (the basic ANSI ones, which each
// terminal's theme picks), so an example looks right in light and dark.
const wrap = (code: number, reset: number) => (text: string): string => `\x1b[${code}m${text}\x1b[${reset}m`;

export const dim = wrap(2, 22);
export const bold = wrap(1, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);

// How many cells a line takes: colours take none, wide characters (like CJK) two.
export const visibleLength = (text: string): number => Bun.stringWidth(text);

export const padTo = (text: string, width: number): string => text + " ".repeat(Math.max(width - visibleLength(text), 0));

const COLOUR_AT_START = /^\x1b\[[0-9;]*m/;
const RESET = "\x1b[0m";

// Cut to width cells, with … where it was cut. Colours are kept whole and take
// no room, and a cut line ends with a reset, so a colour can't be left open.
export const fit = (text: string, width: number): string => {
  if (visibleLength(text) <= width) return text;
  const cut = (rest: string, room: number, kept: string): string => {
    const colour = COLOUR_AT_START.exec(rest)?.[0];
    if (colour) return cut(rest.slice(colour.length), room, kept + colour);
    const [character] = rest;
    if (character === undefined || visibleLength(character) > room) return kept;
    return cut(rest.slice(character.length), room - visibleLength(character), kept + character);
  };
  return `${cut(text, Math.max(width - 1, 0), "")}${RESET}…`;
};

// What a view draws, as the terminal shows it: no line wider than the terminal
// (a wrapped line would scroll the top off), and the newest lines that fit, so
// the conversation scrolls up as it grows.
export const fitScreen = (lines: readonly string[], columns: number, rows: number): string[] =>
  lines.slice(-rows).map((line) => fit(line, columns));

// A bar of █ for value out of most, width cells wide at most, with ▌ for a half.
export const bar = (value: number, most: number, width: number): string => {
  if (most <= 0 || value <= 0) return "";
  const halves = Math.round((value / most) * width * 2);
  return "█".repeat(Math.floor(halves / 2)) + (halves % 2 ? "▌" : "");
};
