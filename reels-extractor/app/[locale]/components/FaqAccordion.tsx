"use client";

import { useId, useState } from "react";

type FaqItem = { q: string; a: string };

export default function FaqAccordion({
  heading,
  items,
}: {
  heading: string;
  items: FaqItem[];
}) {
  const baseId = useId();
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section className="mt-16 w-full max-w-2xl">
      <h2 className="mb-4 text-xl font-bold text-zinc-50">{heading}</h2>
      <div className="glass divide-y divide-white/10 rounded-2xl">
        {items.map((item, i) => {
          const open = openIndex === i;
          const buttonId = `${baseId}-q-${i}`;
          const panelId = `${baseId}-a-${i}`;
          return (
            <div key={item.q}>
              <h3>
                <button
                  type="button"
                  id={buttonId}
                  onClick={() => setOpenIndex(open ? null : i)}
                  aria-expanded={open}
                  aria-controls={panelId}
                  className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left text-sm font-medium text-zinc-100 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 sm:text-base"
                >
                  <span>{item.q}</span>
                  <span
                    className={`shrink-0 text-lg leading-none text-brand-400 transition-transform duration-300 ${
                      open ? "rotate-45" : ""
                    }`}
                    aria-hidden="true"
                  >
                    +
                  </span>
                </button>
              </h3>
              <div
                id={panelId}
                role="region"
                aria-labelledby={buttonId}
                className={`grid transition-[grid-template-rows,visibility] duration-300 ${
                  open ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]"
                }`}
              >
                <div className="overflow-hidden">
                  <p className="px-5 pb-4 text-sm leading-relaxed text-zinc-400">
                    {item.a}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
