import { siteSchema } from "@/lib/site";

/** Who runs the site and where else it lives (the Telegram bot), as JSON-LD for search engines. */
export default function SiteSchema() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(siteSchema()).replace(/</g, "\u003c") }}
    />
  );
}
