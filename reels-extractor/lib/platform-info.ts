// Kept free of runtime imports (and of "@/" aliases) so it can be unit-tested with plain Node.
import type { PlatformId } from "./platforms";

/** Everything the page needs to switch to a platform without asking the server. */
export type PlatformInfo = {
  /** The platform page's heading and intro, as its own landing page shows them. */
  h1: string;
  lead: string;
  /** "In the app, tap Share, then Copy link": the helper line under the input box. */
  copyHint: string;
  /** The page title of that landing page (shown at once; the router confirms it a moment later). */
  metaTitle: string;
  /** The landing page path, language prefix included, so the visitor's language is kept. */
  href: string;
};

type LandingContent = Record<
  PlatformId,
  { h1: string; lead: string; copyHint: string; metaTitle: string }
>;

/** Builds the per-platform switch data from the (already translated) landing content. */
export function buildPlatformInfo(
  content: LandingContent,
  hrefFor: (id: PlatformId) => string
): Record<PlatformId, PlatformInfo> {
  const entries = (Object.keys(content) as PlatformId[]).map((id) => [
    id,
    {
      h1: content[id].h1,
      lead: content[id].lead,
      copyHint: content[id].copyHint,
      metaTitle: content[id].metaTitle,
      href: hrefFor(id),
    },
  ]);
  return Object.fromEntries(entries) as Record<PlatformId, PlatformInfo>;
}
