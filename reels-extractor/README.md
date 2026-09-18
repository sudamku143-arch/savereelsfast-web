# Instagram Reels Extractor

Next.js 14 (App Router) + Tailwind CSS, with i18n routing for English (`/`),
Spanish (`/es`), and Portuguese (`/pt`).

## Setup

```bash
npm install
npm run dev
```

Open http://localhost:3000 (English), http://localhost:3000/es (Spanish),
or http://localhost:3000/pt (Portuguese).

## Project structure

```
app/
  [locale]/
    layout.tsx          # root <html>/<body>, generateMetadata per locale
    page.tsx             # hero + extractor + SEO block + FAQ
    components/
      ExtractorClient.tsx # orchestrates input -> API call -> preview/skeleton
      InputBox.tsx         # URL field, paste button, client-side validation
      SkeletonLoader.tsx
      PreviewCard.tsx      # thumbnail, metadata, download button
      SeoContent.tsx
      FaqAccordion.tsx
  api/
    extract/
      route.ts           # POST contract — see inline docblock
lib/
  i18n-config.ts          # locales list + type guards
  get-dictionary.ts       # loads messages/<locale>.json
messages/
  en.json / es.json / pt.json
middleware.ts             # locale detection + rewrite/redirect
```

## Wiring up real extraction

`app/api/extract/route.ts` currently throws inside `extractReelData()` as a
placeholder. Swap that function's body for your actual resolution method
(headless-browser scrape, a licensed extraction API, etc.) — the route's
request/response contract (documented in the file's docblock) does not need
to change.

## i18n notes

- `en` is served unprefixed at `/`.
- `es` and `pt` are served at `/es` and `/pt`.
- `middleware.ts` auto-redirects first-time visitors to `/es` or `/pt` based
  on their browser's `Accept-Language` header; it internally rewrites `/` to
  `/en` so the `[locale]` route segment always has a value.
- Add a new language by: adding it to `locales` in `lib/i18n-config.ts`,
  adding `messages/<locale>.json`, and adding it to `generateStaticParams`
  (automatic, since it reads from `locales`).

## Build

```bash
npm run build
npm run start
```
