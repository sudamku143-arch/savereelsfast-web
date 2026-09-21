import { localePath, type Locale } from "@/lib/i18n-config";
import { blogPath, type BlogPost } from "@/lib/blog";

function formatDate(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

/** Compact article cards, shared by the home page's latest posts and the tool pages' related articles. */
export default function PostCards({ posts, locale, minRead }: { posts: BlogPost[]; locale: Locale; minRead: string }) {
  return (
    <ul className="space-y-3">
      {posts.map((post) => (
        <li key={post.slug}>
          <article className="glass rounded-2xl p-4 transition hover:border-brand-500/40">
            <p className="text-xs text-zinc-500">
              <time dateTime={post.date}>{formatDate(post.date, locale)}</time>
              <span aria-hidden="true"> · </span>
              {minRead.replace("{n}", String(post.readingMinutes))}
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
  );
}
