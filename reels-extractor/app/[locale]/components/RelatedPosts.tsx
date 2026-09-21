import { localePath, type Locale } from "@/lib/i18n-config";
import { blogPath, relatedPosts } from "@/lib/blog";
import type { PlatformId } from "@/lib/platforms";
import PostCards from "./PostCards";

type Dict = { relatedHeading: string; allArticles: string; minRead: string };

/**
 * "Related articles" at the foot of a tool page: the posts written for this platform, then the general ones. Renders
 * nothing in a language that has no posts, so a tool page never links to an article in another language.
 */
export default function RelatedPosts({ locale, platform, dict }: { locale: Locale; platform: PlatformId; dict: Dict }) {
  const posts = relatedPosts(locale, platform);
  if (posts.length === 0) return null;

  return (
    <section className="mt-16 w-full max-w-2xl" aria-labelledby="related-articles">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 id="related-articles" className="text-xl font-bold text-zinc-50">
          {dict.relatedHeading}
        </h2>
        <a
          href={localePath(locale, blogPath())}
          className="shrink-0 rounded text-sm font-medium text-brand-300 outline-none transition hover:text-brand-400 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {dict.allArticles} →
        </a>
      </div>
      <PostCards posts={posts} locale={locale} minRead={dict.minRead} />
    </section>
  );
}
