import { ImageResponse } from "next/og";

export const runtime = "edge";

/** 1200×630 social preview image used for og:image / twitter:image. */
export async function GET() {
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
          Free Instagram Reels Downloader
        </div>
        <div style={{ marginTop: 12, fontSize: 28, color: "#71717a" }}>
          No login · No watermark · HD
        </div>
      </div>
    ),
    { width: 1200, height: 630 }
  );
}
