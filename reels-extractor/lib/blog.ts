// Blog posts are plain Markdown files: content/blog/<language>/<slug>.md. Adding a post is adding a file; nothing in
// the code has to change. The folder is the post's language and must match its `language:` field, and a translation
// of a post is the same slug in another language's folder (that is what links them together for search engines).
//
//   ---
//   title: The headline shown on the page
//   metaTitle: Optional shorter title for search results (under 60 characters)
//   description: One or two sentences for search results (under 160 characters)
//   date: 2026-09-21
//   updated: 2026-10-02        (optional)
//   language: en
//   draft: true                (optional: hidden everywhere until removed)
//   ---
//
// Files are read at build time. A mistake in a post's header stops the build with the file's name, so it can never
// reach the live site half-broken.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isLocale, locales, type Locale } from "./i18n-config";
import type { BlogAvailability } from "./switcher";

export type BlogPost = {
  slug: string;
  locale: Locale;
  title: string;
  metaTitle: string;
  description: string;
  date: string; // YYYY-MM-DD
  updated: string | null;
  body: string;
  wordCount: number;
  readingMinutes: number;
};

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function contentRoot(): string {
  return join(process.cwd(), "content", "blog");
}

/** Splits the `---` header from the body and reads its `key: value` lines. */
export function parseFrontmatter(raw: string, file: string): { data: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`${file}: the post must start with a --- header (title, description, date, language)`);
  const data: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error(`${file}: cannot read header line "${line}" (expected key: value)`);
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    data[key] = value;
  }
  return { data, body: match[2].trim() };
}

function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function readPost(raw: string, locale: Locale, slug: string, file = `${locale}/${slug}.md`): BlogPost | null {
  const { data, body } = parseFrontmatter(raw, file);
  if (!SLUG.test(slug)) throw new Error(`${file}: the file name must be lowercase words joined by hyphens (got "${slug}")`);
  for (const field of ["title", "description", "date", "language"]) {
    if (!data[field]) throw new Error(`${file}: missing "${field}" in the header`);
  }
  if (data.language !== locale) {
    throw new Error(`${file}: language is "${data.language}" but the file is in the "${locale}" folder`);
  }
  if (!isRealDate(data.date)) throw new Error(`${file}: date must be a real date like 2026-09-21 (got "${data.date}")`);
  if (data.updated && !isRealDate(data.updated)) throw new Error(`${file}: updated must be a real date like 2026-09-21`);
  if (data.description.length > 200) throw new Error(`${file}: the description is ${data.description.length} characters; keep it under 160`);
  if (body.length < 50) throw new Error(`${file}: the post has no body`);
  if (data.draft === "true") return null;

  const words = body.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length; // real words, not | ## - marks
  return {
    slug,
    locale,
    title: data.title,
    metaTitle: data.metaTitle || data.title,
    description: data.description,
    date: data.date,
    updated: data.updated || null,
    body,
    wordCount: words,
    readingMinutes: Math.max(1, Math.round(words / 200)),
  };
}

let cache: BlogPost[] | null = null;

/** Every published post in every language, newest first. */
export function allPosts(): BlogPost[] {
  if (cache && process.env.NODE_ENV === "production") return cache;
  const posts: BlogPost[] = [];
  const root = contentRoot();
  if (existsSync(root)) {
    for (const folder of readdirSync(root, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      if (!isLocale(folder.name)) {
        throw new Error(`content/blog/${folder.name}: not a language of this site (${locales.join(", ")})`);
      }
      for (const file of readdirSync(join(root, folder.name))) {
        if (!file.endsWith(".md")) continue;
        const slug = file.slice(0, -3);
        const post = readPost(readFileSync(join(root, folder.name, file), "utf8"), folder.name, slug);
        if (post) posts.push(post);
      }
    }
  }
  posts.sort((a, b) => (a.date === b.date ? a.slug.localeCompare(b.slug) : a.date < b.date ? 1 : -1));
  cache = posts;
  return posts;
}

export function getPosts(locale: Locale): BlogPost[] {
  return allPosts().filter((post) => post.locale === locale);
}

export function getPost(locale: Locale, slug: string): BlogPost | null {
  return allPosts().find((post) => post.locale === locale && post.slug === slug) ?? null;
}

/** Languages that have at least one post: only these get a /blog. */
export function localesWithPosts(): Locale[] {
  const present = new Set(allPosts().map((post) => post.locale));
  return locales.filter((locale) => present.has(locale));
}

/** Languages a given post (slug) exists in, in site order: its hreflang alternates. */
export function translationsOf(slug: string): Locale[] {
  const present = new Set(allPosts().filter((post) => post.slug === slug).map((post) => post.locale));
  return locales.filter((locale) => present.has(locale));
}

/** Where the blog exists, for the language switcher: the languages with a blog, and for each post the languages it is in. */
export function blogAvailability(): BlogAvailability {
  const posts: Record<string, Locale[]> = {};
  for (const post of allPosts()) posts[post.slug] = translationsOf(post.slug);
  return { index: localesWithPosts(), posts };
}

export const blogPath = (slug?: string) => (slug ? `/blog/${slug}` : "/blog");
