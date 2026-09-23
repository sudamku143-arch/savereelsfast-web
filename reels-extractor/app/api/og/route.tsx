import { ImageResponse } from "next/og";

export const runtime = "edge";

// Fixed wording per platform and language. The query string only selects from this table,
// so nobody can put their own text on an image served from our domain.
const NAMES: Record<string, string> = {
  instagram: "Instagram Reels",
  youtube: "YouTube",
  facebook: "Facebook",
  threads: "Threads",
  twitter: "Twitter (X)",
  pinterest: "Pinterest",
  tiktok: "TikTok",
  reddit: "Reddit",
  snapchat: "Snapchat Spotlight",
  linkedin: "LinkedIn",
  // Reuses the same "{name} Downloader/Download" templates below - "Audio Downloader", "Descargar Audio", etc.
  audio: "Audio",
};

// The home page covers every platform at once, so its card needs its own headline instead of the
// per-platform "{name} Downloader" template (there is no single {name} to put there).
const HOME_HEADLINE: Record<string, string> = {
  en: "Video & Audio Downloader",
  es: "Descargar Video y Audio",
  pt: "Baixar Vídeo e Áudio",
  id: "Unduh Video & Audio",
  fr: "Télécharger Vidéo et Audio",
  // Same font-glyph limitation as WORDING below: these locales fall back to the English card.
  bn: "Video & Audio Downloader",
  te: "Video & Audio Downloader",
  ta: "Video & Audio Downloader",
  mr: "Video & Audio Downloader",
  ar: "Video & Audio Downloader",
  hi: "Video & Audio Downloader",
};
const WORDING: Record<string, { headline: (name: string) => string; tagline: string }> = {
  en: { headline: (n) => `${n} Downloader`, tagline: "Free · No login · HD when available" },
  es: { headline: (n) => `Descargar ${n}`, tagline: "Gratis · Sin iniciar sesión · HD si existe" },
  pt: { headline: (n) => `Baixar ${n}`, tagline: "Grátis · Sem login · HD quando disponível" },
  // The image renderer's built-in font has no Devanagari glyphs, so the Hindi card uses Latin script.
  // The renderer's font lacks these scripts too; the Latin card still names the platform.
  bn: { headline: (n) => `${n} Download`, tagline: "Free · No login · HD when available" },
  te: { headline: (n) => `${n} Download`, tagline: "Free · No login · HD when available" },
  ta: { headline: (n) => `${n} Download`, tagline: "Free · No login · HD when available" },
  mr: { headline: (n) => `${n} Download`, tagline: "Free · No login · HD when available" },
  ar: { headline: (n) => `${n} Download`, tagline: "Free · No login · HD when available" },
  id: { headline: (n) => `Unduh ${n}`, tagline: "Gratis · Tanpa login · HD jika tersedia" },
  fr: { headline: (n) => `Télécharger ${n}`, tagline: "Gratuit · Sans connexion · HD si disponible" },
  hi: { headline: (n) => `${n} Download`, tagline: "Free · No login · HD when available" },
};

/** 1200×630 social preview image used for og:image / twitter:image. */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const platform = query.get("p") ?? "";
  const locale = query.get("l") ?? "en";
  const wording = WORDING[locale] ?? WORDING.en;
  // The home page gets its own catchy, multi-platform headline; every other (including unrecognized)
  // key falls back to a specific platform's card rather than a blank one.
  const headline =
    platform === "home"
      ? (HOME_HEADLINE[locale] ?? HOME_HEADLINE.en)
      : wording.headline(NAMES[platform] ?? NAMES.instagram);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background:
            "radial-gradient(circle at 50% 0%, #5b1a3a 0%, #09090b 65%)",
          color: "#fafafa",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 128,
            height: 128,
            borderRadius: 32,
            background: "linear-gradient(135deg, #f2609a, #813cff)",
            fontSize: 72,
            marginBottom: 36,
          }}
        >
          ▶
        </div>
        <div style={{ display: "flex", fontSize: 76, fontWeight: 800 }}>
          SaveReels
          <span style={{ color: "#f2609a" }}>Fast</span>
        </div>
        <div style={{ marginTop: 20, fontSize: 38, color: "#a1a1aa" }}>
          {headline}
        </div>
        <div style={{ marginTop: 12, fontSize: 28, color: "#71717a" }}>
          {wording.tagline}
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      // Fixed wording per (p, l) pair: safe to cache hard, so WhatsApp/Telegram/Facebook's crawler gets it
      // back instantly instead of waiting on edge rendering for every link preview.
      headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    }
  );
}
