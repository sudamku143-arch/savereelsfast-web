import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#fdf2f8",
          300: "#f9a8c9",
          400: "#f2609a",
          500: "#da2c67", // white text on it reaches 4.6:1 (WCAG AA); the original #e1306c fell just short at 4.3:1
          600: "#c81d5c",
          700: "#a3134a",
        },
      },
      boxShadow: {
        glow: "0 0 24px -4px rgba(225, 48, 108, 0.65)",
        "glow-lg": "0 0 36px -2px rgba(225, 48, 108, 0.8)",
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
      },
      animation: {
        shimmer: "shimmer 2s infinite linear",
        "fade-in-up": "fade-in-up 0.3s ease-out both",
        indeterminate: "indeterminate 1.3s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
export default config;
