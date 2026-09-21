// Links that let a visitor tell someone about the site: WhatsApp, X, or a copied address. They are plain links, so
// nothing is loaded from those services and nothing is sent to them until the visitor taps one. Kept free of DOM and
// React so plain Node can test it.

import { localePath, type Locale } from "./i18n-config";
import { SITE_URL } from "./site";

export type ShareMedium = "whatsapp" | "x" | "copy";

/**
 * The address that is shared: the home page in the visitor's language. The utm_ parameters only say where a visit
 * came from; they change nothing on the page, and the page's canonical address stays clean.
 */
export function shareUrl(locale: Locale, medium: ShareMedium): string {
  const params = new URLSearchParams({ utm_source: "share", utm_medium: medium, utm_campaign: "after-download" });
  return `${SITE_URL}${localePath(locale)}?${params.toString()}`;
}

/** WhatsApp's "click to chat" link with a ready message (works on phones, and in WhatsApp Web on a computer). */
export function whatsappHref(text: string, url: string): string {
  return `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;
}

/** X's post composer with the message and the address filled in. */
export function xHref(text: string, url: string): string {
  return `https://x.com/intent/post?${new URLSearchParams({ text, url }).toString()}`;
}
