import type { ReactNode } from "react";

/**
 * A deliberately empty root layout: Next.js requires one to exist for any root-level special file
 * (app/not-found.tsx) to work, but every real route on this site lives under app/[locale], whose own
 * layout.tsx already provides <html>/<body> (with the correct per-locale lang and dir) and everything else
 * a page needs. This just passes children through untouched, so normal pages render exactly one <html>, from
 * [locale]/layout.tsx as before; only the root 404 (which isn't nested under [locale]) supplies its own.
 *
 * No globals.css import here: a page-level (or root-layout-level) import of it with no [locale]/layout.tsx
 * in that render branch did not reliably get linked into app/not-found.tsx's output (confirmed - the built
 * 404 page had no <link rel="stylesheet"> at all either way), so NotFoundContent is styled with inline
 * styles instead of Tailwind classes, and needs no stylesheet at all.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
