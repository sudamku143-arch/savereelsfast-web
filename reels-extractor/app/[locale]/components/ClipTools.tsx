"use client";

import { useState } from "react";
import { buildDownloadHref, downloadFilename, GIF_MAX_SECONDS, type ClipWindow } from "@/lib/download";
import DownloadButton, { type DownloadDict } from "./DownloadButton";
import type { ErrorsDict } from "./ErrorCard";

export type ClipDict = {
  clipToggle: string;
  clipStart: string;
  clipEnd: string;
  /** "{n}" is replaced with the clip's length in seconds. */
  clipLength: string;
  clipVideo: string;
  clipAudio: string;
  clipGif: string;
  /** "{n}" is replaced with the GIF length cap. */
  clipGifNote: string;
  clipKeyframeNote: string;
};

/** 75 -> "1:15.0" */
function clock(value: number): string {
  const tenths = Math.round(value * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths % 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

/**
 * Cut a part of the video: as an MP4 clip, as M4A audio, or as a small GIF (made on the server with ffmpeg).
 * `focus` opens it straight away and puts its main button first (the trimmer and GIF pages); elsewhere it
 * sits folded behind one button.
 */
export default function ClipTools({
  id,
  videoUrl,
  sourceUrl,
  audioUrl,
  durationSeconds,
  focus,
  dict,
  downloadDict,
  errorsDict,
  platformName,
  onSaved,
}: {
  id: string;
  videoUrl: string;
  sourceUrl?: string;
  /** The post's separate audio track, when it has one: an audio clip is cut from it instead of the video. */
  audioUrl?: string;
  durationSeconds: number | null;
  focus?: "trim" | "gif";
  dict: ClipDict;
  downloadDict: DownloadDict;
  errorsDict: ErrorsDict;
  platformName: string;
  onSaved: () => void;
}) {
  const total = durationSeconds && durationSeconds > 0 ? durationSeconds : null;
  const max = total ?? 600;
  const [open, setOpen] = useState(Boolean(focus));
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(Math.min(max, focus === "gif" ? GIF_MAX_SECONDS : total ?? 15));

  const clipWindow: ClipWindow = { start, end: Math.max(end, start + 0.5) };
  const gifWindow: ClipWindow = { start, end: Math.min(clipWindow.end, start + GIF_MAX_SECONDS) };
  const length = Math.round((clipWindow.end - clipWindow.start) * 10) / 10;

  const videoHref = buildDownloadHref({ url: videoUrl, id: `${id}-clip`, src: sourceUrl, clip: clipWindow });
  const audioHref = audioUrl
    ? buildDownloadHref({ url: audioUrl, id: `${id}-clip`, src: sourceUrl, kind: "audio", ext: "m4a", clip: clipWindow })
    : buildDownloadHref({ url: videoUrl, id: `${id}-clip`, src: sourceUrl, kind: "audio", ext: "m4a", extract: true, clip: clipWindow });
  const gifHref = buildDownloadHref({ url: videoUrl, id, src: sourceUrl, kind: "gif", clip: gifWindow });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 w-full rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-zinc-300 outline-none transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        ✂ {dict.clipToggle}
      </button>
    );
  }

  const slider = "w-full accent-brand-500";
  const gifButton = (
    <DownloadButton
      key={gifHref}
      href={gifHref}
      filename={downloadFilename(id, "gif")}
      label={dict.clipGif}
      variant={focus === "gif" ? "primary" : "secondary"}
      dict={downloadDict}
      errorsDict={errorsDict}
      platformName={platformName}
      onSaved={onSaved}
    />
  );
  const clipButton = (
    <DownloadButton
      key={videoHref}
      href={videoHref}
      filename={downloadFilename(`${id}-clip`)}
      label={dict.clipVideo}
      variant={focus === "trim" ? "primary" : "secondary"}
      dict={downloadDict}
      errorsDict={errorsDict}
      platformName={platformName}
      onSaved={onSaved}
    />
  );

  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <div className="space-y-3 text-xs text-zinc-300">
        <label className="block">
          <span className="flex justify-between">
            <span>{dict.clipStart}</span>
            <span className="tabular-nums text-zinc-100">{clock(start)}</span>
          </span>
          <input
            type="range"
            min={0}
            max={max}
            step={0.1}
            value={start}
            onChange={(e) => {
              const value = Number(e.target.value);
              setStart(value);
              if (end <= value + 0.5) setEnd(Math.min(max, value + (focus === "gif" ? GIF_MAX_SECONDS : 5)));
            }}
            className={slider}
          />
        </label>
        <label className="block">
          <span className="flex justify-between">
            <span>{dict.clipEnd}</span>
            <span className="tabular-nums text-zinc-100">{clock(clipWindow.end)}</span>
          </span>
          <input
            type="range"
            min={0}
            max={max}
            step={0.1}
            value={end}
            onChange={(e) => setEnd(Math.max(Number(e.target.value), start + 0.5))}
            className={slider}
          />
        </label>
        <p className="text-zinc-400">{dict.clipLength.replaceAll("{n}", String(length))}</p>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {focus === "gif" ? gifButton : clipButton}
        <DownloadButton
          key={audioHref}
          href={audioHref}
          filename={downloadFilename(`${id}-clip`, "audio", "m4a")}
          label={dict.clipAudio}
          variant="secondary"
          dict={downloadDict}
          errorsDict={errorsDict}
          platformName={platformName}
          onSaved={onSaved}
        />
        {focus === "gif" ? clipButton : gifButton}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
        {dict.clipGifNote.replaceAll("{n}", String(GIF_MAX_SECONDS))} {dict.clipKeyframeNote}
      </p>
    </div>
  );
}
