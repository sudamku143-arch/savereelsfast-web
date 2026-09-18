"use client";

import { useState } from "react";

type FaqItem = { q: string; a: string };

export default function FaqAccordion({
  heading,
  items,
}: {
  heading: string;
  items: FaqItem[];
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section className="mt-16 w-full max-w-2xl">
      <h2 className="mb-4 text-xl font-bold text-zinc-900">{heading}</h2>
      <div className="divide-y divide-zinc-200 rounded-2xl border border-zinc-200 bg-white shadow-sm">
        {items.map((item, i) => {
          const open = openIndex === i;
          return (
            <div key={item.q}>
              <button
                type="button"
                onClick={() => setOpenIndex(open ? null : i)}
                aria-expanded={open}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left text-sm font-medium text-zinc-800 sm:text-base"
              >
                <span>{item.q}</span>
                <span
                  className={`shrink-0 text-brand-500 transition-transform ${
                    open ? "rotate-45" : ""
                  }`}
                  aria-hidden
                >
                  +
                </span>
              </button>
              {open && (
                <div className="px-5 pb-4 text-sm text-zinc-500">
                  {item.a}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
