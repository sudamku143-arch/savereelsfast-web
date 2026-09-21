// Which languages the header's language switcher may offer on a given page. Kept free of runtime imports (no file
// access) because the header runs in the browser, and so plain Node can test it.
//
// Every page exists in every language except the blog: a blog page exists only in the languages it was written in, and
// switching to any other would be a 404. So on a blog page the switcher offers only the languages that have that
// exact page, and the header hides it when there is nothing to switch to.

import type { Locale } from "./i18n-config";

export type BlogAvailability = {
  /** Languages that have a blog (its index page). */
  index: Locale[];
  /** For each post slug, the languages it exists in. */
  posts: Record<string, Locale[]>;
};

/** "/blog", "/hi/blog", "/blog/some-post/", "/es/blog/some-post": the language prefix is optional. */
const BLOG_PATH = /^(?:\/[a-z]{2})?\/blog(?:\/([^/]+))?\/?$/;

export function switcherLocales(pathname: string, all: readonly Locale[], blog: BlogAvailability): readonly Locale[] {
  const match = pathname.match(BLOG_PATH);
  if (!match) return all;
  const available = match[1] ? (blog.posts[match[1]] ?? []) : blog.index;
  return all.filter((locale) => available.includes(locale));
}

/** The switcher is only worth showing when there is somewhere to switch to. */
export function showSwitcher(options: readonly Locale[]): boolean {
  return options.length >= 2;
}
