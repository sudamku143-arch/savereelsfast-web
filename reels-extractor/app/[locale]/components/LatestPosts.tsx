import { localePath, type Locale } from "@/lib/i18n-config";
import { blogPath, getPosts } from "@/lib/blog";

type Dict = { latestHeading: string; allArticles: string; minRead: string };

const HOW_MANY = 3;

function formatDate(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

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

      <ul className="space-y-3">
        {posts.map((post) => (
          <li key={post.slug}>
            <article className="glass rounded-2xl p-4 transition hover:border-brand-500/40">
              <p className="text-xs text-zinc-500">
                <time dateTime={post.date}>{formatDate(post.date, locale)}</time>
                <span aria-hidden="true"> · </span>
                {dict.minRead.replace("{n}", String(post.readingMinutes))}
              </p>
              <h3 className="mt-1.5 text-base font-semibold leading-snug text-zinc-100">
                <a
                  href={localePath(locale, blogPath(post.slug))}
                  className="rounded outline-none transition hover:text-brand-300 focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {post.title}
                </a>
              </h3>
              <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-zinc-400">{post.description}</p>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}
