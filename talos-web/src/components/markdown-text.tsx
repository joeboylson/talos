import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Claude writes Markdown. Raw HTML in it shows as text, never as page code.
const MARKDOWN_STYLES = [
  "text-sm leading-relaxed break-words",
  "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5",
  "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-semibold",
  "[&_a]:underline [&_a]:underline-offset-2",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:px-2 [&_td]:py-1",
].join(" ");

export const MarkdownText = ({ text }: { text: string }) => (
  <div className={MARKDOWN_STYLES}>
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{ a: ({ node: _node, ...linkProps }) => <a {...linkProps} target="_blank" rel="noreferrer" /> }}
    >
      {text}
    </Markdown>
  </div>
);
