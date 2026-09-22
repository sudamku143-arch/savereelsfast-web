import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    // /api/ is off limits to crawlers except the share image that link previews fetch.
    rules: [{ userAgent: "*", allow: ["/", "/api/og"], disallow: ["/api/"] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    // No "host" directive: it was only ever a Yandex extension, and Yandex itself dropped support for it
    // in 2018. Google and Bing have always ignored it, so it did nothing but take up a line.
  };
}
