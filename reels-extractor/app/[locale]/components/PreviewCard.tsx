"use client";

import { useState } from "react";
import Image from "next/image";
import type { PlatformId } from "@/lib/platforms";
import type { Locale } from "@/lib/i18n-config";
import { buildDownloadHref, downloadFilename } from "@/lib/download";
import PlatformIcon from "./PlatformIcon";
import ItemsSlider, { type ItemsDict } from "./ItemsSlider";
import DownloadButton, { type DownloadDict } from "./DownloadButton";
import type { ErrorsDict } from "./ErrorCard";
import ShareTool from "./ShareTool";

export type ReelItem = {
  id: string;
  videoUrl: string;
  thumbnailUrl: string;
  title: string | null;
  durationSeconds: number | null;
  quality?: string;
  audio?: "yes" | "no" | "unknown";
  warning?: "NO_AUDIO";
  audioUrl?: string;
  audioExt?: string;
};

export type ReelResult = {
  id: string;
  platform?: PlatformId;
  videoUrl: string;
  thumbnailUrl: string;
  title: string | null;
  author: string | null;
  durationSeconds: number | null;
  quality?: string;
  sourceUrl?: string;
  warning?: "NO_AUDIO";
  audioUrl?: string;
  audioExt?: string;
  items?: ReelItem[];
};

export type PreviewDict = ItemsDict & {
  title: string;
  author: string;
  downloadButton: string;
  downloadAudio: string;
  newSearch: string;
  noAudio: string;
};

function formatDuration(totalSeconds: number): string {
  const rounded = Math.round(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Collapses whitespace and cuts on a word boundary, e.g. long captions with hashtag walls. */
export function snippet(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:!-]+$/, "")}…`;
}

export default function PreviewCard({
  locale,
  result,
  dict,
  downloadDict,
  errorsDict,
  platform,
  platformName,
  onReset,
}: {
  locale: Locale;
  result: ReelResult;
  dict: PreviewDict;
  downloadDict: DownloadDict;
  errorsDict: ErrorsDict;
  platform: PlatformId;
  platformName: string;
  onReset: () => void;
}) {
  // The share row appears only after the visitor has actually saved something.
  const [downloaded, setDownloaded] = useState(false);
  const items = result.items ?? [];
  const isCarousel = items.length > 1;
  const filename = downloadFilename(result.id);

  // `src` lets the server fall back to streaming through the scraper if the CDN refuses it.
  const videoHref = buildDownloadHref({
    url: result.videoUrl,
    id: result.id,
    src: result.sourceUrl,
  });
  const audioHref = result.audioUrl
    ? buildDownloadHref({
        url: result.audioUrl,
        id: result.id,
        src: result.sourceUrl,
        kind: "audio",
        ext: result.audioExt,
      })
    : null;
  const audioFormat = (result.audioExt ?? "m4a").toUpperCase();

  const durationLabel =
    result.durationSeconds != null ? formatDuration(result.durationSeconds) : null;
  const caption = result.title ? snippet(result.title) : null;

  return (
    <div className="glass mt-6 w-full max-w-md animate-fade-in-up rounded-2xl p-4 shadow-glow">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-zinc-50">{dict.title}</p>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] font-medium text-zinc-300">
            <PlatformIcon id={platform} className="h-3 w-3" />
            {platformName}
          </span>
          {result.quality && !isCarousel && (
            <span className="rounded-full border border-brand-500/40 bg-brand-500/10 px-2 py-0.5 text-[11px] font-semibold text-brand-300">
              {result.quality}
            </span>
          )}
        </div>
      </div>

      <div className="flex gap-4">
        {!isCarousel && (
          <div className="relative aspect-[9/16] w-24 shrink-0 overflow-hidden rounded-xl bg-zinc-800 sm:w-28">
            {result.thumbnailUrl && (
              <Image
                src={result.thumbnailUrl}
                alt={result.title ?? dict.thumbnailAlt}
                fill
                sizes="112px"
                className="object-cover"
                unoptimized
                priority
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
        )}

        <div className="min-w-0 flex-1 space-y-2 text-sm">
          {result.author && (
            <p className="truncate text-zinc-200">
              <span className="text-zinc-500">{dict.author}</span>{" "}
              <span className="font-medium">@{result.author}</span>
            </p>
          )}
          {caption && <p className="text-zinc-400">{caption}</p>}
        </div>
      </div>

      {isCarousel ? (
        <ItemsSlider
          items={items}
          dict={dict}
          downloadDict={downloadDict}
          errorsDict={errorsDict}
          platformName={platformName}
          onDownloaded={() => setDownloaded(true)}
        />
      ) : (
        <>
          {result.warning === "NO_AUDIO" && (
            <p
              role="status"
              className="mt-4 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-200"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              >
                <path d="M11 5 6 9H2v6h4l5 4V5Z" />
                <path d="m22 9-6 6M16 9l6 6" />
              </svg>
              <span>{dict.noAudio}</span>
            </p>
          )}

          <div className="mt-4 flex flex-col gap-2">
            <DownloadButton
              href={videoHref}
              filename={filename}
              label={dict.downloadButton}
              dict={downloadDict}
              errorsDict={errorsDict}
              platformName={platformName}
              onSaved={() => setDownloaded(true)}
            />
            {audioHref && (
              <DownloadButton
                href={audioHref}
                filename={downloadFilename(result.id, "audio", result.audioExt)}
                label={dict.downloadAudio.replaceAll("{format}", audioFormat)}
                variant="secondary"
                dict={downloadDict}
                errorsDict={errorsDict}
                platformName={platformName}
                onSaved={() => setDownloaded(true)}
              />
            )}
          </div>
        </>
      )}

      {downloaded && <ShareTool locale={locale} dict={downloadDict.share} />}

      <button
        type="button"
        onClick={onReset}
        className="mt-2 w-full rounded-xl border border-white/10 px-4 py-2.5 text-sm font-medium text-zinc-300 outline-none transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        {dict.newSearch}
      </button>
    </div>
  );
}
