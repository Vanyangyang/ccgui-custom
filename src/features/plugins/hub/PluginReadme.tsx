import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Pluggable } from "unified";
import { openExternal } from "@/lib/platform";
import { resolveReadmeUrl } from "./catalog";

/**
 * Sanitize posture mirrors the file preview (MarkdownPreview.tsx): parse raw
 * HTML so README badges, <details> and centered blocks survive, sanitize the
 * result, then highlight — last, so its token classes are not stripped.
 * `align`/`className` pass sanitization because GitHub READMEs center hero
 * images with them.
 */
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS: Pluggable[] = [
  rehypeRaw,
  [
    rehypeSanitize,
    {
      ...defaultSchema,
      tagNames: [
        ...(defaultSchema.tagNames ?? []),
        "details",
        "summary",
        "abbr",
        "mark",
        "ins",
        "del",
        "sub",
        "sup",
        "kbd",
        "var",
        "samp",
      ],
      attributes: {
        ...defaultSchema.attributes,
        "*": [...(defaultSchema.attributes?.["*"] ?? []), "className", "class", "align"],
      },
    },
  ],
  rehypeHighlight,
];

/**
 * Long-form plugin intro: the repository README rendered as a document.
 * Relative URLs are resolved against the plugin repo (`image` → raw file,
 * `link` → GitHub blob page), and only http(s) links leave the app. Reuses
 * the chat markdown typography scope (`.prose-chat`, which owns headings,
 * tables, code blocks and hljs tokens; `prose-plugin-readme` then owns the
 * README-only bits, e.g. the horizontal scroll on a bare <pre>). The first h1
 * is hidden because the detail hero already shows the plugin name.
 */
export const PluginReadme = memo(function PluginReadme({
  markdown,
  repo,
}: {
  markdown: string;
  repo: string;
}) {
  const components = useMemo<Components>(
    () => ({
      a: ({ node: _node, href, children, ...rest }) => {
        const url = href ?? "";
        if (!/^https?:/i.test(url)) {
          return <a {...rest} href={url}>{children}</a>;
        }
        return (
          <a
            {...rest}
            href={url}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openExternal(url);
            }}
          >
            {children}
          </a>
        );
      },
      img: ({ node: _node, alt, ...rest }) => (
        // Lazy: READMEs can carry many badges; only the visible ones load.
        <img {...rest} alt={alt ?? ""} loading="lazy" />
      ),
    }),
    [],
  );

  return (
    <div className="prose-chat prose-plugin-readme text-body-regular text-text-primary [&>h1:first-child]:hidden">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        urlTransform={(url, key) =>
          resolveReadmeUrl(url, key === "src" ? "image" : "link", repo)
        }
        components={components}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
});
