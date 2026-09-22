# SaveReelsFast

**Fast, free video downloader for Instagram, YouTube, TikTok, Facebook and 6 more platforms — no login, no app.**

[![Live Site](https://img.shields.io/badge/Live%20Site-savereelsfast.com-ec4899?logo=googlechrome&logoColor=white)](https://www.savereelsfast.com)
[![Next.js](https://img.shields.io/badge/Next.js-14-black?logo=next.js&logoColor=white)](https://nextjs.org/)
[![Deployed on Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-000000?logo=vercel&logoColor=white)](https://vercel.com/)
[![License: Proprietary](https://img.shields.io/badge/License-Proprietary-lightgrey)](#license)

🔗 **Live site:** [www.savereelsfast.com](https://www.savereelsfast.com)

---

## About

SaveReelsFast is a web app that saves a public video from a pasted link as an
MP4 — the same file the platform itself serves for playback, in the quality
it provides for that post. No account, browser extension or app install is
needed, and it works the same on a phone, tablet or desktop. The site is
available in 11 languages and is not affiliated with, endorsed by or
sponsored by any of the platforms it works with.

## Features

- **10 platforms in one tool** — Instagram, YouTube, Facebook, Threads,
  X (Twitter), Pinterest, TikTok, Reddit, Snapchat and LinkedIn.
- **HD when available** — downloads the video in the best quality the
  platform provides for that post; nothing is upscaled or re-encoded.
- **No watermark added by us** — the file is the platform's own, untouched.
- **Free, no login, no app** — paste a link and download; nothing to install.
- **Audio-only downloads** — where a platform serves a separate audio track
  (e.g. Instagram Reels, YouTube Shorts), it can be saved on its own too.
- **Works everywhere** — an installable PWA, 11 languages, and a
  [Telegram bot](https://t.me/savereelsfast_bot) for downloading from chat.
- **Guides and tips** — a [blog](https://www.savereelsfast.com/blog) with
  platform-specific how-tos.

## Screenshot

_No screenshot or demo GIF exists in this repo yet._ To add one: open
[savereelsfast.com](https://www.savereelsfast.com) on desktop, paste a public
video link (e.g. an Instagram Reel) so the result preview card is visible,
and capture the hero + result area (about 1280×720). Save it as
`docs/screenshot.png` (or `docs/demo.gif` for a short paste-to-download
recording), then this line can be replaced with:

```markdown
![SaveReelsFast screenshot](docs/screenshot.png)
```

## Tech stack

**Frontend** — [Next.js 14](https://nextjs.org/) (App Router, TypeScript),
Tailwind CSS. Statically generated, 11-language i18n, PWA install support.
Deployed on **[Vercel](https://vercel.com/)**.

**Backend** — Python + [FastAPI](https://fastapi.tiangolo.com/), using
[yt-dlp](https://github.com/yt-dlp/yt-dlp) to resolve video links across all
10 platforms, with an optional [Cobalt](https://github.com/imputnet/cobalt)
fallback for YouTube when the primary lookup fails. Deployed on
**[Render](https://render.com/)**.

**Other** — Google Analytics 4 (consent-gated), a Telegram bot
(`telegram_bot.py`) built on the same backend, and scheduled blog publishing
via a GitHub Actions → Vercel deploy hook.

## Project structure

```
reels-extractor/   Next.js frontend (app router, i18n, blog, landing pages)
scraper/            FastAPI backend (yt-dlp extraction, caching, Telegram bot)
```

Each has its own `README.md` / inline docs for that subproject's setup.

## Getting started

This is a personal/commercial project, not built for outside contributors —
setup below is for reference (a new machine, a collaborator), not a general
open-source quickstart.

```bash
# frontend
cd reels-extractor
npm install
npm run dev        # http://localhost:3000

# backend
cd scraper
pip install -r requirements.txt
uvicorn main:app --reload
```

The frontend needs a running scraper URL and, for some features, a handful
of environment variables (ad network keys, GA4 ID, Telegram bot token,
proxy/Cobalt settings for YouTube). None of those are required just to run
the UI locally.

## License

No license file is published in this repository, so by default all rights
are reserved — the source is visible, but it is not licensed for reuse,
modification or redistribution.

---

Built and maintained by [**@sudamku143-arch**](https://github.com/sudamku143-arch).
