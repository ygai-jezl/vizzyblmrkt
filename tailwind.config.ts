import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    // lib holds class-name maps (e.g. widget/textSize.ts) whose literal Tailwind
    // classes — including arbitrary values like text-[0.6875rem] — must be scanned
    // here or they're silently purged from the build.
    "./src/lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      // Marketing homepage design tokens: Vizzybl-website dark surfaces with a
      // Typewise blue→cyan accent. Namespaced under `brand-*` so they never shadow
      // Tailwind's built-in palettes (blue/sky/cyan/emerald, whose shades supply the
      // accents/gradients directly). Additive — used only by src/components/marketing/*.
      colors: {
        brand: {
          bg: "#0a0a0f",
          surface: "#141419",
          raised: "#1e1e28",
          line: "#2a2a38",
          muted: "#a0a0b8",
          faint: "#6a6a82",
          sky: "#7dd3fc", // light-blue tail for the white→sky stat gradient
        },
      },
      fontFamily: {
        // Display face wired up (self-hosted) in src/app/page.tsx via next/font.
        display: ["var(--font-display)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        // The signature "glow" on hover-lift cards — Typewise blue.
        glow: "0 8px 24px rgba(37,99,235,0.30)",
        "glow-soft": "0 12px 40px rgba(37,99,235,0.18)",
      },
    },
  },
  // Typography plugin styles the `prose` class (headings, lists, tables, blockquotes) — used by
  // the eBook reading pane + preview and the Markdown/blog renderers. Without it, Preflight
  // strips list bullets + heading sizes so rich chapter HTML renders as flat lines.
  plugins: [typography],
};

export default config;
