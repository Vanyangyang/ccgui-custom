import { useDeferredValue, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Streamdown, type StreamdownTranslations } from "streamdown";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { cjk } from "@streamdown/cjk";
import "katex/dist/katex.min.css";
import { fileUrl, openExternal } from "@/lib/platform";

// Plugins are stateless singletons; a module-level reference keeps the
// Streamdown `plugins` prop stable across renders.
const PLUGINS = { code, math, mermaid, cjk };

const BROWSER_LOADABLE_SRC_RE = /^(?:https?:|data:|blob:|asset:)/i;

function normalizePathSegments(path: string): string {
  const isAbsolute = /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(path);
  const segments = path.split(/[\\/]+/);
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbsolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  if (isAbsolute) {
    const prefix = /^[a-zA-Z]:/.test(path) ? "" : "/";
    return prefix + joined;
  }
  return joined;
}

/** Local relative image src → absolute path next to the markdown file. */
function resolveMarkdownImageSrc(src: string, sourceFilePath: string): string {
  let cleaned: string;
  try {
    cleaned = decodeURIComponent(src);
  } catch {
    cleaned = src;
  }
  if (BROWSER_LOADABLE_SRC_RE.test(cleaned)) return cleaned;
  if (!/\.(?:apng|avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(cleaned)) {
    return cleaned;
  }
  const pathOnly = cleaned.replace(/[?#].*$/, "");
  if (/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(pathOnly)) {
    return fileUrl(normalizePathSegments(pathOnly));
  }
  const sepIdx = Math.max(
    sourceFilePath.lastIndexOf("/"),
    sourceFilePath.lastIndexOf("\\"),
  );
  if (sepIdx <= 0) return cleaned;
  try {
    return fileUrl(
      normalizePathSegments(`${sourceFilePath.slice(0, sepIdx)}/${pathOnly}`),
    );
  } catch {
    return cleaned;
  }
}

export function MarkdownPreview({ path, draft }: { path: string; draft: string }) {
  const { t } = useTranslation();
  // Preview parses a deferred copy of the draft: re-parsing the whole
  // document per keystroke would jank typing.
  const deferredDraft = useDeferredValue(draft);
  const components = useMemo(
    () => ({
      // Local relative image paths must resolve next to the markdown file;
      // Streamdown's default <img> would pass the raw relative src through.
      img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
        <img
          {...props}
          src={props.src ? resolveMarkdownImageSrc(String(props.src), path) : props.src}
          className="max-w-full"
        />
      ),
      a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
        const href = props.href ?? "";
        if (/^https?:/i.test(href)) {
          return (
            <a
              {...props}
              href={href}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openExternal(href);
              }}
            />
          );
        }
        return <a {...props} />;
      },
    }),
    [path],
  );
  const translations = useMemo<Partial<StreamdownTranslations>>(
    () => ({
      close: t("files.markdown.close"),
      copied: t("files.markdown.copied"),
      copyCode: t("files.markdown.copyCode"),
      copyTable: t("files.markdown.copyTable"),
      copyTableAsCsv: t("files.markdown.copyTableAsCsv"),
      copyTableAsMarkdown: t("files.markdown.copyTableAsMarkdown"),
      copyTableAsTsv: t("files.markdown.copyTableAsTsv"),
      downloadDiagram: t("files.markdown.downloadDiagram"),
      downloadDiagramAsMmd: t("files.markdown.downloadDiagramAsMmd"),
      downloadDiagramAsPng: t("files.markdown.downloadDiagramAsPng"),
      downloadDiagramAsSvg: t("files.markdown.downloadDiagramAsSvg"),
      downloadFile: t("files.markdown.downloadFile"),
      downloadImage: t("files.markdown.downloadImage"),
      downloadTable: t("files.markdown.downloadTable"),
      downloadTableAsCsv: t("files.markdown.downloadTableAsCsv"),
      downloadTableAsMarkdown: t("files.markdown.downloadTableAsMarkdown"),
      exitFullscreen: t("files.markdown.exitFullscreen"),
      imageNotAvailable: t("files.markdown.imageNotAvailable"),
      resetView: t("files.markdown.resetView"),
      viewFullscreen: t("files.markdown.viewFullscreen"),
      zoomIn: t("files.markdown.zoomIn"),
      zoomOut: t("files.markdown.zoomOut"),
    }),
    [t],
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4 text-body-medium text-text-primary">
      <Streamdown
        mode="static"
        plugins={PLUGINS}
        components={components}
        translations={translations}
        // External links are handed to the OS browser above; Streamdown's
        // link-safety modal would be a second, redundant gate.
        linkSafety={{ enabled: false }}
      >
        {deferredDraft}
      </Streamdown>
    </div>
  );
}
