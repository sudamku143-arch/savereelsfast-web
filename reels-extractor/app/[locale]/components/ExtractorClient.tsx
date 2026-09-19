"use client";

import { useState } from "react";
import { PLATFORM_IDS, type PlatformId } from "@/lib/platforms";
import InputBox from "./InputBox";
import PlatformTabs from "./PlatformTabs";
import SkeletonLoader from "./SkeletonLoader";
import PreviewCard, { type ReelResult } from "./PreviewCard";

type HeroDict = {
  badge: string;
  subtitle: string;
  pasteButton: string;
  downloadCta: string;
  loading: string;
  errorGeneric: string;
  errorInvalid: string;
};

type PlatformsDict = { label: string } & Record<
  PlatformId,
  { name: string; title: string; placeholder: string }
>;

type PreviewDict = {
  title: string;
  author: string;
  duration: string;
  downloadButton: string;
  newSearch: string;
  thumbnailAlt: string;
};

export default function ExtractorClient({
  heroDict,
  platformsDict,
  previewDict,
}: {
  heroDict: HeroDict;
  platformsDict: PlatformsDict;
  previewDict: PreviewDict;
}) {
  const [platform, setPlatform] = useState<PlatformId>("instagram");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle"
  );
  const [result, setResult] = useState<ReelResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const names = Object.fromEntries(
    PLATFORM_IDS.map((id) => [id, platformsDict[id].name])
  ) as Record<PlatformId, string>;

  async function handleSubmit(url: string) {
    setStatus("loading");
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setError(data.error ?? heroDict.errorGeneric);
        setStatus("error");
        return;
      }

      setResult(data as ReelResult);
      setStatus("done");
    } catch {
      setError(heroDict.errorGeneric);
      setStatus("error");
    }
  }

  function handleReset() {
    setStatus("idle");
    setResult(null);
    setError(null);
  }

  function handleSelectPlatform(id: PlatformId) {
    setPlatform(id);
    if (status === "error") {
      setStatus("idle");
      setError(null);
    }
  }

  const active = platformsDict[platform];

  return (
    <div className="flex w-full flex-col items-center">
      <span className="mb-4 rounded-full bg-brand-500/10 px-3 py-1 text-xs font-semibold text-brand-300 ring-1 ring-brand-500/30">
        {heroDict.badge}
      </span>
      <h1 className="max-w-2xl text-center text-3xl font-extrabold tracking-tight text-zinc-50 sm:text-5xl">
        {active.title}
      </h1>
      <p className="mt-4 max-w-xl text-center text-sm text-zinc-400 sm:text-base">
        {heroDict.subtitle}
      </p>

      <div className="mt-8 w-full max-w-xl space-y-3">
        <PlatformTabs
          label={platformsDict.label}
          names={names}
          active={platform}
          onSelect={handleSelectPlatform}
        />
        <InputBox
          dict={heroDict}
          placeholder={active.placeholder}
          onSubmit={handleSubmit}
          onDetectPlatform={setPlatform}
          disabled={status === "loading"}
        />
      </div>

      <div className="flex w-full flex-col items-center" aria-live="polite">
        {status === "loading" && <SkeletonLoader label={heroDict.loading} />}

        {status === "error" && error && (
          <p role="alert" className="mt-4 text-center text-sm text-red-400">
            {error}
          </p>
        )}

        {status === "done" && result && (
          <PreviewCard result={result} dict={previewDict} onReset={handleReset} />
        )}
      </div>
    </div>
  );
}
