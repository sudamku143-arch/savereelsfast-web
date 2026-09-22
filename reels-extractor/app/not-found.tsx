import type { Metadata } from "next";
import NotFoundContent from "./[locale]/components/NotFoundContent";

/**
 * The 404 page that actually fires in production. Every route on this site is force-static with
 * dynamicParams: false, so a URL outside the pre-built list never reaches app/[locale]/layout.tsx (and its
 * Header/Footer) at all - Next.js serves this root fallback directly. It carries its own <html>/<body> for
 * exactly that reason: it isn't nested under [locale], so nothing above it provides them (see
 * app/layout.tsx). See NotFoundContent's docblock for the full explanation, and app/[locale]/not-found.tsx
 * for the (currently unreachable, kept as a correctly-documented fallback) locale-scoped version.
 *
 * lang="en" below is just the initial value; NotFoundContent corrects <html lang>/dir once it reads the
 * real locale from the URL.
 */
export const metadata: Metadata = {
  // Not translated: without params, this can't know the visitor's language, and the page is noindex anyway
  // so it never appears in search results - this is only ever seen as a browser tab title.
  title: "Page Not Found - SaveReelsFast",
  robots: { index: false, follow: true },
};

export default function RootNotFound() {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased">
        <NotFoundContent />
      </body>
    </html>
  );
}
