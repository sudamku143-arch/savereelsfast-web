import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

export const runtime = "edge";

const SIZES = [180, 192, 512];

/**
 * App icon for the PWA manifest and apple-touch-icon.
 *   /api/icon?size=192|512|180
 *   /api/icon?size=512&maskable=1   (full-bleed, artwork kept inside the safe zone)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const requested = Number(searchParams.get("size"));
  const size = SIZES.includes(requested) ? requested : 512;
  const maskable = searchParams.get("maskable") === "1";

  // Maskable icons may be cropped to a circle: keep the artwork in the central 60%.
  const artwork = size * (maskable ? 0.5 : 0.62);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #f2609a 0%, #813cff 100%)",
          borderRadius: maskable ? 0 : size * 0.22,
        }}
      >
        <svg width={artwork} height={artwork} viewBox="0 0 32 32" fill="none">
          <path
            d="M11 6.5v13.2a1 1 0 0 0 1.5.86l10.8-6.6a1 1 0 0 0 0-1.72L12.5 5.64A1 1 0 0 0 11 6.5Z"
            fill="#ffffff"
          />
          <path d="M9 26h16" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
      </div>
    ),
    {
      width: size,
      height: size,
      headers: { "Cache-Control": "public, max-age=604800, immutable" },
    }
  );
}
