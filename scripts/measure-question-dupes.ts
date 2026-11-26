/**
 * measure-question-dupes.ts: how close in meaning (cosine) the texts each meaning cut-off judges
 * come out, for every reader of the brand map family (scripts/lib/questionDupes.ts):
 *   - a proposed subject against one on the map (LOOKS_LIKE), a Google search against a subject
 *     (NEAR_SUBJECT), a question against a buying situation;
 *   - a new question for the team against the same ask reworded and a different ask
 *     (DUP_QUESTION_SIM), and against a note that answers it and one that doesn't (DUP_NOTE_SIM).
 * Prints each group's range and where a cut-off would separate them. The cut-offs are pairs (ADR-0023):
 * `old` for brand_map_vectors, `new` for brand search; re-run this before changing either.
 *
 *   --model old: text-embedding-005, each side embedded as brand_map_vectors embeds it (Vertex AI only).
 *   --model new: gemini-embedding-001, each side embedded as brand search's indexer embeds it, with
 *     the reader's task type (Vertex AI, or a Gemini API key on a laptop).
 *
 * Read only: it sends the made-up texts in scripts/lib/questionDupes.ts to the embedding model and
 * writes nothing. It costs under a cent.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/measure-question-dupes.ts --model new
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/measure-question-dupes.ts --model old
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 */

import { parseOperatorArgs, refuse } from "./lib/operatorCli";
import { GROUPS, measure, type Embedder, type Model } from "./lib/questionDupes";

const TOOL = "measure-question-dupes";
const args = parseOperatorArgs(TOOL, process.argv.slice(2), ["model"], []);

async function main() {
  const model = (args.get("model") ?? "old") as Model;
  if (model !== "old" && model !== "new") refuse(TOOL, "--model takes old or new.");
  const { embedDocuments, embedForSearch, embedQuery, embeddingBackend } = await import("@/lib/agents/embeddings");
  if (model === "old" && embeddingBackend() !== "vertex") refuse(TOOL, "--model old needs Vertex AI (text-embedding-005): set GOOGLE_CLOUD_PROJECT to a real project.");
  const embed: Embedder =
    model === "new"
      ? (items, task) => embedForSearch(items, "us", task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT")
      : (items, task) => (task === "query" ? Promise.all(items.map((i) => embedQuery(i.content, "us"))) : embedDocuments(items, "us"));
  console.log(`[${TOOL}] model=${model === "new" ? "gemini-embedding-001 (brand search)" : "text-embedding-005 (brand_map_vectors)"}`);
  for (const line of await measure(GROUPS, model, embed)) console.log(line);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
