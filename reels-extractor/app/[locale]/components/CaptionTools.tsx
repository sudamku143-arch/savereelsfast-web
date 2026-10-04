"use client";

import { useState } from "react";
import { extractHashtags } from "@/lib/caption";

export type CaptionDict = {
  captionHeading: string;
  copyCaption: string;
  /** "{n}" is replaced with the number of hashtags. */
  copyHashtags: string;
  copied: string;
  copyFailed: string;
};

/** Clipboard API where allowed, else the old select-and-copy way (older Safari, some in-app browsers). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

const BUTTON =
  "rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-200 outline-none transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand-500";

/**
 * Copy the post's whole caption, or only its hashtags. `expanded` (the caption copier page) also shows the
 * full caption in a box; elsewhere it's just the two buttons.
 */
export default function CaptionTools({
  caption,
  dict,
  expanded = false,
}: {
  caption: string;
  dict: CaptionDict;
  expanded?: boolean;
}) {
  const [status, setStatus] = useState<{ which: "caption" | "tags"; ok: boolean } | null>(null);
  const tags = extractHashtags(caption);

  async function copy(which: "caption" | "tags") {
    const ok = await copyText(which === "caption" ? caption : tags.join(" "));
    setStatus({ which, ok });
    window.setTimeout(() => setStatus(null), 2000);
  }

  const label = (which: "caption" | "tags", text: string) =>
    status?.which === which ? (status.ok ? `✓ ${dict.copied}` : dict.copyFailed) : text;

  return (
    <div className={expanded ? "mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-3" : ""}>
      {expanded && (
        <>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">{dict.captionHeading}</p>
          <p className="mb-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-200">
            {caption}
          </p>
        </>
      )}
      <div className="flex flex-wrap gap-2" aria-live="polite">
        <button type="button" onClick={() => copy("caption")} className={BUTTON}>
          {label("caption", dict.copyCaption)}
        </button>
        {tags.length > 0 && (
          <button type="button" onClick={() => copy("tags")} className={BUTTON}>
            {label("tags", dict.copyHashtags.replaceAll("{n}", String(tags.length)))}
          </button>
        )}
      </div>
    </div>
  );
}
