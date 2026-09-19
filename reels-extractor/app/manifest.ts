import type { MetadataRoute } from "next";
import { SITE_NAME } from "@/lib/site";

// Served at /manifest.webmanifest and linked from every page automatically.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: SITE_NAME,
    short_name: SITE_NAME,
    description:
      "Download videos from Instagram, YouTube, Facebook, Threads, X, Pinterest, TikTok, Reddit and Snapchat.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#09090b",
    theme_color: "#09090b",
    categories: ["utilities", "social"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Full-bleed artwork inside the safe zone, so Android can crop it to any shape.
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
