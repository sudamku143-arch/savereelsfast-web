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
