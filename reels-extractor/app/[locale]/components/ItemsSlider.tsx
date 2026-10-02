"use client";

import { useState } from "react";
import Image from "next/image";
import { buildAudioHref, buildDownloadHref, downloadFilename } from "@/lib/download";
import type { ReelItem } from "./PreviewCard";
import DownloadButton, { type DownloadDict } from "./DownloadButton";
import type { ErrorsDict } from "./ErrorCard";

export type ItemsDict = {
  postItems: string;
  /** "{n} photos in this post" (an Instagram carousel of photos only). */
  postPhotos: string;
  /** "{n} photos and videos in this post". */
  postMixed: string;
  itemTitle: string;
  /** "Photo {n}": a photo slide's alt text. */
  itemPhotoTitle: string;
  downloadItem: string;
  downloadItemAudio: string;
  downloadAll: string;
  downloadAllBusy: string;
  downloadAllHint: string;
  duration: string;
  thumbnailAlt: string;
  /** Shown instead of a download action when a post/item has no separate audio stream to offer. */
  audioUnavailable: string;
};

const DOWNLOAD_GAP_MS = 900; // browsers drop downloads that start in the same tick

function formatDuration(totalSeconds: number): string {
  const rounded = Math.round(totalSeconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function fill(text: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (acc, [key, value]) => acc.replaceAll(`{${key}}`, String(value)),
    text
  );
}

export default function ItemsSlider({
  items,
  dict,
  downloadDict,
  errorsDict,
  platformName,
  audioOnly = false,
  onDownloaded,
}: {
  items: ReelItem[];
  dict: ItemsDict;
  downloadDict: DownloadDict;
  errorsDict: ErrorsDict;
  platformName: string;
  /** True on /audio-downloader: only ever offer the separate audio track, never the video file. */
  audioOnly?: boolean;
  /** Called when any download from this post has been saved or started. */
  onDownloaded?: () => void;
}) {
  const [busy, setBusy] = useState(false);

  // No `src`: for a carousel, "re-resolve the post's best video" would pick the wrong slide.
  const isPhoto = (item: ReelItem) => item.kind === "image";
  const videoHref = (item: ReelItem) =>
    isPhoto(item)
      ? buildDownloadHref({ url: item.videoUrl, id: item.id, kind: "image", ext: item.imageExt })
      : buildDownloadHref({ url: item.videoUrl, id: item.id });
  const fileFor = (item: ReelItem) =>
    isPhoto(item) ? downloadFilename(item.id, "image", item.imageExt) : downloadFilename(item.id);
  const photos = items.filter(isPhoto).length;
  const countLabel = fill(
    photos === 0 ? dict.postItems : photos === items.length ? dict.postPhotos : dict.postMixed,
    { n: items.length }
  );
  // Its own audio track, or the sound taken out of the slide's video; photos have none.
  const audioHref = (item: ReelItem) => buildAudioHref(item);

  // Photos have no sound; on the audio page, skip them.
  const audioItems = audioOnly ? items.filter((item) => audioHref(item)) : items;

  async function downloadAll() {
    setBusy(true);
    try {
      for (const item of audioItems) {
        const link = document.createElement("a");
        link.href = audioOnly ? audioHref(item)! : videoHref(item);
        link.download = audioOnly ? downloadFilename(item.id, "audio", item.audioExt) : fileFor(item);
        document.body.appendChild(link);
        link.click();
        link.remove();
        await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_GAP_MS));
      }
      onDownloaded?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-4" aria-label={countLabel}>
      <div className="mb-2 flex items-center justify-between gap-2">
        {/* A caption, not a heading: this only ever appears inside a client-rendered result after a visitor
            pastes a link (so it's never part of what a crawler sees), and an <h3> here with no <h2> above
            it on the page at that point would skip a heading level. */}
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          {countLabel}
        </p>
      </div>

      <ul className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:thin]">
        {items.map((item, index) => {
          const audio = audioHref(item);
          return (
            <li
              key={`${item.id}-${index}`}
              className="w-36 shrink-0 snap-start rounded-xl border border-white/10 bg-white/5 p-2"
            >
              <div className="relative aspect-[9/16] w-full overflow-hidden rounded-lg bg-zinc-800">
                {item.thumbnailUrl && (
                  <Image
                    src={item.thumbnailUrl}
                    alt={item.title ?? fill(isPhoto(item) ? dict.itemPhotoTitle : dict.itemTitle, { n: index + 1 })}
                    fill
                    sizes="144px"
                    className="object-cover"
                    unoptimized
                  />
                )}
                <span className="absolute left-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                  {index + 1}
                </span>
                {item.durationSeconds != null && (
                  <span
                    aria-label={`${dict.duration}: ${formatDuration(item.durationSeconds)}`}
                    className="absolute bottom-1.5 right-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white"
                  >
                    {formatDuration(item.durationSeconds)}
                  </span>
                )}
              </div>

              <div className="mt-2 flex flex-col gap-1.5">
                {audioOnly ? (
                  audio ? (
                    <DownloadButton
                      href={audio}
                      filename={downloadFilename(item.id, "audio", item.audioExt)}
                      label={dict.downloadItem}
                      variant="compact"
                      dict={downloadDict}
                      errorsDict={errorsDict}
                      platformName={platformName}
                      onSaved={onDownloaded}
                    />
                  ) : (
                    <p className="px-0.5 text-center text-[10px] leading-snug text-zinc-500">
                      {dict.audioUnavailable}
                    </p>
                  )
                ) : (
                  <>
                    <DownloadButton
                      href={videoHref(item)}
                      filename={fileFor(item)}
                      label={`${dict.downloadItem}${item.quality ? ` · ${item.quality}` : isPhoto(item) ? ` · ${(item.imageExt ?? "jpg").toUpperCase()}` : ""}`}
                      variant="compact"
                      dict={downloadDict}
                      errorsDict={errorsDict}
                      platformName={platformName}
                      onSaved={onDownloaded}
                    />
                    {audio && (
                      <DownloadButton
                        href={audio}
                        filename={downloadFilename(item.id, "audio", item.audioExt)}
                        label={dict.downloadItemAudio}
                        variant="compact-secondary"
                        dict={downloadDict}
                        errorsDict={errorsDict}
                        platformName={platformName}
                        onSaved={onDownloaded}
                      />
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {audioItems.length > 0 ? (
        <>
          <button
            type="button"
            onClick={downloadAll}
            disabled={busy}
            className="mt-2 w-full rounded-xl btn-primary px-4 py-2.5 text-sm font-semibold text-white shadow-glow outline-none transition hover:shadow-glow-lg focus-visible:ring-2 focus-visible:ring-brand-300 disabled:opacity-60 disabled:shadow-none"
          >
            {busy ? dict.downloadAllBusy : fill(dict.downloadAll, { n: audioItems.length })}
          </button>
          <p className="mt-1.5 text-center text-[11px] text-zinc-500">{dict.downloadAllHint}</p>
        </>
      ) : (
        audioOnly && (
          <p className="mt-2 text-center text-xs text-zinc-500">{dict.audioUnavailable}</p>
        )
      )}
    </section>
  );
}
