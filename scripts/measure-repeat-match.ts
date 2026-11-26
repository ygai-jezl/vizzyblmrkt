/**
 * measure-repeat-match.ts: how close in meaning (cosine, text-embedding-005, both sides embedded as
 * documents with QUESTION_TITLE) a buyer's question comes to an article's question, for Next up's
 * stop repeats (src/lib/nextUp/repeats.ts):
 *   - the same ask in other words (Next up links it as answered: SAME_SIM),
 *   - a different ask on the same subject, often sharing a long phrase (it must not be linked).
 * Prints each group's range and how the cut offs sort each pair. Re-run it before changing
 * SAME_SIM or CLOSE_SIM.
 *
 * Read only: it sends the made-up texts below to the embedding model and writes nothing.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/measure-repeat-match.ts
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 */

import { embedDocuments } from "@/lib/agents/embeddings";
import { QUESTION_TITLE } from "@/lib/brandNotes/store";
import { CLOSE_SIM, cosine, SAME_SIM } from "@/lib/nextUp/repeats";

/** [an article's question, the same ask reworded] */
const SAME: Array<[string, string]> = [
  ["What is AI search visibility tracking?", "What is AI search visibility tracking and how does it work?"],
  ["How do I track brand mentions in AI chat answers?", "How can I monitor when AI assistants mention my brand?"],
  ["How long does a dental implant take to heal?", "What is the healing time for a dental implant?"],
  ["Can I freeze a decorated birthday cake?", "Is it OK to freeze a birthday cake that is already decorated?"],
  ["How do I get my business cited in AI answers?", "How can my business get cited in answers from AI assistants?"],
  ["What is an llms.txt file?", "What is an llms.txt file and what is it for?"],
];

/** [an article's question, a different ask on the same subject] */
const DIFFERENT: Array<[string, string]> = [
  ["What is AI search visibility tracking?", "How much do AI search visibility tracking tools cost?"],
  ["How long does a dental implant take to heal?", "How much does a dental implant cost?"],
  ["Can I freeze a decorated birthday cake?", "How far ahead can I order a decorated birthday cake?"],
  ["What is a GEO audit?", "What should a GEO audit report include?"],
  ["How do I get my business cited in AI answers?", "Why do AI answers cite review sites instead of my own pages?"],
  ["What is an llms.txt file?", "How do I check whether AI crawlers can read my site?"],
];

async function sims(pairs: Array<[string, string]>): Promise<number[]> {
  const v = await embedDocuments(pairs.flat().map((content) => ({ content, title: QUESTION_TITLE })), "us");
  if (v.some((x) => !x)) throw new Error("The embedding model gave no answer: check GOOGLE_CLOUD_PROJECT and your credentials.");
  return pairs.map((_, i) => Math.round(cosine(v[2 * i]!, v[2 * i + 1]!) * 1000) / 1000);
}

const sorted = (s: number) => (s >= SAME_SIM ? "same " : s >= CLOSE_SIM ? "close" : "     ");

async function main() {
  const [same, different] = await Promise.all([sims(SAME), sims(DIFFERENT)]);
  for (const [name, pairs, s] of [["The same ask reworded", SAME, same], ["A different ask", DIFFERENT, different]] as const) {
    console.log(`\n${name}: ${Math.min(...s)} to ${Math.max(...s)}`);
    pairs.forEach((p, i) => console.log(`  ${s[i]!.toFixed(3)} ${sorted(s[i]!)} ${p[0]} | ${p[1]}`));
  }
  console.log(`\nSAME_SIM ${SAME_SIM}: links ${same.filter((x) => x >= SAME_SIM).length} of ${same.length} rewordings and ${different.filter((x) => x >= SAME_SIM).length} of ${different.length} different asks.`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
