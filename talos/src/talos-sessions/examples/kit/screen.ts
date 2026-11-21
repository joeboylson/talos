// Drawing in the terminal with its own colours (the basic ANSI ones, which each
// terminal's theme picks), so an example looks right in light and dark.
const wrap = (code: number, reset: number) => (text: string): string => `\x1b[${code}m${text}\x1b[${reset}m`;

export const dim = wrap(2, 22);
export const bold = wrap(1, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);

const ANSI = /\x1b\[[0-9;]*m/g;
export const visibleLength = (text: string): number => text.replace(ANSI, "").length;

export const padTo = (text: string, width: number): string => text + " ".repeat(Math.max(width - visibleLength(text), 0));

// Cut to the terminal's width. Only plain text is cut, so a colour can't be
// left open.
export const fit = (text: string, width: number): string => (text.length > width ? `${text.slice(0, Math.max(width - 1, 0))}…` : text);

// A bar of █ for value out of most, width cells wide at most, with ▌ for a half.
export const bar = (value: number, most: number, width: number): string => {
  if (most <= 0 || value <= 0) return "";
  const halves = Math.round((value / most) * width * 2);
  return "█".repeat(Math.floor(halves / 2)) + (halves % 2 ? "▌" : "");
};
