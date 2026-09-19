"use client";

import { useEffect, useState } from "react";

type Dict = {
  title: string;
  body: string;
  install: string;
  dismiss: string;
  iosHint: string;
};

// Chromium's install event isn't in the DOM typings.
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const VISITS_KEY = "srf:visits";
const SESSION_KEY = "srf:session-counted";
const DISMISSED_KEY = "srf:install-dismissed";
const MIN_VISITS = 2; // only ask people who came back
const DISMISS_DAYS = 14;

function readNumber(storage: Storage, key: string): number {
  const value = Number(storage.getItem(key));
  return Number.isFinite(value) ? value : 0;
}

export default function InstallPrompt({ dict }: { dict: Dict }) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [returning, setReturning] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    // Register the (cache-free) service worker that makes the site installable.
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) return; // already installed

    // Storage can throw (private mode, blocked cookies): the prompt just stays hidden.
    try {
      if (!sessionStorage.getItem(SESSION_KEY)) {
        sessionStorage.setItem(SESSION_KEY, "1");
        localStorage.setItem(VISITS_KEY, String(readNumber(localStorage, VISITS_KEY) + 1));
      }
      setReturning(readNumber(localStorage, VISITS_KEY) >= MIN_VISITS);

      const dismissedAt = readNumber(localStorage, DISMISSED_KEY);
      setDismissed(
        dismissedAt > 0 && Date.now() - dismissedAt < DISMISS_DAYS * 24 * 60 * 60 * 1000
      );
    } catch {
      return;
    }

    const ua = navigator.userAgent;
    const isIos = /iphone|ipad|ipod/i.test(ua);
    const isIosSafari = isIos && /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
    setShowIosHint(isIosSafari); // iOS has no install event: show the manual steps instead

    function onBeforeInstall(event: Event) {
      event.preventDefault(); // keep the browser's own mini-infobar out of the way
      setDeferred(event as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setDeferred(null);
      setShowIosHint(false);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    } catch {
      // ignore
    }
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    setDeferred(null);
    if (choice.outcome === "dismissed") dismiss();
  }

  if (dismissed || !returning || (!deferred && !showIosHint)) return null;

  return (
    <aside
      role="dialog"
      aria-label={dict.title}
      className="fixed inset-x-0 bottom-0 z-50 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:hidden"
    >
      <div className="glass mx-auto flex max-w-md animate-fade-in-up items-center gap-3 rounded-2xl bg-zinc-900/90 p-3 shadow-xl">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/api/icon?size=192"
          alt=""
          width={40}
          height={40}
          className="h-10 w-10 shrink-0 rounded-xl"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-50">{dict.title}</p>
          <p className="text-xs leading-snug text-zinc-400">
            {deferred ? dict.body : dict.iosHint}
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          {deferred && (
            <button
              type="button"
              onClick={install}
              className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white outline-none transition hover:bg-brand-400 focus-visible:ring-2 focus-visible:ring-brand-300"
            >
              {dict.install}
            </button>
          )}
          <button
            type="button"
            onClick={dismiss}
            className="rounded-lg px-3 py-1 text-xs text-zinc-400 outline-none transition hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {dict.dismiss}
          </button>
        </div>
      </div>
    </aside>
  );
}
