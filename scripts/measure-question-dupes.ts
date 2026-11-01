/**
 * measure-question-dupes.ts: how close in meaning (cosine, text-embedding-005, both sides
 * embedded as documents with QUESTION_TITLE) a new question for a brand's team comes to:
 *   - the same ask in other words (should count as a repeat),
 *   - a different ask on the same subject (should not),
 *   - a note that already answers it, and a note on the same subject that doesn't.
 * Prints each group's range and where a cutoff would separate them. DUP_QUESTION_SIM and
 * DUP_NOTE_SIM in src/lib/content/blog/seen.ts come from this; re-run it before changing them.
 *
 * Read only: it sends the made-up texts below to the embedding model and writes nothing.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/measure-question-dupes.ts
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 */

import { embedDocuments } from "@/lib/agents/embeddings";
import { QUESTION_TITLE } from "@/lib/brandNotes/store";

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
const NOTES: Array<[string, string, string]> = [
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

const cosine = (x: number[], y: number[]) => {
  let dot = 0;
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    dot += x[i]! * y[i]!;
    nx += x[i]! * x[i]!;
    ny += y[i]! * y[i]!;
  }
  return dot / Math.sqrt(nx * ny);
};

async function sims(pairs: Array<[string, string]>, titles: [string, string] = [QUESTION_TITLE, QUESTION_TITLE]): Promise<number[]> {
  const left = await embedDocuments(pairs.map(([a]) => ({ content: a, title: titles[0] })), "us");
  const right = await embedDocuments(pairs.map(([, b]) => ({ content: b, title: titles[1] })), "us");
  return pairs.map((_, i) => {
    if (!left[i] || !right[i]) throw new Error("embedding failed: is GOOGLE_CLOUD_PROJECT set, and are you logged in with ADC?");
    return cosine(left[i]!, right[i]!);
  });
}

const range = (xs: number[]) => `${Math.min(...xs).toFixed(3)} to ${Math.max(...xs).toFixed(3)}`;
function report(name: string, repeats: number[], apart: number[]) {
  const lo = Math.min(...repeats);
  const hi = Math.max(...apart);
  console.log(`\n${name}`);
  console.log(`  repeats:   ${range(repeats)}   ${repeats.map((x) => x.toFixed(3)).join(" ")}`);
  console.log(`  different: ${range(apart)}   ${apart.map((x) => x.toFixed(3)).join(" ")}`);
  console.log(lo > hi ? `  separated: any cutoff between ${hi.toFixed(3)} and ${lo.toFixed(3)} (midpoint ${((lo + hi) / 2).toFixed(3)})` : `  OVERLAP: no cutoff separates them (lowest repeat ${lo.toFixed(3)}, highest different ${hi.toFixed(3)})`);
}

async function main() {
  report("Question against question (DUP_QUESTION_SIM)", await sims(SAME), await sims(DIFFERENT));
  // A kept note is embedded as its text under the title "What we've seen" (store.ts embedNote).
  const titles: [string, string] = [QUESTION_TITLE, "What we've seen"];
  report(
    "Question against note (DUP_NOTE_SIM)",
    await sims(NOTES.map(([q, answers]) => [q, answers]), titles),
    await sims(NOTES.map(([q, , other]) => [q, other]), titles),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
