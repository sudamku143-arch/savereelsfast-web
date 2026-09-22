import type { Metadata } from "next";
import NotFoundContent from "./components/NotFoundContent";

// Currently unreachable in production: every route under [locale] is force-static with
// dynamicParams: false, so an out-of-list URL 404s at Next's routing layer before this segment's own
// notFound() calls (or this boundary) ever run - app/not-found.tsx (the root one) is what visitors actually
// see. Kept anyway, correctly documented, as a free safety net for the day a route here becomes dynamic.
//
// A 404 must never be indexed. This file stays a server component only so it can declare that (Next.js's
// not-found.tsx convention forbids "use client" + a metadata export together); the actual, locale-aware
// content lives in NotFoundContent.
export const metadata: Metadata = {
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return <NotFoundContent />;
}
