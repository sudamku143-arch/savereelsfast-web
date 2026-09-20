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
};
const WORDING: Record<string, { headline: (name: string) => string; tagline: string }> = {
  en: { headline: (n) => `${n} Downloader`, tagline: "Free · No login · HD when available" },
  es: { headline: (n) => `Descargar ${n}`, tagline: "Gratis · Sin iniciar sesión · HD si existe" },
  pt: { headline: (n) => `Baixar ${n}`, tagline: "Grátis · Sem login · HD quando disponível" },
  // The image renderer's built-in font has no Devanagari glyphs, so the Hindi card uses Latin script.
  hi: { headline: (n) => `${n} Download`, tagline: "Free · No login · HD when available" },
};

/** 1200×630 social preview image used for og:image / twitter:image. */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const name = NAMES[query.get("p") ?? ""] ?? NAMES.instagram;
  const wording = WORDING[query.get("l") ?? ""] ?? WORDING.en;
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
          {wording.headline(name)}
        </div>
        <div style={{ marginTop: 12, fontSize: 28, color: "#71717a" }}>
          {wording.tagline}
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
