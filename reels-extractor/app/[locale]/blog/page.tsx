import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, localePath, type Locale } from "@/lib/i18n-config";
import { getDictionary } from "@/lib/get-dictionary";
import { pageMetadata } from "@/lib/legal-metadata";
import { blogPath, getPosts, localesWithPosts } from "@/lib/blog";
import { SITE_NAME, SITE_URL } from "@/lib/site";

type Props = { params: { locale: string } };

// Only languages that have posts get a blog; any other language's /blog is a 404 (and is not in the sitemap).
export const dynamicParams = false;

export function generateStaticParams() {
  return localesWithPosts().map((locale) => ({ locale }));
}

function resolve(params: Props["params"]): Locale {
  if (!isLocale(params.locale) || getPosts(params.locale).length === 0) notFound();
  return params.locale;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = resolve(params);
  const { blog } = await getDictionary(locale);
  return pageMetadata(locale, blogPath(), blog.metaTitle, blog.metaDescription, undefined, localesWithPosts());
}

/** JSON in a <script> must not be able to close the tag. */
const jsonLd = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c");

function formatDate(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

export default async function BlogIndexPage({ params }: Props) {
  const locale = resolve(params);
  const { blog } = await getDictionary(locale);
  const posts = getPosts(locale);
  const pageUrl = `${SITE_URL}${localePath(locale, blogPath())}`;

  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Blog",
        "@id": `${pageUrl}#blog`,
        name: `${SITE_NAME} ${blog.heading}`,
        description: blog.metaDescription,
        url: pageUrl,
        inLanguage: locale,
        publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
        blogPost: posts.map((post) => ({
          "@type": "BlogPosting",
          headline: post.title,
          datePublished: post.date,
          url: `${SITE_URL}${localePath(locale, blogPath(post.slug))}`,
        })),
      },
    ],
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-12 sm:pt-16">
      <h1 className="text-3xl font-extrabold tracking-tight text-zinc-50 sm:text-4xl">{blog.heading}</h1>
      <p className="mt-3 leading-relaxed text-zinc-400 sm:text-lg">{blog.lead}</p>

      <ul className="mt-10 space-y-4">
        {posts.map((post) => (
          <li key={post.slug}>
            <article className="glass rounded-2xl p-5 transition hover:border-brand-500/40">
              <p className="text-xs text-zinc-500">
                <time dateTime={post.date}>{formatDate(post.date, locale)}</time>
                <span aria-hidden="true"> · </span>
                {blog.minRead.replace("{n}", String(post.readingMinutes))}
              </p>
              <h2 className="mt-2 text-xl font-bold leading-snug text-zinc-50">
                <a
                  href={localePath(locale, blogPath(post.slug))}
                  className="rounded outline-none transition hover:text-brand-300 focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {post.title}
                </a>
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400 sm:text-base">{post.description}</p>
              <a
                href={localePath(locale, blogPath(post.slug))}
                className="mt-3 inline-block rounded text-sm font-medium text-brand-300 outline-none transition hover:text-brand-400 focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                {blog.readMore}
              </a>
            </article>
          </li>
        ))}
      </ul>

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(structuredData) }} />
    </main>
  );
}
