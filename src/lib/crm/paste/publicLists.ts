import { PASTE_NOTES } from "./words";

/**
 * Start from a public list (RAISE_PASTE_ENABLED): the card in Paste a list that says where a
 * founder can find investors to paste, and its help page section. Pure and client safe.
 *
 * YouGrow never fetches the kit or any directory, and never copies their lists. This card and the
 * help page are the only product copy that names the kit (decision 9): it credits the kit's makers
 * and links to the original, and the founder pastes only the firms they pick, whose firm columns
 * alone are kept. House style: no em or en dashes, no spaced hyphens, none of the AI tells.
 */

export interface PublicLink {
  label: string;
  url: string;
}

/** The kit's original page, as its makers publish it. */
export const KIT_URL = "https://notion.notion.site/The-AI-Fundraising-Kit-281efdeead058156bd19e58435c270aa";

export const PUBLIC_LIST = {
  /** The line that opens the card, folded under the box. */
  summary: "Looking for investors? Start from a public list",
  title: "Start from a public list",
  body: "The AI Fundraising Kit has a large investor list you can copy into your own Notion. Pick the ones that fit, then paste them here.",
  credit: "The AI Fundraising Kit, made by The VC Corner with Notion.",
  kit: { label: "Open the original", url: KIT_URL } satisfies PublicLink,
  steps: [
    "Duplicate the kit into your own Notion.",
    "Filter it by stage, sector and place.",
    "Pick 10 to 30, then copy those rows with the header row.",
    "Paste them in the box and say where they're from.",
  ],
  firms: PASTE_NOTES.firms_left_out,
  othersTitle: "Other free directories",
  others: [
    { label: "OpenVC", url: "https://openvc.app/investor-database" },
    { label: "Signal by NFX", url: "https://signal.nfx.com" },
    { label: "Visible Connect", url: "https://visible.vc/connect/" },
  ] satisfies PublicLink[],
  othersHint: "Find funds there, then add the ones that fit with each fund's own web address.",
  guidance: ["Ten good fits beat a hundred names.", "Lists go out of date. Check the fund's own site before you write.", "You found them, so tell them where."],
  footnote: "YouGrow doesn't copy the kit. You keep only the rows you add.",
} as const;

/** Every string the card shows, for the house style test. */
export const ALL_PUBLIC_LIST_STRINGS: readonly string[] = [
  PUBLIC_LIST.summary,
  PUBLIC_LIST.title,
  PUBLIC_LIST.body,
  PUBLIC_LIST.credit,
  PUBLIC_LIST.kit.label,
  ...PUBLIC_LIST.steps,
  PUBLIC_LIST.firms,
  PUBLIC_LIST.othersTitle,
  ...PUBLIC_LIST.others.map((o) => o.label),
  PUBLIC_LIST.othersHint,
  ...PUBLIC_LIST.guidance,
  PUBLIC_LIST.footnote,
];
