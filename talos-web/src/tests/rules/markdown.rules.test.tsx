import { expect, test } from "bun:test";
import fc from "fast-check";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownText } from "../../components/markdown-text";

const PIECES = [
  "<script>alert(1)</script>", "<SCRIPT src=x></SCRIPT>", "<img src=x onerror=alert(1)>", "<iframe src=javascript:alert(1)>",
  "<a href=\"javascript:alert(1)\">x</a>", "[x](javascript:alert(1))", "[x](JaVaScRiPt:alert(1))", "[x]( javascript:alert(1) )",
  "[x](java\tscript:alert(1))", "[x](&#106;avascript:alert(1))", "[x](%6Aavascript:alert(1))", "![i](javascript:alert(1))",
  "[x](vbscript:msgbox(1))", "[x](data:text/html,<script>alert(1)</script>)", "<javascript:alert(1)>",
  "[x][r]\n\n[r]: javascript:alert(1)", "www.example.com", "https://example.com", "[ok](https://example.com)",
  "\n", "\n\n", " ", "`", "```", "*", "<", ">", "[", "]", "(", ")", "\"", "'", "|", "-", "#", "javascript:", "on", "=",
];

const markdown = fc.array(fc.oneof(fc.constantFrom(...PIECES), fc.string({ maxLength: 6 })), { maxLength: 12 }).map((p) => p.join(""));

const decode = (value: string) =>
  value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

const isUnsafeUrl = (url: string) => {
  const plain = decodeURIComponent(decode(url).replace(/%(?![0-9a-f]{2})/gi, "%25")).replace(/[\s\u0000-\u001f]/g, "").toLowerCase();
  return /^(javascript|vbscript|data):/.test(plain);
};

test("a session's text never becomes page code", () => {
  fc.assert(
    fc.property(markdown, (text) => {
      const html = renderToStaticMarkup(<MarkdownText text={text} />);
      expect(html).not.toMatch(/<(script|iframe|object|embed|style)\b/i);
      expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
      const urls = [...html.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1]!);
      expect(urls.filter(isUnsafeUrl)).toEqual([]);
    }),
    { seed: 20261127, numRuns: 3000 },
  );
});

test("every link opens in a new tab without a referrer", () => {
  fc.assert(
    fc.property(markdown, (text) => {
      const html = renderToStaticMarkup(<MarkdownText text={text} />);
      [...html.matchAll(/<a\s[^>]*>/g)].forEach(([tag]) => {
        expect(tag).toContain('target="_blank"');
        expect(tag).toContain('rel="noreferrer"');
      });
    }),
    { seed: 20261128, numRuns: 1000 },
  );
});
