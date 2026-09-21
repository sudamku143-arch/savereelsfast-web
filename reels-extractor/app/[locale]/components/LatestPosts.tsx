import { localePath, type Locale } from "@/lib/i18n-config";
import { blogPath, getPosts } from "@/lib/blog";
import PostCards from "./PostCards";

type Dict = { latestHeading: string; allArticles: string; minRead: string };

const HOW_MANY = 3;

/**
 * The newest posts, linked from the home page. Renders nothing in a language that has no blog (its /blog would be a
 * 404), and picks up new posts on its own: there is no list to keep up to date.
 */
export default function LatestPosts({ locale, dict }: { locale: Locale; dict: Dict }) {
  const posts = getPosts(locale).slice(0, HOW_MANY);
  if (posts.length === 0) return null;

  return (
    <section className="mt-16 w-full max-w-2xl" aria-labelledby="latest-articles">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 id="latest-articles" className="text-xl font-bold text-zinc-50">
          {dict.latestHeading}
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
