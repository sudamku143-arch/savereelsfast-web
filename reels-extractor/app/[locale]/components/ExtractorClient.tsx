"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PLATFORM_IDS, parseSupportedUrl, type PlatformId } from "@/lib/platforms";
import type { PlatformInfo } from "@/lib/platform-info";
import type { Locale } from "@/lib/i18n-config";
import { isErrorCode } from "@/lib/errors";
import {
  getCachedResult,
  getDraft,
  getLastViewed,
  putCachedResult,
  setDraft,
  setLastViewed,
} from "@/lib/result-cache";
import InputBox from "./InputBox";
import ModeSwitcher, { type ModeSwitcherDict } from "./ModeSwitcher";
import PlatformTabs from "./PlatformTabs";
import SkeletonLoader from "./SkeletonLoader";
import PreviewCard, { type PreviewDict, type ReelResult } from "./PreviewCard";
import ErrorCard, { type ErrorsDict, type UiErrorCode } from "./ErrorCard";
import type { DownloadDict } from "./DownloadButton";
import AdBanner, { type AdDict } from "./AdBanner";

type HeroDict = {
  badge: string;
  trust: { noLogin: string; hd: string; privacy: string };
  subtitle: string;
  pasteButton: string;
  downloadCta: string;
  loading: string;
  processing: string;
  working: string;
  steps: string[];
  slow: string;
  errorGeneric: string;
  errorInvalid: string;
};

type PlatformsDict = { label: string } & Record<
  PlatformId,
  { name: string; title: string; placeholder: string }
>;

// The site gives up on the scraper after 7 s (which itself stops at 5 s), so a lookup that is still open
// after this long is dead: show a clear message instead of a spinner.
const EXTRACT_TIMEOUT_MS = 10_000;
// YouTube lookups may legitimately take longer (see /api/extract), so the page waits longer for those only.
const YOUTUBE_EXTRACT_TIMEOUT_MS = 25_000;
// Platforms whose files aren't reliably HD (YouTube's fast route tops out at 360p, LinkedIn reports no
// resolution), so the "HD quality" badge is left off for them rather than overpromise.
const NO_HD_BADGE: PlatformId[] = ["youtube", "linkedin"];

function TrustIcon({ kind }: { kind: "check" | "sparkles" | "lock" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-brand-300">
      {kind === "check" && <path d="M20 6 9 17l-5-5" />}
      {kind === "sparkles" && (
        <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" />
      )}
      {kind === "lock" && (
        <>
          <rect x="4" y="11" width="16" height="10" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </>
      )}
    </svg>
  );
}

export default function ExtractorClient({
  locale,
  heroDict,
  platformsDict,
  previewDict,
  errorsDict,
  downloadDict,
  adDict,
  modeSwitcherDict,
  platformInfo,
  initialPlatform = "instagram",
  landing = false,
  audioOnly = false,
  heroHeading,
  heroLead,
}: {
  locale: Locale;
  heroDict: HeroDict;
  platformsDict: PlatformsDict;
  previewDict: PreviewDict;
  errorsDict: ErrorsDict;
  downloadDict: DownloadDict;
  adDict: AdDict;
  /** The pill that jumps between the video downloader and the audio-only one. */
  modeSwitcherDict: ModeSwitcherDict;
  /** Heading, intro, helper text, title and address of every platform: what a tab switch shows at once. */
  platformInfo: Record<PlatformId, PlatformInfo>;
  /** Platform tab selected on first render (platform landing pages preselect theirs). */
  initialPlatform?: PlatformId;
  /** True on a platform's own page, whose heading follows the active tab from the start. */
  landing?: boolean;
  /** True on /audio-downloader: the result card only ever offers the separate audio track, never the video file. */
  audioOnly?: boolean;
  /**
   * Replaces the default heading/intro (the active tab's own title/subtitle) until the visitor picks a tab,
   * for a page whose own topic isn't any single platform (e.g. the audio downloader, which works with all of
   * them). Ignored once a tab is chosen, or on a platform's own page (`landing`), same as the default heading.
   */
  heroHeading?: string;
  heroLead?: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  // Until a tab is chosen the home page keeps its own heading; a landing page always follows the tab.
  const [switched, setSwitched] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [platform, setPlatform] = useState<PlatformId>(initialPlatform);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle"
  );
  const [result, setResult] = useState<ReelResult | null>(null);
  const [errorCode, setErrorCode] = useState<UiErrorCode | null>(null);
  // Remounting the input clears it; "Try again" reuses the last link.
  const [inputKey, setInputKey] = useState(0);
  const [restoredUrl, setRestoredUrl] = useState("");
  const lastUrlRef = useRef<string | null>(null);

  const names = Object.fromEntries(
    PLATFORM_IDS.map((id) => [id, platformsDict[id].name])
  ) as Record<PlatformId, string>;

  // Coming back to the page (browser back, reload) shows the last result again
  // straight from sessionStorage: no spinner, no request.
  useEffect(() => {
    const last = getLastViewed<ReelResult>();
    if (!last) {
      // No result on screen: bring back a link that was being typed when a tab switch loaded this page.
      const draft = getDraft();
      if (draft) {
        setRestoredUrl(draft);
        setInputKey((k) => k + 1);
      }
      return;
    }
    lastUrlRef.current = last.url;
    setResult(last.result);
    setStatus("done");
    // A platform page shows its own platform; only the home page follows the result.
    if (last.result.platform && !landing) setPlatform(last.result.platform);
    setRestoredUrl(last.url);
    setInputKey((k) => k + 1);
    // Runs once on arrival: `landing` never changes for a mounted page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(url: string) {
    lastUrlRef.current = url;
    setErrorCode(null);

    // One of the last five successful lookups: render it instantly.
    const cached = getCachedResult<ReelResult>(url);
    if (cached) {
      setResult(cached);
      setStatus("done");
      if (cached.platform) setPlatform(cached.platform);
      setLastViewed(url);
      return;
    }

    setStatus("loading");
    setResult(null);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, parseSupportedUrl(url)?.platform === "youtube" ? YOUTUBE_EXTRACT_TIMEOUT_MS : EXTRACT_TIMEOUT_MS);

    try {
      // GET, so identical lookups can be cached by the CDN (see /api/extract).
      const res = await fetch(`/api/extract?url=${encodeURIComponent(url)}`, { signal: controller.signal });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setErrorCode(isErrorCode(data.code) ? data.code : "EXTRACTION_FAILED");
        setStatus("error");
        return;
      }

      const fresh = data as ReelResult;
      putCachedResult(url, fresh);
      setLastViewed(url);
      setResult(fresh);
      setStatus("done");
    } catch {
      if (controller.signal.aborted && !timedOut) return; // cancelled on purpose (a tab switch)
      setErrorCode(timedOut ? "PLATFORM_TIMEOUT" : "NETWORK");
      setStatus("error");
    } finally {
      clearTimeout(timer);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  /** Back to a clean slate: no result, no error, empty input. */
  function handleReset() {
    setStatus("idle");
    setResult(null);
    setErrorCode(null);
    lastUrlRef.current = null;
    setLastViewed(null); // the cached results stay: pasting the same link again is still instant
    setDraft(null);
    setRestoredUrl("");
    setInputKey((k) => k + 1);
  }

  function handleRetry() {
    if (lastUrlRef.current) void handleSubmit(lastUrlRef.current);
  }

  /**
   * A tab was clicked. Everything the visitor can see changes at once from data already in the page
   * (placeholder, helper line, heading, intro, tab title); the router then moves to that platform's page in
   * the background, keeping the language, so the address bar, the guide below and the back button follow.
   */
  function handleSelectPlatform(id: PlatformId) {
    const info = platformInfo[id];
    setPlatform(id);
    setSwitched(true);
    document.title = info.metaTitle;

    if (status === "loading") {
      // The pending lookup belongs to the old page; the link stays in the input box for another go.
      abortRef.current?.abort();
      setStatus("idle");
    } else if (status === "error") {
      setStatus("idle");
      setErrorCode(null);
    }

    if (window.location.pathname !== info.href) {
      startTransition(() => router.push(info.href, { scroll: false }));
    }
  }

  const active = platformsDict[platform];
  const follows = landing || switched;
  const hrefs = Object.fromEntries(PLATFORM_IDS.map((id) => [id, platformInfo[id].href])) as Record<
    PlatformId,
    string
  >;

  return (
    <div className="flex w-full flex-col items-center">
      <span className="mb-6 flex animate-hero-in items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-xs font-semibold text-zinc-300 backdrop-blur-xl">
        <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-br from-brand-400 to-violet-400 shadow-glow" aria-hidden="true" />
        {heroDict.badge}
      </span>
      <h1 className="max-w-4xl animate-rise text-balance text-center font-display text-4xl font-bold leading-[1.05] tracking-tight text-zinc-50 sm:text-6xl lg:text-7xl">
        {follows ? platformInfo[platform].h1 : (heroHeading ?? active.title)}
      </h1>
      <p className="mt-6 max-w-2xl animate-hero-in text-balance text-center text-base leading-relaxed text-zinc-400 [animation-delay:120ms] sm:text-lg">
        {follows ? platformInfo[platform].lead : (heroLead ?? heroDict.subtitle)}
      </p>

      <ModeSwitcher locale={locale} dict={modeSwitcherDict} />

      <div className="mt-8 w-full max-w-2xl animate-hero-in space-y-4 [animation-delay:200ms]">
        <PlatformTabs
          label={platformsDict.label}
          names={names}
          hrefs={hrefs}
          active={platform}
          onSelect={handleSelectPlatform}
        />
        <InputBox
          key={inputKey}
          dict={heroDict}
          placeholder={active.placeholder}
          defaultUrl={restoredUrl}
          onSubmit={handleSubmit}
          onDetectPlatform={setPlatform}
          onDraftChange={setDraft}
          disabled={status === "loading"}
        />
        <ul className="flex flex-wrap items-center justify-center gap-2">
          {[
            { kind: "check" as const, text: heroDict.trust.noLogin },
            ...(NO_HD_BADGE.includes(platform) ? [] : [{ kind: "sparkles" as const, text: heroDict.trust.hd }]),
            { kind: "lock" as const, text: heroDict.trust.privacy },
          ].map((badge) => (
            <li
              key={badge.kind}
              className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs font-medium text-zinc-300 backdrop-blur-xl"
            >
              <TrustIcon kind={badge.kind} />
              {badge.text}
            </li>
          ))}
        </ul>
        <p className="px-1 text-center text-xs leading-relaxed text-zinc-500">
          {platformInfo[platform].copyHint}
        </p>
      </div>

      {/* Slot 1: directly under the hero and the search box. */}
      <AdBanner variant="leaderboard" dict={adDict} className="mt-6" />

      <div className="flex w-full flex-col items-center" aria-live="polite">
        {status === "loading" && <SkeletonLoader dict={heroDict} />}

        {status === "error" && errorCode && (
          <ErrorCard
            code={errorCode}
            platformName={active.name}
            dict={errorsDict}
            link={lastUrlRef.current}
            onRetry={handleRetry}
            onClear={handleReset}
          />
        )}

        {status === "done" && result && (
          <>
            <PreviewCard
              locale={locale}
              result={result}
              dict={previewDict}
              downloadDict={downloadDict}
              errorsDict={errorsDict}
              platform={result.platform ?? platform}
              platformName={platformsDict[result.platform ?? platform].name}
              audioOnly={audioOnly}
              onReset={handleReset}
            />
            {/* Slot 2: directly below the download result. */}
            <AdBanner variant="native" dict={adDict} className="mt-4" />
          </>
        )}
      </div>
    </div>
  );
}
