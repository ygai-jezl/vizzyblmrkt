import { Geist, Geist_Mono, Noto_Sans_Arabic, Noto_Sans_JP, Unbounded } from "next/font/google";

/**
 * The site's type, self-hosted at build time (no runtime request to Google).
 * Unbounded for display, Geist for text, Geist Mono for labels; Noto Sans JP and
 * Noto Sans Arabic fill in Japanese and Arabic and are only fetched by a page that
 * uses those characters (not preloaded).
 */
const unbounded = Unbounded({ subsets: ["latin", "latin-ext"], variable: "--f-unbounded", display: "swap" });
const geist = Geist({ subsets: ["latin", "latin-ext"], variable: "--f-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin", "latin-ext"], variable: "--f-geist-mono", display: "swap" });
const notoJp = Noto_Sans_JP({ variable: "--f-noto-jp", display: "swap", preload: false });
const notoAr = Noto_Sans_Arabic({ variable: "--f-noto-ar", display: "swap", preload: false });

/** Class names that define the --f-* font variables site.css uses. */
export const SITE_FONT_VARS = [unbounded, geist, geistMono, notoJp, notoAr].map((f) => f.variable).join(" ");
