type Feature = { title: string; text: string };

/**
 * One icon per feature slot. Every language lists the same four features in the same order (free and
 * account-free, any device, original quality, ten platforms; tests/seo-copy.test.ts holds the count), on the
 * home page and on each platform page, so the icon can follow the position.
 */
const ICONS = [
  // Free, no account: a bolt, for "paste and go".
  <path key="bolt" d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
  // Any device: a phone in front of a laptop.
  <g key="devices">
    <path d="M4 16V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2" />
    <path d="M2 20h11" />
    <rect x="15" y="10" width="7" height="11" rx="1.5" />
  </g>,
  // Original quality, no watermark: sparkles.
  <path key="sparkles" d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" />,
  // Ten platforms: a grid of tiles.
  <g key="grid">
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </g>,
];

export default function FeatureGrid({
  heading,
  features,
  id,
}: {
  heading: string;
  features: Feature[];
  /** Anchor for the header's "Features" link (home page only). */
  id?: string;
}) {
  return (
    <section id={id} className="mt-20 w-full max-w-5xl scroll-mt-24">
      <h2 className="mb-6 text-center font-display text-3xl font-bold tracking-tight text-zinc-50 sm:text-4xl">
        {heading}
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {features.map((feature, index) => (
          <li
            key={feature.title}
            className="glass group relative overflow-hidden rounded-2xl p-6 transition duration-300 hover:-translate-y-0.5 hover:border-brand-400/30 hover:shadow-glow"
          >
            {/* Soft light that blooms behind the card on hover. */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-gradient-to-br from-brand-400/25 to-violet-400/25 opacity-0 blur-2xl transition duration-300 group-hover:opacity-100"
            />
            <span className="relative mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-violet-600 shadow-glow">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="h-5 w-5 text-white"
              >
                {ICONS[index % ICONS.length]}
              </svg>
            </span>
            <h3 className="relative font-display text-base font-semibold text-zinc-50">{feature.title}</h3>
            <p className="relative mt-2 text-sm leading-relaxed text-zinc-400">{feature.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
