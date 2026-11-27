import type { DeckView } from "../adminApi";
import type { DeckTheme } from "../theme";
import type { MetricBlock, Slide } from "../types";
import { NOW, block } from "./fixtures";

/**
 * A deck as its page gets it, for the screens' tests: Acme's pre-seed deck (a made up startup) and
 * Fernhill Plants' lender pack (a made up UK plant shop), in a look made from a brand kit.
 */

export const THEME: DeckTheme = {
  ground: "#FFFFFF",
  surface: "#F5F5F3",
  ink: "#141414",
  muted: "#5C5C5C",
  accent: "#2F5BEA",
  accentText: "#2F5BEA",
  accentInk: "#FFFFFF",
  chart: ["#2F5BEA", "#5C5C5C", "#A3A3A3"],
  headingFont: "'Inter', sans-serif",
  bodyFont: "'Inter', sans-serif",
  fontFaces: [],
  logoUrl: "/api/brand-logo/ten_acme/logo-0001.png",
  brandName: "Acme",
  maxWords: 30,
};

const weekly: MetricBlock = block({
  id: "mb_weekly01",
  grain: "week",
  name: "Sign-ups a week",
  series: Array.from({ length: 12 }, (_, i) => ({ label: `${i + 1} Sep`, value: 300 + ((i * 37) % 90) })),
});
const total: MetricBlock = block({ id: "mb_total001" });

let n = 0;
const s = (over: Partial<Slide>): Slide => {
  n += 1;
  return { id: `sl_view${String(n).padStart(4, "0")}`, section: "problem", layout: "statement", headline: "", points: [], blocks: [], notes: "", needs: [], sources: [], ...over };
};

/** One slide of each layout, as Acme's pre-seed deck has them. */
export function acmeSlides(): Slide[] {
  return [
    s({ section: "cover", layout: "cover", headline: "Acme", points: ["Stock counts for small shops, done in minutes"] }),
    s({ section: "problem", layout: "statement", headline: "Shop owners lose a day a week counting stock", points: ["Most still count on paper"], notes: "Every owner we met counts stock by hand on a Sunday.", sources: ["P1"] }),
    s({ section: "solution", layout: "three_points", headline: "Acme counts stock as you sell", points: ["Scan as you shelve", "Counts update with each sale", "Reorders drafted for you"] }),
    s({
      section: "traction",
      layout: "chart",
      headline: "{{mb_total001}} people joined the waitlist in {{mb_total001:period}}",
      blocks: [weekly, total],
      notes: "Sign-ups grew each month without paid ads.",
    }),
    s({ section: "market", layout: "big_number", headline: "Small shops buy this every week", blocks: [block({ id: "mb_market01", meaning: "typed", name: "Shops in the UK", value: 320000, display: "320,000", periodWords: undefined, source: { kind: "typed", from: "a trade body report", typedBy: "usr_admin" } })] }),
    s({ section: "competition", layout: "compare", headline: "Paper and spreadsheets cost owners their weekends", compare: { leftTitle: "What people do today", rightTitle: "With Acme", rows: [{ left: "Count on Sunday", right: "Counted as you sell" }] } }),
    s({ section: "team", layout: "team", headline: "Two founders who ran shops for ten years", people: [{ name: "Sam Rivera", role: "Chief executive", line: "Ran three shops." }, { name: "Alex Chen", role: "Engineer", line: "Built till software." }] }),
    s({ section: "ask", layout: "ask", headline: "We are raising to reach 1,000 shops", points: ["Two engineers", "A sales lead", "Twelve months of runway", "It gets us to 1,000 paying shops"], needs: [{ id: "nd_amount01", text: "how much you're raising" }] }),
  ];
}

export function acmeView(over: Partial<DeckView> = {}): DeckView {
  const slides = acmeSlides();
  return {
    id: "rd_acme00000001",
    title: "Acme pre-seed",
    audience: "investor",
    stage: "pre_seed",
    kindLabel: "Investor deck, pre-seed",
    status: "draft",
    version: 3,
    updatedAt: NOW.toISOString(),
    slides,
    checks: [],
    talk: { words: 20, talkSeconds: 8, perSlide: slides.map((x) => ({ slideId: x.id, words: 2, talkSeconds: 1 })) },
    needs: 1,
    versions: [
      { n: 3, note: "Changed slide 2 headline.", by: "You", at: NOW.toISOString(), kept: true },
      { n: 2, note: "Numbers refreshed: slide 4 sign-ups 4,210 to 4,310.", by: "Vizzy", at: NOW.toISOString(), kept: true },
      { n: 1, note: "First draft by Vizzy.", by: "Vizzy", at: NOW.toISOString(), kept: true },
    ],
    sources: [{ id: "P1", text: "Acme helps small shops count stock.", label: "website", url: "https://acme.example/about" }],
    numberOptions: { waitlist: { weeks: 12, hasData: true }, growth: { hasData: true }, launches: null },
    theme: THEME,
    canEdit: true,
    canDraft: true,
    meanings: {},
    ...over,
  };
}

/** Fernhill Plants' lender pack: 5 slides, monthly till sales typed by the owner. */
export function fernhillView(over: Partial<DeckView> = {}): DeckView {
  const sales = block({
    id: "mb_sales001",
    meaning: "typed",
    name: "Till sales",
    value: 14200,
    unit: "money",
    currency: "GBP",
    per: "month",
    display: "£14,200 a month",
    periodWords: undefined,
    source: { kind: "typed", from: "the shop's till", typedBy: "usr_fern" },
  });
  const slides = [
    s({ section: "cover", layout: "cover", headline: "Fernhill Plants", points: ["A plant shop trading for six years"] }),
    s({ section: "sales", layout: "big_number", headline: "Sales are steady through the year", blocks: [sales] }),
    s({ section: "use_of_funds", layout: "ask", headline: "A loan for spring stock", points: ["Spring plants", "A second greenhouse"] }),
    s({ section: "repayment", layout: "three_points", headline: "Repayments fit our busy months", points: ["Spring and summer pay most of it"] }),
    s({ section: "team", layout: "team", headline: "Run day to day by its owner", people: [{ name: "Jo Fern", role: "Owner", line: "Runs the shop." }] }),
  ];
  return acmeView({
    id: "rd_fern00000001",
    title: "Fernhill stock loan",
    audience: "lender",
    stage: "loan",
    kindLabel: "Lender pack",
    slides,
    theme: { ...THEME, brandName: "Fernhill Plants", logoUrl: null, accent: "#3F7D3A", accentText: "#3F7D3A" },
    ...over,
  });
}
