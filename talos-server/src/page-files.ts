import tailwindPlugin from "bun-plugin-tailwind";
import { PAGE_ASSETS_ROUTE } from "./constants";

// The page, built once when the server starts, so the server can send each
// file itself, with its own security headers. (Bun's built-in page serving
// can't add headers.) Development keeps Bun's own serving, for live reload.
export type PageFiles = { pageHtml: Blob; assetsByPath: Map<string, Blob> };

export const buildPageFiles = async (pageEntryPath: string): Promise<PageFiles> => {
  const build = await Bun.build({
    entrypoints: [pageEntryPath],
    plugins: [tailwindPlugin],
    minify: true,
    publicPath: `${PAGE_ASSETS_ROUTE}/`,
  });
  if (!build.success) throw new AggregateError(build.logs, "the page didn't build");

  const pageHtml = build.outputs.find((output) => output.path.endsWith(".html"));
  if (!pageHtml) throw new Error("the page build has no HTML file");
  const assets = build.outputs.filter((output) => output !== pageHtml);
  const assetsByPath = new Map(assets.map((asset) => [`${PAGE_ASSETS_ROUTE}/${asset.path.replace(/^\.\//, "")}`, asset as Blob]));
  return { pageHtml, assetsByPath };
};
