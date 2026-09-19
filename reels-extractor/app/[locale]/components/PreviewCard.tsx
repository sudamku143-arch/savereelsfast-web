"use client";

import { useState } from "react";
import Image from "next/image";

export type ReelFormat = {
  quality: string; // e.g. "720p"
  url: string;
  width?: number | null;
  height?: number | null;
};

export type ReelResult = {
  id: string;
  videoUrl: string;
  thumbnailUrl: string;
  title: string | null;
  author: string | null;
  durationSeconds: number | null;
  formats?: ReelFormat[];
};

type Dict = {
  title: string;
  author: string;
  duration: string;
  downloadButton: string;
  newSearch: string;
  quality: string;
  original: string;
  thumbnailAlt: string;
};

function formatDuration(totalSeconds: number): string {
  const rounded = Math.round(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function PreviewCard({
  result,
  dict,
  onReset,
}: {
  result: ReelResult;
  dict: Dict;
  onReset: () => void;
}) {
  const options: ReelFormat[] =
    result.formats && result.formats.length > 0
      ? result.formats
      : [
          { quality: dict.original, url: result.videoUrl },
        ];

  const [selected, setSelected] = useState(0);
  const current = options[Math.min(selected, options.length - 1)];
  const filename = `savereelsfast-${result.id}.mp4`;
  // Same-origin proxy: cross-origin CDN links ignore the `download` attribute.
  const downloadHref = `/api/download?url=${encodeURIComponent(
    current.url
  )}&id=${encodeURIComponent(result.id)}`;
  const durationLabel =
    result.durationSeconds != null ? formatDuration(result.durationSeconds) : null;

  return (
    <div className="glass mt-6 w-full max-w-md animate-fade-in-up rounded-2xl p-4 shadow-glow">
      <p className="mb-3 text-sm font-semibold text-zinc-50">{dict.title}</p>

      <div className="flex gap-4">
        <div className="relative aspect-[9/16] w-24 shrink-0 overflow-hidden rounded-xl bg-zinc-800 sm:w-28">
          {result.thumbnailUrl && (
            <Image
              src={result.thumbnailUrl}
              alt={result.title ?? dict.thumbnailAlt}
              fill
              sizes="112px"
              className="object-cover"
              unoptimized
            />
          )}
          {durationLabel && (
            <span
              aria-label={`${dict.duration}: ${durationLabel}`}
              className="absolute bottom-1.5 right-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white"
            >
              {durationLabel}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-2 text-sm">
          {result.author && (
            <p className="truncate text-zinc-200">
              <span className="text-zinc-500">{dict.author}</span>{" "}
              <span className="font-medium">@{result.author}</span>
            </p>
          )}
          {result.title && (
            <p className="line-clamp-3 text-zinc-400">{result.title}</p>
          )}
        </div>
      </div>

      <fieldset className="mt-4">
        <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
          {dict.quality}
        </legend>
        <div className="flex flex-wrap gap-2">
          {options.map((opt, i) => {
            const active = i === selected;
            const resolution =
              opt.width && opt.height ? `${opt.width}×${opt.height}` : null;
            return (
              <label
                key={`${opt.quality}-${i}`}
                className={`cursor-pointer rounded-lg border px-3 py-2 text-left text-xs transition focus-within:ring-2 focus-within:ring-brand-500 ${
                  active
                    ? "border-brand-500 bg-brand-500/15 text-zinc-50"
                    : "border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10"
                }`}
              >
                <input
                  type="radio"
                  name="reel-format"
                  checked={active}
                  onChange={() => setSelected(i)}
                  className="sr-only"
                />
                <span className="block text-sm font-semibold">{opt.quality}</span>
                {resolution && (
                  <span className="block text-zinc-500">{resolution}</span>
                )}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-4 flex gap-2">
        <a
          href={downloadHref}
          download={filename}
          className="flex-1 rounded-xl bg-brand-500 px-4 py-2.5 text-center text-sm font-semibold text-white shadow-glow outline-none transition hover:bg-brand-400 hover:shadow-glow-lg focus-visible:ring-2 focus-visible:ring-brand-300"
        >
          {dict.downloadButton}
        </a>
        <button
          type="button"
          onClick={onReset}
          className="rounded-xl border border-white/10 px-4 py-2.5 text-sm font-medium text-zinc-300 outline-none transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {dict.newSearch}
        </button>
      </div>
    </div>
  );
}
