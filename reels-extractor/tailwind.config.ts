import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // The page itself: near-black with a hint of blue, so the pink/violet mesh reads as light, not mud.
        ink: "#050507",
        brand: {
          50: "#fff0f6",
          300: "#ffa3c2",
          400: "#ff6b9d", // accents only (text, glows, gradient starts): white text on it is 2.7:1
          500: "#db2f72", // solid fills behind white text: 4.5:1 (WCAG AA)
          600: "#c42563",
          700: "#a31d52",
        },
        violet: {
          // The gradient's other end. 400 is the accent; 600 is dark enough to carry white text (4.8:1).
          400: "#c084fc",
          500: "#a855f7",
          600: "#9448e8",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-sora)", "var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        glow: "0 0 24px -4px rgba(255, 107, 157, 0.55)",
        "glow-lg": "0 0 40px -4px rgba(255, 107, 157, 0.75)",
        "glow-input": "0 0 20px rgba(255, 107, 157, 0.3)",
        "glow-input-focus": "0 0 32px rgba(255, 107, 157, 0.5), 0 0 64px -12px rgba(192, 132, 252, 0.45)",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-1000px 0" },
          "100%": { backgroundPosition: "1000px 0" },
        },
        indeterminate: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(400%)" },
        },
        "fade-in-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "hero-in": {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        // Transform only, never opacity: the hero heading is the page's LCP element, and a heading that
        // starts at opacity 0 isn't painted (so isn't counted) until the fade ends.
        rise: {
          "0%": { transform: "translateY(14px)" },
          "100%": { transform: "translateY(0)" },
        },
      },
      animation: {
        shimmer: "shimmer 2s infinite linear",
        "fade-in-up": "fade-in-up 0.3s ease-out both",
        "hero-in": "hero-in 0.7s cubic-bezier(0.22, 1, 0.36, 1) both",
        rise: "rise 0.7s cubic-bezier(0.22, 1, 0.36, 1) both",
        indeterminate: "indeterminate 1.3s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
