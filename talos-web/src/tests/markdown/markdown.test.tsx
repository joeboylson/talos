import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownText } from "../../components/markdown-text";

const render = (text: string) => renderToStaticMarkup(<MarkdownText text={text} />);

test("raw HTML shows as text", () => {
  const html = render("<script>alert(1)</script> <img src=x onerror=alert(1)>");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;");
});

test("a javascript: link loses its address", () => {
  expect(render("[x](javascript:alert(1))")).toContain('href=""');
});

test("links open in a new tab without a referrer", () => {
  expect(render("[docs](https://example.com)")).toContain('<a href="https://example.com" target="_blank" rel="noreferrer">docs</a>');
});
