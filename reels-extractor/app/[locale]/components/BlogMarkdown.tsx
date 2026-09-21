import type { ReactNode } from "react";
import { localePath, locales, type Locale } from "@/lib/i18n-config";
import { parseMarkdown, type Block, type Inline } from "@/lib/blog-markdown";

/** A site-relative link in a post points at the same language's page: "/youtube-video-downloader" -> "/hi/youtube-...". */
function href(target: string, locale: Locale): string {
  const alreadyPrefixed = locales.some((l) => target === `/${l}` || target.startsWith(`/${l}/`));
  if (!target.startsWith("/") || alreadyPrefixed) return target;
  return localePath(locale, target === "/" ? "" : target);
}

function inline(nodes: Inline[], locale: Locale): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "strong":
        return (
          <strong key={index} className="font-semibold text-zinc-100">
            {inline(node.children, locale)}
          </strong>
        );
      case "em":
        return <em key={index}>{inline(node.children, locale)}</em>;
      case "code":
        return (
          <code key={index} className="rounded bg-white/10 px-1.5 py-0.5 text-[0.9em] text-zinc-100">
            {node.text}
          </code>
        );
      case "link": {
        const external = node.href.startsWith("https://");
        return (
          <a
            key={index}
            href={href(node.href, locale)}
            {...(external ? { rel: "noopener noreferrer" } : {})}
            className="text-brand-300 underline decoration-brand-500/40 underline-offset-2 transition hover:text-brand-400"
          >
            {inline(node.children, locale)}
          </a>
        );
      }
    }
  });
}

function block(item: Block, index: number, locale: Locale): ReactNode {
  switch (item.type) {
    case "heading": {
      const Tag = `h${item.level}` as "h2" | "h3" | "h4";
      const style =
        item.level === 2
          ? "mt-10 scroll-mt-24 text-2xl font-bold tracking-tight text-zinc-50"
          : item.level === 3
            ? "mt-8 scroll-mt-24 text-lg font-semibold text-zinc-100"
            : "mt-6 scroll-mt-24 text-base font-semibold text-zinc-100";
      return (
        <Tag key={index} id={item.id} className={style}>
          {inline(item.children, locale)}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={index} className="mt-4 leading-relaxed text-zinc-300">
          {inline(item.children, locale)}
        </p>
      );
    case "list": {
      const Tag = item.ordered ? "ol" : "ul";
      return (
        <Tag key={index} className={`mt-4 space-y-2 ps-6 leading-relaxed text-zinc-300 ${item.ordered ? "list-decimal" : "list-disc"}`}>
          {item.items.map((entry, i) => (
            <li key={i}>{inline(entry, locale)}</li>
          ))}
        </Tag>
      );
    }
    case "quote":
      return (
        <blockquote key={index} className="mt-6 border-s-2 border-brand-500/60 ps-4 italic leading-relaxed text-zinc-400">
          {inline(item.children, locale)}
        </blockquote>
      );
    case "rule":
      return <hr key={index} className="my-8 border-white/10" />;
    case "code":
      return (
        <pre key={index} className="mt-4 overflow-x-auto rounded-xl bg-white/5 p-4 text-sm text-zinc-200">
          <code>{item.text}</code>
        </pre>
      );
    case "table":
      return (
        <div key={index} className="glass mt-6 overflow-x-auto rounded-2xl">
          <table className="w-full min-w-[32rem] border-collapse text-start text-sm">
            <thead>
              <tr className="border-b border-white/10 text-zinc-100">
                {item.head.map((cell, i) => (
                  <th key={i} scope="col" className="px-4 py-3 text-start font-semibold">
                    {inline(cell, locale)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {item.rows.map((row, r) => (
                <tr key={r} className="border-b border-white/5 last:border-0">
                  {row.map((cell, c) => (
                    <td key={c} className="px-4 py-3 align-top">
                      {inline(cell, locale)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export default function BlogMarkdown({ source, locale }: { source: string; locale: Locale }) {
  return <>{parseMarkdown(source).map((item, index) => block(item, index, locale))}</>;
}
