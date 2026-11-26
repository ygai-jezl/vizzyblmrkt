/**
 * search-nearest-check.ts: the filter-first check for the brand map family in brand search
 * (ADR-0023). Read only by default.
 *
 * On one brand it finds the subjects nearest one of its articles' vectors, the way the brand map's
 * readers will once SEARCH_SUBJECT_READS_ENABLED is on, and prints Query Explain's analysis (the
 * read units) and the brand's index by kind. Nothing is written.
 *
 * With --seed (a dev project only, and --dev to say so) it adds made-up chunks with random vectors
 * under a throwaway brand path beside the brand's (brands/<tenantId>_qcheck_<random>): one decided
 * subject, 5,000 article chunks and 5,000 proposed subject chunks. It checks that the subject comes
 * first for an article's vector, that people's search finds it and no proposal, prints Query
 * Explain's analysis, then deletes the throwaway path. The brand's own index is never touched.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-dev-project> npx tsx scripts/search-nearest-check.ts --tenant <tenantId>
 *   GOOGLE_CLOUD_PROJECT=<your-dev-project> npx tsx scripts/search-nearest-check.ts --tenant <tenantId> --seed --dev
 * Optional: --source <kind:ref> (an article of the brand's to start from)   --local (the emulators only)
 *
 * Auth = Application Default Credentials that can read the region's search database (and write it,
 * for --seed). On the emulator there is no Query Explain, and statuses are filtered in code.
 */

import { randomInt } from "node:crypto";
import { parseOperatorArgs, printHeader, refuse, settleEnvironment } from "./lib/operatorCli";

const TOOL = "search-nearest-check";
const args = parseOperatorArgs(TOOL, process.argv.slice(2), ["tenant", "source"], ["seed", "dev", "local"]);

async function main() {
  const tenantId = args.get("tenant");
  if (!tenantId) refuse(TOOL, "Pass --tenant <tenantId>.");
  if (args.has("seed") && !args.has("dev") && !args.has("local")) refuse(TOOL, "--seed writes and deletes made-up chunks: run it on a dev project only, and add --dev to say so.");
  const where = settleEnvironment(TOOL, args.has("local"));
  const { getTenantById } = await import("@/lib/tenant");
  const { explainNearest, searchStoreFor } = await import("@/lib/tenant/searchIndex");
  const { checkSeeded, hitWords, indexByKind, seedCheck, seededRandom, throwawayTenantId } = await import("@/lib/search/nearestCheck");
  const { SEARCH_EMBEDDING_DIM } = await import("@/lib/agents/embeddings");

  const tenant = await getTenantById(tenantId);
  if (!tenant) refuse(TOOL, `No brand ${tenantId}.`);
  const ctx = { tenantId: tenant.id, region: tenant.region };
  printHeader(TOOL, where, [`brand ${tenant.id} (${tenant.region})`, args.has("seed") ? "mode=SEED: writes made-up chunks under a throwaway path, then deletes them" : "mode=read only"]);

  const store = searchStoreFor(ctx);
  const manifests = await store.listManifests();
  console.log(`[${TOOL}] the brand's index: ${indexByKind(manifests)}`);

  if (!args.has("seed")) {
    const wanted = args.get("source");
    const article = wanted ? manifests.find((m) => m.sourceKey === wanted) : manifests.find((m) => m.kind === "article" && m.embedded);
    if (!article) refuse(TOOL, wanted ? `No ${wanted} in the brand's index.` : "The brand has no embedded article in its index: pass --source <kind:ref>.");
    const vector = await store.vectorOf(article.sourceKey);
    if (!vector) refuse(TOOL, `${article.sourceKey} has no vector.`);
    for (const statuses of [["decided"], ["decided", "proposed"]] as const) {
      const run = await explainNearest(ctx, ["subject"], vector, { statuses: [...statuses], limit: 10 });
      console.log(`[${TOOL}] subjects (${statuses.join(" or ")}) nearest ${article.sourceKey}: ${hitWords(run.hits)}`);
      console.log(`[${TOOL}] Query Explain: ${run.explain ?? "(none on the emulator)"}`);
    }
    return;
  }

  const rand = seededRandom(randomInt(2 ** 31));
  const throwaway = { tenantId: throwawayTenantId(tenant.id, rand), region: tenant.region };
  const seeded = searchStoreFor(throwaway);
  console.log(`[${TOOL}] seeding brands/${throwaway.tenantId} ...`);
  let failed = false;
  try {
    const subject = await seedCheck(seeded, throwaway.tenantId, { dim: SEARCH_EMBEDDING_DIM, rand, now: new Date().toISOString() });
    const r = await checkSeeded(seeded, (kinds, vector, opts) => explainNearest(throwaway, kinds, vector, opts), subject, rand);
    for (const line of r.lines) console.log(`[${TOOL}] ${line}`);
    console.log(`[${TOOL}] Query Explain: ${r.explain ?? "(none on the emulator)"}`);
    failed = !r.nearestFound || !r.peopleFound;
  } finally {
    const gone = await seeded.clear();
    console.log(`[${TOOL}] deleted brands/${throwaway.tenantId} (${gone} chunks)`);
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(`[${TOOL}] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
