import type { Config } from "tailwindcss";

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
  plugins: [],
};

export default config;
