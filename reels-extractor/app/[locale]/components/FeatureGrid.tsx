type Feature = { title: string; text: string };

export default function FeatureGrid({
  heading,
  features,
}: {
  heading: string;
  features: Feature[];
}) {
  return (
    <section className="mt-16 w-full max-w-2xl">
      <h2 className="mb-4 text-xl font-bold text-zinc-50">{heading}</h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {features.map((feature) => (
          <li key={feature.title} className="glass rounded-2xl p-4">
            <h3 className="text-sm font-semibold text-zinc-100">{feature.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-zinc-400">{feature.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
