export const SITE_URL = "https://savereelsfast.com";
export const SITE_NAME = "SaveReelsFast";

// Monetag site verification: rendered as <meta name="monetag" content="..."> in the <head> of every page.
export const MONETAG_VERIFICATION = "6f64f47bdb0c082eacb1c4aed39da10f";

// Override in Vercel (Settings → Environment Variables) once a real mailbox exists.
export const CONTACT_EMAIL =
  process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "contact@savereelsfast.com";

// Where copyright takedown notices go. Register this address as your DMCA agent with the
// US Copyright Office to qualify for safe harbor; falls back to the contact address.
export const DMCA_EMAIL = process.env.NEXT_PUBLIC_DMCA_EMAIL ?? CONTACT_EMAIL;

// The Telegram bot that downloads videos in a chat. Linked from the header, footer and floating button, and
// declared as a "sameAs" profile of the site so search engines connect the two.
export const TELEGRAM_BOT_URL = "https://t.me/savereelsfast_bot";

/**
 * Site-wide structured data: who runs the site and where else it lives. The "sameAs" list is what lets Google
 * link the website and the Telegram bot as one entity.
 */
export function siteSchema() {
  const sameAs = [TELEGRAM_BOT_URL];
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${SITE_URL}/#organization`,
        name: SITE_NAME,
        url: SITE_URL,
        logo: `${SITE_URL}/icons/icon-512.png`,
        sameAs,
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        name: SITE_NAME,
        url: SITE_URL,
        publisher: { "@id": `${SITE_URL}/#organization` },
        sameAs,
      },
    ],
  };
}
