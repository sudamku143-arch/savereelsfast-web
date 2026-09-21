import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, localePath, type Locale } from "@/lib/i18n-config";
import { getDictionary } from "@/lib/get-dictionary";
import { pageMetadata } from "@/lib/legal-metadata";
import { allPosts, blogPath, getPost, translationsOf } from "@/lib/blog";
import { landingPath } from "@/lib/landing";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import BlogMarkdown from "../../components/BlogMarkdown";

type Props = { params: { locale: string; slug: string } };

// Only posts that exist are pages; anything else is a 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return allPosts().map((post) => ({ locale: post.locale, slug: post.slug }));
}

function resolve(params: Props["params"]) {
  const locale: Locale | null = isLocale(params.locale) ? params.locale : null;
  const post = locale ? getPost(locale, params.slug) : null;
  if (!locale || !post) notFound();
  return { locale, post };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, post } = resolve(params);
  const metadata = pageMetadata(locale, blogPath(post.slug), post.metaTitle, post.description, undefined, translationsOf(post.slug));
  return {
    ...metadata,
    openGraph: {
      ...metadata.openGraph,
      type: "article",
      publishedTime: post.date,
      ...(post.updated ? { modifiedTime: post.updated } : {}),
    },
  };
}

/** JSON in a <script> must not be able to close the tag. */
const jsonLd = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c");

function formatDate(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

export default async function BlogPostPage({ params }: Props) {
  const { locale, post } = resolve(params);
  const dict = await getDictionary(locale);
  const { blog } = dict;
  const pageUrl = `${SITE_URL}${localePath(locale, blogPath(post.slug))}`;
  const blogUrl = `${SITE_URL}${localePath(locale, blogPath())}`;
  const homeUrl = `${SITE_URL}${localePath(locale)}`;

  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "BlogPosting",
        "@id": `${pageUrl}#post`,
        headline: post.title,
        description: post.description,
        datePublished: post.date,
        dateModified: post.updated ?? post.date,
        inLanguage: locale,
        mainEntityOfPage: pageUrl,
        wordCount: post.wordCount,
        image: `${SITE_URL}/api/og`,
        author: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
        publisher: { "@type": "Organization", name: SITE_NAME, url: SITE_URL },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: dict.landing.common.breadcrumbHome, item: homeUrl },
          { "@type": "ListItem", position: 2, name: blog.heading, item: blogUrl },
          { "@type": "ListItem", position: 3, name: post.title, item: pageUrl },
        ],
      },
    ],
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-16 pt-10 sm:pt-14">
      <nav aria-label="Breadcrumb" className="text-sm text-zinc-500">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <li>
            <a href={localePath(locale)} className="transition hover:text-brand-300">
              {dict.landing.common.breadcrumbHome}
            </a>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <a href={localePath(locale, blogPath())} className="transition hover:text-brand-300">
              {blog.heading}
            </a>
          </li>
        </ol>
      </nav>

      <article className="mt-6">
        <header>
          <h1 className="text-3xl font-extrabold leading-tight tracking-tight text-zinc-50 sm:text-4xl">{post.title}</h1>
          <p className="mt-3 text-sm text-zinc-500">
            {blog.published} <time dateTime={post.date}>{formatDate(post.date, locale)}</time>
            {post.updated ? (
              <>
                <span aria-hidden="true"> · </span>
                {blog.updated} <time dateTime={post.updated}>{formatDate(post.updated, locale)}</time>
              </>
            ) : null}
            <span aria-hidden="true"> · </span>
            {blog.minRead.replace("{n}", String(post.readingMinutes))}
          </p>
        </header>

        <div className="text-base sm:text-[1.0625rem]">
          <BlogMarkdown source={post.body} locale={locale} />
        </div>
      </article>

      {post.tools.length > 0 && (
        <section className="mt-12" aria-labelledby="related-tools">
          <h2 id="related-tools" className="text-lg font-bold text-zinc-50">
            {blog.toolsHeading}
          </h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {post.tools.map((tool) => (
              <li key={tool}>
                <a
                  href={localePath(locale, landingPath(tool))}
                  className="glass block rounded-xl px-4 py-3 text-sm font-medium text-zinc-100 outline-none transition hover:border-brand-500/40 hover:text-brand-300 focus-visible:ring-2 focus-visible:ring-brand-500"
                >
                  {dict.landing.platforms[tool].h1}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <aside className="glass mt-8 rounded-2xl p-6">
        <h2 className="text-lg font-bold text-zinc-50">{blog.ctaHeading}</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">{blog.ctaText}</p>
        <a
          href={localePath(locale)}
          className="mt-4 inline-block rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-semibold text-white outline-none transition hover:bg-brand-600 focus-visible:ring-2 focus-visible:ring-brand-300"
        >
          {blog.ctaButton}
        </a>
      </aside>

      <p className="mt-8 text-sm">
        <a href={localePath(locale, blogPath())} className="text-brand-300 transition hover:text-brand-400">
          ← {blog.allArticles}
        </a>
      </p>

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(structuredData) }} />
    </main>
  );
}
