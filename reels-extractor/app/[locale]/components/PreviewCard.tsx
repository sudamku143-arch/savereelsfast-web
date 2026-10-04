"use client";

import { useState } from "react";
import Image from "next/image";
import type { PlatformId } from "@/lib/platforms";
import type { Locale } from "@/lib/i18n-config";
import { buildAudioHref, buildDownloadHref, downloadFilename, isIpBoundHost, type ImageExtension } from "@/lib/download";
import PlatformIcon from "./PlatformIcon";
import ItemsSlider, { type ItemsDict } from "./ItemsSlider";
import DownloadButton, { type DownloadDict } from "./DownloadButton";
import type { ErrorsDict } from "./ErrorCard";
import ShareTool from "./ShareTool";
import VideoPreview from "./VideoPreview";
import CaptionTools, { type CaptionDict } from "./CaptionTools";
import ClipTools, { type ClipDict } from "./ClipTools";
import { imageExtOf } from "@/lib/caption";

/** Instagram photos come in the same shape as videos: `videoUrl` holds the picture and `kind` is "image". */
type ImageFields = { kind?: "image"; imageExt?: ImageExtension };

export type ReelItem = ImageFields & {
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

export type ReelResult = ImageFields & {
  id: string;
  platform?: PlatformId;
  videoUrl: string;
  thumbnailUrl: string;
  title: string | null;
  /** The whole caption, hashtags included (the card itself shows `title`, a short form). */
  caption?: string | null;
  author: string | null;
  durationSeconds: number | null;
  quality?: string;
  sourceUrl?: string;
  warning?: "NO_AUDIO";
  audioUrl?: string;
  audioExt?: string;
  items?: ReelItem[];
};

export type PreviewDict = ItemsDict & CaptionDict & ClipDict & {
  /** "Cover image ({format})": the post's thumbnail, saved as a picture. */
  downloadCover: string;
  title: string;
  /** Card heading on /audio-downloader, once a result is ready. */
  audioTitle: string;
  /** Card heading when the post is a single Instagram photo. */
  photoTitle: string;
  author: string;
  downloadButton: string;
  /** "Download Photo ({format})" for a single photo. */
  downloadPhoto: string;
  downloadAudio: string;
  newSearch: string;
  noAudio: string;
};

const PLACEHOLDER_TITLE = /^(Video|Post) by [\w.]+$/;

// Platforms whose videos are vertical, reels-style: the player gets a 9:16 frame for them, 16:9 otherwise.
const VERTICAL_PLATFORMS: PlatformId[] = ["instagram", "tiktok", "snapchat"];

/**
 * Which tool a page puts first. "caption" (the caption copier page): the whole caption in a box, with its
 * copy buttons. "cover" (the thumbnail page): the cover image shown large, with its download first.
 */
export type CardFocus = "caption" | "cover" | "trim" | "gif";

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
  audioOnly = false,
  focus,
  onReset,
}: {
  locale: Locale;
  result: ReelResult;
  dict: PreviewDict;
  downloadDict: DownloadDict;
  errorsDict: ErrorsDict;
  platform: PlatformId;
  platformName: string;
  /** True on /audio-downloader: only ever offer the separate audio track, never the video file. */
  audioOnly?: boolean;
  focus?: CardFocus;
  onReset: () => void;
}) {
  // The share row appears only after the visitor has actually saved something.
  const [downloaded, setDownloaded] = useState(false);
  const items = result.items ?? [];
  const isCarousel = items.length > 1;
  const isPhoto = result.kind === "image" && !isCarousel;
  // Heading: a photo post (one photo, or a carousel of photos only) says so; anything with a video keeps "video".
  const allPhotos = isCarousel ? items.every((item) => item.kind === "image") : isPhoto;
  const filename = isPhoto ? downloadFilename(result.id, "image", result.imageExt) : downloadFilename(result.id);

  // `src` lets the server fall back to streaming through the scraper if the CDN refuses it.
  const videoHref = buildDownloadHref({
    url: result.videoUrl,
    id: result.id,
    src: result.sourceUrl,
    ...(isPhoto ? { kind: "image" as const, ext: result.imageExt } : {}),
  });
  // Its own audio track when it has one, else the sound taken out of the video; a photo has none.
  const audioHref = isPhoto ? null : buildAudioHref(result, result.sourceUrl);
  const audioFormat = (result.audioUrl ? result.audioExt ?? "m4a" : "m4a").toUpperCase();

  const durationLabel =
    result.durationSeconds != null ? formatDuration(result.durationSeconds) : null;
  // yt-dlp names a post with no caption "Video by <user>" / "Post by <user>": that is a placeholder, not a caption.
  const caption = result.title && !PLACEHOLDER_TITLE.test(result.title.trim()) ? snippet(result.title) : null;

  // An inline player for a single video. Not on the audio page (its 3-dots menu would offer the video file
  // there), and not for links bound to the scraper's IP (YouTube): the browser can't play those itself, and
  // streaming them through the site would pull every play through the paid proxy. Those keep the thumbnail.
  const showPlayer =
    focus !== "cover" && !isCarousel && !isPhoto && !audioOnly && Boolean(result.videoUrl) && !isIpBoundHost(result.videoUrl);

  // The whole caption for the copy buttons; the short `title` when that's all a source gave.
  const fullCaption = result.caption?.trim() || caption;
  // The post's cover picture, for a video (a photo already downloads as itself).
  const coverExt = result.thumbnailUrl ? imageExtOf(result.thumbnailUrl) : "jpg";
  const coverHref =
    result.thumbnailUrl && !isPhoto && !audioOnly
      ? buildDownloadHref({ url: result.thumbnailUrl, id: `${result.id}-cover`, kind: "image", ext: coverExt })
      : null;
  const coverButton = coverHref ? (
    <DownloadButton
      href={coverHref}
      filename={downloadFilename(`${result.id}-cover`, "image", coverExt)}
      label={dict.downloadCover.replaceAll("{format}", coverExt.toUpperCase())}
      variant={focus === "cover" ? "primary" : "compact-secondary"}
      dict={downloadDict}
      errorsDict={errorsDict}
      platformName={platformName}
      onSaved={() => setDownloaded(true)}
    />
  ) : null;

  return (
    <div className="glass mt-6 w-full max-w-md animate-fade-in-up rounded-2xl p-4 shadow-glow">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-zinc-50">
          {audioOnly ? dict.audioTitle : allPhotos ? dict.photoTitle : dict.title}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] font-medium text-zinc-300">
            <PlatformIcon id={platform} className="h-3 w-3" />
            {platformName}
          </span>
          {/* The resolution badge describes the video stream; it has no meaning on the audio-only card. */}
          {result.quality && !isCarousel && !audioOnly && (
            <span className="rounded-full border border-brand-500/40 bg-brand-500/10 px-2 py-0.5 text-[11px] font-semibold text-brand-300">
              {result.quality}
            </span>
          )}
        </div>
      </div>

      {focus === "cover" && coverHref && (
        <div className="mb-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- the platform's own cover, shown as-is */}
          <img
            src={result.thumbnailUrl}
            alt={caption ?? dict.thumbnailAlt}
            className="mx-auto block max-h-[60vh] w-full rounded-xl bg-black object-contain"
          />
          <div className="mt-3">{coverButton}</div>
        </div>
      )}

      {showPlayer && (
        <div className="mb-3">
          <VideoPreview
            src={result.videoUrl}
            fallbackSrc={videoHref}
            poster={result.thumbnailUrl}
            label={caption ?? dict.thumbnailAlt}
            vertical={VERTICAL_PLATFORMS.includes(platform)}
          />
        </div>
      )}

      <div className="flex gap-4">
        {!isCarousel && !showPlayer && focus !== "cover" && (
          <div
            className={`relative w-24 shrink-0 overflow-hidden rounded-xl bg-zinc-800 sm:w-28 ${isPhoto ? "aspect-[4/5]" : "aspect-[9/16]"}`}
          >
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
          {caption && focus !== "caption" && <p className="text-zinc-400">{caption}</p>}
        </div>
      </div>

      {fullCaption && !audioOnly && (
        <CaptionTools caption={fullCaption} dict={dict} expanded={focus === "caption"} />
      )}

      {isCarousel ? (
        <ItemsSlider
          items={items}
          dict={dict}
          downloadDict={downloadDict}
          errorsDict={errorsDict}
          platformName={platformName}
          audioOnly={audioOnly}
          onDownloaded={() => setDownloaded(true)}
        />
      ) : (
        <>
          {/* Only meaningful for the video button below; the audio-only card has its own fallback instead. */}
          {result.warning === "NO_AUDIO" && !audioOnly && (
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

          {audioOnly && !audioHref ? (
            <p className="mt-4 text-center text-xs leading-relaxed text-zinc-500">{dict.audioUnavailable}</p>
          ) : (
            <div className="mt-4 flex flex-col gap-2">
              <DownloadButton
                href={audioOnly ? audioHref! : videoHref}
                filename={
                  audioOnly ? downloadFilename(result.id, "audio", result.audioExt) : filename
                }
                label={
                  audioOnly
                    ? dict.downloadAudio.replaceAll("{format}", audioFormat)
                    : isPhoto
                      ? dict.downloadPhoto.replaceAll("{format}", (result.imageExt ?? "jpg").toUpperCase())
                      : dict.downloadButton
                }
                dict={downloadDict}
                errorsDict={errorsDict}
                platformName={platformName}
                onSaved={() => setDownloaded(true)}
              />
              {!audioOnly && audioHref && (
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
          )}
        </>
      )}

      {/* Trim / GIF: for a single video (not photos, carousels or the audio page). */}
      {!isCarousel && !isPhoto && !audioOnly && result.videoUrl && (
        <ClipTools
          id={result.id}
          videoUrl={result.videoUrl}
          sourceUrl={result.sourceUrl}
          audioUrl={result.audioUrl}
          durationSeconds={result.durationSeconds}
          focus={focus === "trim" || focus === "gif" ? focus : undefined}
          dict={dict}
          downloadDict={downloadDict}
          errorsDict={errorsDict}
          platformName={platformName}
          onSaved={() => setDownloaded(true)}
        />
      )}

      {/* The cover's download, unless the cover page already shows it first. */}
      {coverButton && focus !== "cover" && <div className="mt-3">{coverButton}</div>}

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
