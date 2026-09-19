type Section = { heading: string; body: string[] };

export default function LegalDoc({
  title,
  updated,
  intro,
  sections,
}: {
  title: string;
  updated?: string;
  intro?: string;
  sections: Section[];
}) {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 pb-8 pt-12 sm:pt-16">
      <h1 className="text-3xl font-extrabold tracking-tight text-zinc-50 sm:text-4xl">
        {title}
      </h1>
      {updated && <p className="mt-2 text-xs text-zinc-500">{updated}</p>}
      {intro && (
        <p className="mt-6 text-sm leading-relaxed text-zinc-400 sm:text-base">
          {intro}
        </p>
      )}
      <div className="mt-8 space-y-8">
        {sections.map((section) => (
          <section key={section.heading}>
            <h2 className="mb-3 text-lg font-bold text-zinc-100">
              {section.heading}
            </h2>
            <div className="space-y-3 text-sm leading-relaxed text-zinc-400 sm:text-base">
              {section.body.map((paragraph, i) => (
                <p key={i}>{paragraph}</p>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
