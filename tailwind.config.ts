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
    extend: {},
  },
  // Typography plugin styles the `prose` class (headings, lists, tables, blockquotes) — used by
  // the eBook reading pane + preview and the Markdown/blog renderers. Without it, Preflight
  // strips list bullets + heading sizes so rich chapter HTML renders as flat lines.
  plugins: [typography],
};

export default config;
