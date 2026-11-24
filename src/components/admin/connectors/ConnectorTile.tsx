/* eslint-disable @next/next/no-img-element -- small same-origin marks drawn at a fixed size; next/image adds nothing here */
import type { ConnectorIcon } from "@/lib/connectors/manifest";
import { initialsOf, tileClass } from "./words";

/**
 * A connector's tile and wide logo. No hooks and no "use client": the help page draws the tile in
 * its headings on the server, in the How to drawer and through the Markdown converter, which calls
 * plain components as functions (src/lib/developers/markdown.ts). The tile is an <img> with empty
 * alt inside an aria-hidden plate, so it adds no words: the connector's name is always beside it.
 */

export type TileSize = "sm" | "md" | "lg";

const cx = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(" ");

/** sm: rows, card titles and headings; md: Browse cards; lg: a Listing's header. */
const SIZES: Readonly<Record<TileSize, { box: string; pad: string; text: string }>> = {
  sm: { box: "h-6 w-6 rounded-md", pad: "p-[3px]", text: "text-[10px]" },
  md: { box: "h-10 w-10 rounded-lg", pad: "p-1.5", text: "text-sm" },
  lg: { box: "h-12 w-12 rounded-xl", pad: "p-2", text: "text-base" },
};

/**
 * Its mark on a neutral plate, or its two letters on its own colour when the manifest has no mark.
 * The plate is white in both themes, as Google and Cloudflare show their full colour marks; one
 * with a file for dark backgrounds gets a dark plate in the dark theme. Marks are never recoloured.
 */
export function ConnectorTile({ id, name, initials, icon, size = "md" }: { id: string; name: string; initials?: string; icon?: ConnectorIcon | null; size?: TileSize }) {
  const s = SIZES[size];
  if (!icon) {
    return (
      <span aria-hidden="true" className={`grid shrink-0 place-items-center font-bold ${s.box} ${s.text} ${tileClass(id)}`}>
        {initialsOf(name, initials)}
      </span>
    );
  }
  const img = "max-h-full max-w-full object-contain";
  return (
    <span aria-hidden="true" className={cx("flex shrink-0 items-center justify-center border border-neutral-200 bg-white dark:border-neutral-700", icon.dark && "dark:bg-neutral-900", s.box, s.pad)}>
      <img src={icon.light} alt="" className={cx(img, icon.dark && "dark:hidden")} />
      {icon.dark ? <img src={icon.dark} alt="" className={cx("hidden", img, "dark:block")} /> : null}
    </span>
  );
}

/**
 * Google's own Sign in with Google button, from its pre-approved assets
 * (developers.google.com/identity/branding-guidelines): the standard G, Google's light and dark
 * themes, never recoloured or resized out of shape. Google's check of the GA4 sign in needs it.
 */
export const GOOGLE_SIGN_IN = { light: "/marks/google/signin-light.png", dark: "/marks/google/signin-dark.png", width: 180, height: 40 } as const;

/** The button's art, light or dark with the theme; the alt text is the button's name. */
export function GoogleSignInArt({ alt }: { alt: string }) {
  const size = { width: GOOGLE_SIGN_IN.width, height: GOOGLE_SIGN_IN.height };
  return (
    <>
      <img src={GOOGLE_SIGN_IN.light} alt={alt} {...size} className="block dark:hidden" />
      <img src={GOOGLE_SIGN_IN.dark} alt={alt} {...size} className="hidden dark:block" />
    </>
  );
}

/**
 * The wide logo some owners ask for beside their data, linked to their product (Google Analytics
 * links straight into it): its branding policy wants it wherever an app shows its numbers, at
 * least 154 by 50, in its colours (white words on a dark background). Its alt text is the words in
 * the image, so the link reads "Google Analytics".
 */
export function ConnectorLockup({ lockup }: { lockup: NonNullable<ConnectorIcon["lockup"]> }) {
  const size = { width: lockup.width, height: lockup.height };
  return (
    <a href={lockup.href} target="_blank" rel="noopener noreferrer" className="inline-block rounded-md">
      <img src={lockup.light} alt={lockup.alt} {...size} className={lockup.dark ? "dark:hidden" : undefined} />
      {lockup.dark ? <img src={lockup.dark} alt={lockup.alt} {...size} className="hidden dark:block" /> : null}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
