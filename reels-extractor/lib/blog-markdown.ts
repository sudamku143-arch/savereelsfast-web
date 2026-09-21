// A small, safe Markdown reader for blog posts. It produces plain data (no HTML strings), which the page turns into
// React elements, so nothing a post contains can inject markup or script. Kept free of imports so plain Node can test it.
//
// Supported: ## / ### / #### headings (a single # is treated as ##: the page title is the only h1), paragraphs,
// **bold**, *italic*, `code`, [links](url), bullet and numbered lists, > quotes, --- rules, ``` code blocks and
// simple | tables |.

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "heading"; level: 2 | 3 | 4; children: Inline[]; id: string }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "quote"; children: Inline[] }
  | { type: "rule" }
  | { type: "code"; text: string }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] };

/** Only site-relative paths, https and mailto links are kept; anything else (javascript:, data:, http:) is dropped. */
export function safeHref(href: string): string | null {
  const value = href.trim();
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  if (/^https:\/\/[^\s]+$/i.test(value)) return value;
  if (/^mailto:[^\s]+$/i.test(value)) return value;
  return null;
}

const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/;

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  for (const part of source.split(INLINE)) {
    if (!part) continue;
    let match: RegExpMatchArray | null;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      out.push({ type: "strong", children: parseInline(part.slice(2, -2)) });
    } else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      out.push({ type: "code", text: part.slice(1, -1) });
    } else if ((match = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/))) {
      const href = safeHref(match[2]);
      const children = parseInline(match[1]);
      if (href) out.push({ type: "link", href, children });
      else out.push(...children);
    } else if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      out.push({ type: "em", children: parseInline(part.slice(1, -1)) });
    } else {
      out.push({ type: "text", text: part });
    }
  }
  return out;
}

export function plainText(nodes: Inline[]): string {
  return nodes.map((n) => (n.type === "text" || n.type === "code" ? n.text : plainText(n.children))).join("");
}

function slugify(text: string, used: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 60) || "section";
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
  used.add(id);
  return id;
}

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const ids = new Set<string>();
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", children: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (!line.trim()) {
      flush();
      continue;
    }

    if (line.trim().startsWith("```")) {
      flush();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) code.push(lines[i++]);
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flush();
      const level = Math.max(2, heading[1].length) as 2 | 3 | 4;
      const children = parseInline(heading[2]);
      blocks.push({ type: "heading", level, children, id: slugify(plainText(children), ids) });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      flush();
      const head = splitRow(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]).map(parseInline));
      i -= 1;
      blocks.push({ type: "table", head, rows });
      continue;
    }

    if (/^\s*>/.test(line)) {
      flush();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      i -= 1;
      blocks.push({ type: "quote", children: parseInline(quote.join(" ")) });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/;
    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      flush();
      const ordered = numbered.test(line);
      const marker = ordered ? numbered : bullet;
      const items: Inline[][] = [];
      while (i < lines.length && marker.test(lines[i])) {
        let text = (lines[i].match(marker) as RegExpMatchArray)[1];
        i += 1;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !marker.test(lines[i])) text += ` ${lines[i++].trim()}`;
        items.push(parseInline(text));
      }
      i -= 1; // the loop above stopped on the first line after the list; the outer loop steps forward again
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
