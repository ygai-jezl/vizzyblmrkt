/**
 * The made-up texts and the report of scripts/measure-question-dupes.ts: for each cut-off a reader
 * uses, pairs that should count as close and pairs that shouldn't, each side embedded the way that
 * reader embeds it on each model (ADR-0025):
 *   - old: text-embedding-005, as brand_map_vectors stores them (fixed titles per kind);
 *   - new: gemini-embedding-001, as brand search's indexer stores them (each record's own title).
 * A query side is embedded as a query on both. Pure apart from the embedder it is given.
 */

export type Model = "old" | "new";

/** How one side is embedded: as a query, or as a document with this title. */
export type Embedding = { task: "query" } | { task: "document"; title: string };

export interface Side {
  text: string;
  as: Record<Model, Embedding>;
  /** The text each store embeds, when it is more than `text` (a subject's questions, a situation's parts). */
  texts?: Record<Model, string>;
}

export interface Group {
  name: string;
  /** The cut-off it informs, as the code names it. */
  cutOff: string;
  repeats: Array<[Side, Side]>;
  apart: Array<[Side, Side]>;
}

/** Embeds texts with one task; per-item titles for documents. A slot is null when it failed. */
export type Embedder = (items: Array<{ content: string; title?: string }>, task: "query" | "document") => Promise<Array<number[] | null>>;

/** The brand notes store's QUESTION_TITLE, the old store's title for a question asked of the team. */
export const OLD_QUESTION_TITLE = "A question for the team";

const query = (text: string): Side => ({ text, as: { old: { task: "query" }, new: { task: "query" } } });
const lines = (...parts: string[]) => parts.filter((p) => p.trim()).join("\n\n");

/** A subject as each store embeds it: old by name and questions under "Subject", new by name, then questions, under its name. */
export function subjectSide(name: string, questions: string[]): Side {
  return { text: name, as: { old: { task: "document", title: "Subject" }, new: { task: "document", title: name } }, texts: { old: [name, ...questions].join("\n"), new: lines(name, ...questions) } };
}

/** A search or a PDF's question placed on the map (nearestSubjectsMany): a document titled "Question" on both. */
export function questionDocSide(text: string): Side {
  return { text, as: { old: { task: "document", title: "Question" }, new: { task: "document", title: "Question" } } };
}

/** A buying situation: old as its words under "Buying situation", new as the indexer writes it under its words. */
export function situationSide(s: { text: string; who: string; want: string; wText?: string }): Side {
  return {
    text: s.text,
    as: { old: { task: "document", title: "Buying situation" }, new: { task: "document", title: s.text } },
    texts: { old: [s.text, s.who, s.wText ?? "", s.want].filter(Boolean).join("\n"), new: lines(s.text, `Who: ${s.who}`, `Wants: ${s.want}`, s.wText ?? "") },
  };
}

/** A question for the team about to be asked, or kept: old under QUESTION_TITLE, new under the question itself (as the indexer titles it). */
export function teamQuestionSide(question: string): Side {
  return { text: question, as: { old: { task: "document", title: OLD_QUESTION_TITLE }, new: { task: "document", title: question } } };
}

/** A kept note: old under "What we've seen", new under its first 120 characters (as the indexer titles it). */
export function noteSide(text: string): Side {
  return { text, as: { old: { task: "document", title: "What we've seen" }, new: { task: "document", title: text.slice(0, 120) } } };
}

const textOf = (side: Side, model: Model) => side.texts?.[model] ?? side.text;

// ── The made-up pairs ────────────────────────────────────────────────────────────────────────

const FIG = subjectSide("Repotting a fiddle leaf fig", ["When should I repot a fiddle leaf fig?", "What size pot does a fiddle leaf fig need?"]);
const STARTER = subjectSide("Sourdough starter care", ["How often should I feed my starter?", "Why is my starter not rising?"]);
const WHITENING = subjectSide("Teeth whitening aftercare", ["What can I eat after whitening?", "How long does whitening last?"]);
const WINTER_SHOES = subjectSide("Winter running shoes", ["Which running shoes grip on ice?", "Do I need waterproof shoes for winter runs?"]);
const TASTING = subjectSide("Wedding cake tasting", ["How many flavours can we try at a tasting?", "When should we book a cake tasting?"]);
const TEAM_PLANS = subjectSide("Plans for small teams", ["What does the team plan cost?", "Can I add a fifth person to my plan?"]);

/** LOOKS_LIKE: a proposal against a subject already on the map (documents with documents). */
export const SUBJECTS: Group = {
  name: "Subject against subject",
  cutOff: "LOOKS_LIKE (src/lib/brandMap/embed.ts)",
  repeats: [
    [subjectSide("Repotting figs", ["How do I repot a fig tree?", "Which soil is best when repotting a fig?"]), FIG],
    [subjectSide("Looking after your starter", ["What flour should I feed a starter?", "How do I revive a sluggish starter?"]), STARTER],
    [subjectSide("After whitening: what to avoid", ["Can I drink coffee after whitening?", "Which foods stain freshly whitened teeth?"]), WHITENING],
    [subjectSide("Running shoes for ice and snow", ["Are trail shoes good in snow?", "How do I keep my feet dry on winter runs?"]), WINTER_SHOES],
    [subjectSide("Booking a cake tasting", ["What happens at a wedding cake tasting?", "How far ahead should we taste cakes?"]), TASTING],
    [subjectSide("Pricing for teams of five or fewer", ["How much is the plan for a small team?", "Is there a discount for small teams?"]), TEAM_PLANS],
  ],
  apart: [
    [subjectSide("Fiddle leaf fig leaves dropping", ["Why is my fiddle leaf fig dropping leaves?", "Is my fig getting too much water?"]), FIG],
    [subjectSide("Shaping sourdough loaves", ["How do I shape a batard?", "Why does my loaf spread flat?"]), STARTER],
    [subjectSide("Choosing a dentist for nervous patients", ["What helps with fear of the dentist?", "Can I meet the dentist before my visit?"]), WHITENING],
    [subjectSide("Training for a first marathon", ["How many weeks does marathon training take?", "How far should my longest run be?"]), WINTER_SHOES],
    [subjectSide("Delivering a wedding cake", ["How is a tiered cake carried to the venue?", "Who sets the cake up on the day?"]), TASTING],
    [subjectSide("Inviting your team", ["How do I invite someone to my workspace?", "Can a teammate have read only access?"]), TEAM_PLANS],
  ],
};

/** NEAR_SUBJECT: a Google search placed on the map (nearestSubjectsMany), against a subject. */
export const SEARCHES: Group = {
  name: "Search against subject",
  cutOff: "NEAR_SUBJECT (src/lib/connectors/signals/detect.ts)",
  repeats: [
    [questionDocSide("repot fiddle leaf fig"), FIG],
    [questionDocSide("sourdough starter not rising"), STARTER],
    [questionDocSide("can i drink coffee after teeth whitening"), WHITENING],
    [questionDocSide("trail running shoes for snow"), WINTER_SHOES],
    [questionDocSide("wedding cake tasting near me"), TASTING],
  ],
  apart: [
    [questionDocSide("repot fiddle leaf fig"), STARTER],
    [questionDocSide("sourdough starter not rising"), TASTING],
    [questionDocSide("can i drink coffee after teeth whitening"), TEAM_PLANS],
    [questionDocSide("trail running shoes for snow"), FIG],
    [questionDocSide("wedding cake tasting near me"), WINTER_SHOES],
  ],
};

const OUTGROWN = situationSide({ text: "My plant has outgrown its pot", who: "a first time plant owner", want: "a bigger pot that won't rot the roots" });
const JUST_WHITENED = situationSide({ text: "I've just had my teeth whitened", who: "a patient a day after whitening", want: "to keep the colour for longer" });
const BIG_WEDDING = situationSide({ text: "Planning a wedding for over a hundred guests", who: "a couple a year before the day", want: "a cake that feeds everyone" });

/** nearestSituations: a question asked as a query, against a buying situation. Ranges only: no cut-off. */
export const SITUATIONS: Group = {
  name: "Question against buying situation",
  cutOff: "none (nearestSituations ranks them; this checks the order holds)",
  repeats: [
    [query("Which pot should I buy for a fig that has outgrown its pot?"), OUTGROWN],
    [query("What can I eat the day after whitening?"), JUST_WHITENED],
    [query("What size cake serves 120 guests?"), BIG_WEDDING],
  ],
  apart: [
    [query("Which pot should I buy for a fig that has outgrown its pot?"), situationSide({ text: "Buying a plant as a gift", who: "a friend with no plants", want: "something hard to kill" })],
    [query("What can I eat the day after whitening?"), situationSide({ text: "Booking a first check up after years away", who: "an anxious adult", want: "no lecture about the gap" })],
    [query("What size cake serves 120 guests?"), situationSide({ text: "Ordering a birthday cake for a child", who: "a parent a week before the party", want: "a cake in a favourite character's shape" })],
  ],
};

/** [new question, the same ask reworded] */
const SAME: Array<[string, string]> = [
  ["Which prompt did you stop tracking, and why?", "What made you decide a prompt wasn't worth tracking any more?"],
  ["When did a monitoring result change what a client published that week?", "Tell us about a time a client changed what they published straight after seeing a monitoring result."],
  ["What did a client expect monitoring to show that it couldn't?", "When has a client expected AI visibility tracking to tell them something it can't?"],
  ["Which cake sold out first after you changed the window display?", "After you changed the shop window, which cake was the first to sell out?"],
  ["What do patients most often get wrong about whitening before their first visit?", "Before a first whitening appointment, what is the most common thing patients misunderstand?"],
  ["When did a candidate turn down an offer because of how the interview went?", "Tell us about a candidate who said no to an offer because of the interview itself."],
  ["Which question do new customers ask most in their first week?", "In their first week, what do new customers ask about most often?"],
  ["What happened the last time you raised your prices?", "When you last put your prices up, what happened?"],
];

/** [new question, a different ask on the same subject] */
const DIFFERENT: Array<[string, string]> = [
  ["Which prompt did you stop tracking, and why?", "Which prompt surprised you by moving the most in a month?"],
  ["When did a monitoring result change what a client published that week?", "What did a client expect monitoring to show that it couldn't?"],
  ["When did checking less often miss something that mattered?", "When did checking every day turn out to be a waste of time?"],
  ["Which cake sold out first after you changed the window display?", "Which cake do regulars ask for that you no longer make?"],
  ["What do patients most often get wrong about whitening before their first visit?", "What made a nervous patient finally book a check up?"],
  ["When did a candidate turn down an offer because of how the interview went?", "When did a hiring manager change the role after seeing the first candidates?"],
  ["Which question do new customers ask most in their first week?", "Which feature do customers stop using after their first month?"],
  ["What happened the last time you raised your prices?", "What happened the last time you offered a discount?"],
];

/** [question, a note that already answers it, a note on the same subject that doesn't] */
export const NOTE_TRIPLES: Array<[string, string, string]> = [
  [
    "Which prompt did you stop tracking, and why?",
    "We stopped tracking 'best AI visibility tool' for one client because the answers never named anyone in their niche; it told us nothing.",
    "A client's share of voice jumped after a competitor's page went offline, not because of anything we changed.",
  ],
  [
    "Which cake sold out first after you changed the window display?",
    "When we put the lemon drizzle in the window instead of the brownies, it sold out by eleven three days running.",
    "Regulars still ask for the coffee walnut cake we stopped making last spring.",
  ],
  [
    "What do patients most often get wrong about whitening before their first visit?",
    "Most patients think whitening will fix the colour of their crowns too; we explain at the first visit that it won't.",
    "A nervous patient booked a check up only after we offered a short visit to meet the team first.",
  ],
  [
    "What happened the last time you raised your prices?",
    "When we raised prices last year, two long-standing clients left but new sign ups didn't slow down at all.",
    "Offering a discount in January brought in bargain hunters who didn't stay.",
  ],
];

/** DUP_QUESTION_SIM: a new question for the team against one asked or answered. */
export const QUESTIONS: Group = {
  name: "Question against question",
  cutOff: "DUP_QUESTION_SIM (src/lib/content/blog/seen.ts)",
  repeats: SAME.map(([a, b]) => [teamQuestionSide(a), teamQuestionSide(b)]),
  apart: DIFFERENT.map(([a, b]) => [teamQuestionSide(a), teamQuestionSide(b)]),
};

/** DUP_NOTE_SIM: a new question for the team against a kept note. */
export const QUESTION_NOTES: Group = {
  name: "Question against note",
  cutOff: "DUP_NOTE_SIM (src/lib/content/blog/seen.ts)",
  repeats: NOTE_TRIPLES.map(([q, answers]) => [teamQuestionSide(q), noteSide(answers)]),
  apart: NOTE_TRIPLES.map(([q, , other]) => [teamQuestionSide(q), noteSide(other)]),
};

/** CANDIDATE_MIN_SIM: an article's question, asked as a query, against kept notes (nearestNotes). */
export const NOTES: Group = {
  name: "Article question against note",
  cutOff: "CANDIDATE_MIN_SIM (src/lib/content/blog/seen.ts)",
  repeats: NOTE_TRIPLES.map(([q, answers]) => [query(q), noteSide(answers)]),
  apart: NOTE_TRIPLES.map(([q, , other]) => [query(q), noteSide(other)]),
};

/** OPEN_MIN_SIM: an article's question, asked as a query, against open questions (nearestOpenQuestions). */
export const OPEN_QUESTIONS: Group = {
  name: "Article question against open question",
  cutOff: "OPEN_MIN_SIM, which is CANDIDATE_MIN_SIM (src/lib/content/blog/seen.ts)",
  repeats: SAME.map(([a, b]) => [query(a), teamQuestionSide(b)]),
  apart: DIFFERENT.map(([a, b]) => [query(a), teamQuestionSide(b)]),
};

/**
 * A competitor article: old as its title, question, angle and summary under "Competitor article";
 * new as the indexer writes it, under "{competitor}: {title}".
 */
export function articleSide(a: { competitor: string; title: string; question: string; angle: string; summary: string }): Side {
  return {
    text: a.title,
    as: { old: { task: "document", title: "Competitor article" }, new: { task: "document", title: `${a.competitor}: ${a.title}` } },
    texts: { old: [a.title, a.question, a.angle, a.summary].join("\n"), new: lines(a.summary, `Answers: ${a.question}`, `Angle: ${a.angle}`) },
  };
}

const REPOT_GUIDE = articleSide({ competitor: "Leafy Shop", title: "How to repot a fiddle leaf fig", question: "When should you repot a fiddle leaf fig?", angle: "Step by step, with photos", summary: "Repot in spring when roots circle the pot, one size up, with fast draining soil." });
const WHITENING_GUIDE = articleSide({ competitor: "Bright Smiles", title: "Eating after whitening", question: "What can you eat after teeth whitening?", angle: "A 48 hour food list", summary: "Avoid coffee, red wine and curry for two days; white foods are safe." });
const CAKE_GUIDE = articleSide({ competitor: "Tiered Bakes", title: "Wedding cake sizes", question: "How big a cake do you need for your guests?", angle: "A portion chart", summary: "A three tier cake serves about 100; add a kitchen cake for more guests." });
const STARTER_GUIDE = articleSide({ competitor: "Crumb Club", title: "Reviving a sluggish starter", question: "Why is my sourdough starter not rising?", angle: "Troubleshooting", summary: "Feed twice a day at room temperature with wholemeal flour until it doubles." });

/** COVERED_SIM and MIN_SIM: a question, asked as a query, against a competitor article that answers it, or one that doesn't. */
export const ARTICLES: Group = {
  name: "Question against competitor article",
  cutOff: "COVERED_SIM (src/lib/competitors/planningApi.ts, src/lib/brandContext/pack.ts) and MIN_SIM (src/lib/competitors/planning.ts)",
  repeats: [
    [query("When is the best time to repot a fig tree?"), REPOT_GUIDE],
    [query("Can I drink coffee after whitening my teeth?"), WHITENING_GUIDE],
    [query("What size wedding cake for 100 guests?"), CAKE_GUIDE],
    [query("How do I fix a starter that won't rise?"), STARTER_GUIDE],
  ],
  apart: [
    [query("Why are my fiddle leaf fig's leaves turning brown?"), REPOT_GUIDE],
    [query("Does whitening hurt sensitive teeth?"), WHITENING_GUIDE],
    [query("How far ahead should we book a cake tasting?"), CAKE_GUIDE],
    [query("How do I shape a sourdough loaf?"), STARTER_GUIDE],
  ],
};

/** Every group, in the order the report prints them. */
export const GROUPS: Group[] = [SUBJECTS, SEARCHES, SITUATIONS, NOTES, OPEN_QUESTIONS, QUESTIONS, QUESTION_NOTES, ARTICLES];

// ── Measuring ───────────────────────────────────────────────────────────────────────────────

export const cosine = (x: number[], y: number[]): number => {
  let dot = 0;
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    dot += x[i]! * y[i]!;
    nx += x[i]! * x[i]!;
    ny += y[i]! * y[i]!;
  }
  return nx && ny ? dot / Math.sqrt(nx * ny) : 0;
};

/** Each side's vector on one model: queries in one call, documents (with their titles) in another. */
async function embedSides(sides: Side[], model: Model, embed: Embedder): Promise<number[][]> {
  const out: Array<number[] | null> = sides.map(() => null);
  for (const task of ["query", "document"] as const) {
    const at = sides.map((s, i) => (s.as[model].task === task ? i : -1)).filter((i) => i >= 0);
    if (!at.length) continue;
    const vectors = await embed(
      at.map((i) => {
        const e = sides[i]!.as[model];
        return { content: textOf(sides[i]!, model), ...(e.task === "document" ? { title: e.title } : {}) };
      }),
      task,
    );
    at.forEach((i, k) => (out[i] = vectors[k] ?? null));
  }
  if (out.some((v) => !v)) throw new Error("embedding failed: is GOOGLE_CLOUD_PROJECT (or, for --model new on a laptop, GEMINI_API_KEY) set, and are you logged in with ADC?");
  return out as number[][];
}

async function sims(pairs: Array<[Side, Side]>, model: Model, embed: Embedder): Promise<number[]> {
  const left = await embedSides(pairs.map(([a]) => a), model, embed);
  const right = await embedSides(pairs.map(([, b]) => b), model, embed);
  return pairs.map((_, i) => cosine(left[i]!, right[i]!));
}

const range = (xs: number[]) => `${Math.min(...xs).toFixed(3)} to ${Math.max(...xs).toFixed(3)}`;

/** One group's lines: both ranges and where a cut-off would separate them, or that none does. */
export function reportLines(group: Pick<Group, "name" | "cutOff">, model: Model, repeats: number[], apart: number[]): string[] {
  const lo = Math.min(...repeats);
  const hi = Math.max(...apart);
  return [
    `${group.name}, ${model} model: ${group.cutOff}`,
    `  close:     ${range(repeats)}   ${repeats.map((x) => x.toFixed(3)).join(" ")}`,
    `  different: ${range(apart)}   ${apart.map((x) => x.toFixed(3)).join(" ")}`,
    lo > hi
      ? `  separated: any cut-off between ${hi.toFixed(3)} and ${lo.toFixed(3)} (midpoint ${((lo + hi) / 2).toFixed(3)})`
      : `  OVERLAP: no cut-off separates them (lowest close ${lo.toFixed(3)}, highest different ${hi.toFixed(3)})`,
  ];
}

/** The report for these groups on one model. */
export async function measure(groups: Group[], model: Model, embed: Embedder): Promise<string[]> {
  const out: string[] = [];
  for (const g of groups) out.push("", ...reportLines(g, model, await sims(g.repeats, model, embed), await sims(g.apart, model, embed)));
  return out;
}
