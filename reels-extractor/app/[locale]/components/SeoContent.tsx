export default function SeoContent({
  heading,
  paragraphs,
}: {
  heading: string;
  paragraphs: string[];
}) {
  return (
    <section className="mt-16 w-full max-w-2xl">
      <h2 className="mb-4 text-xl font-bold text-zinc-50">{heading}</h2>
      <div className="space-y-4 text-sm leading-relaxed text-zinc-400 sm:text-base">
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
    </section>
  );
}
