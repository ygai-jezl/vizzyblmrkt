import { readFileSync } from "node:fs";
import { backfillSwitches } from "./lib/backfillSwitches";
import { parseOperatorArgs, refuse } from "./lib/operatorCli";
import { entryMap } from "./selfhost/envfile.mjs";

/**
 * Fill each brand's search index from what it already has (brand search, addon:search). The
 * scheduled check does the same a little at a time; this does it all at once, brand by brand.
 * Only brands that may use search (GRANTED_ONLY_FEATURES / grantedFeatures) are touched, unless
 * --all-brands.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project-id> npx tsx scripts/search-backfill.ts --settings <apphosting.<env>.yaml>            # dry run (default)
 *   GOOGLE_CLOUD_PROJECT=<your-project-id> npx tsx scripts/search-backfill.ts --settings <apphosting.<env>.yaml> --apply    # embed and write
 *   Optional: --tenant <tenantId>   --kinds subject,situation,note,question,competitor   --all-brands
 *
 * It writes what the deployment's scheduled check writes, so it must know what that keeps, and
 * refuses to run until told: --settings names the deployment's settings file, whose
 * SEARCH_FAMILY_INDEX_ENABLED and SEARCH_KIND_IDEA_BOARD_ENABLED it follows (whatever the shell
 * says), or --all-brands alone says the family is on. Roll a settings change out before filling,
 * or the running check undoes the fill.
 *
 * --all-brands is for a deployment with SEARCH_FAMILY_INDEX_ENABLED on (ADR-0023): every brand,
 * and the brand map family (subjects, situations, kept notes, questions asked of the team and
 * competitor articles) with their statuses for those without brand_search. With the family off,
 * it is indexed as before that switch, for granted brands only. --kinds reads and removes only
 * those kinds; the rest are left alone.
 *
 * The dry run reads every brand's records and the index and prints, per brand, how many records
 * there are by kind, how many would be indexed and removed, and what --apply would embed: chunks,
 * tokens and cost (gemini-embedding-001 in the brand's region, about $0.15 per million tokens),
 * and how many records already indexed would only get their status. Nothing is embedded or
 * written. --apply embeds what changed and writes it, and writes statuses on records already
 * indexed. Safe to run again: unchanged records are skipped. Needs ADC
 * (`gcloud auth application-default login`) that can read the project's databases, the search
 * databases (search, search-eu, search-asia) and call Vertex AI.
 */

const TOOL = "search-backfill";
const args = parseOperatorArgs(TOOL, process.argv.slice(2), ["tenant", "kinds", "settings"], ["apply", "all-brands"]);
const APPLY = args.has("apply");
const ALL_BRANDS = args.has("all-brands");
const ONLY_TENANT = args.get("tenant");
const SETTINGS = args.get("settings");

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project && !process.env.FIRESTORE_EMULATOR_HOST) refuse(TOOL, "Set GOOGLE_CLOUD_PROJECT to the project to fill.");
  let settings: { path: string; entries: Map<string, { value?: string }> } | null = null;
  if (SETTINGS) {
    try {
      settings = { path: SETTINGS, entries: entryMap(readFileSync(SETTINGS, "utf8")) as Map<string, { value?: string }> };
    } catch {
      refuse(TOOL, `Can't read ${SETTINGS}.`);
    }
  }
  const decided = backfillSwitches({ allBrands: ALL_BRANDS, settings });
  if ("refuse" in decided) refuse(TOOL, decided.refuse);
  // What the deployment keeps, as its scheduled check reads it. The indexer does nothing while its
  // switch is off; this script is the operator turning it on.
  for (const [name, value] of Object.entries(decided.env)) process.env[name] = value;
  process.env.SEARCH_INDEX_ENABLED = "true";
  // Library code reads the settled environment, so it loads after it.
  const { listAllTenants } = await import("@/lib/tenant");
  const { sweepBrand } = await import("@/lib/search/sweep");
  const { backfillTargets, costWords, parseKinds } = await import("@/lib/search/backfill");

  const kindNames = args.all("kinds");
  const parsed = kindNames.length ? parseKinds(kindNames) : null;
  if (parsed && "unknown" in parsed) refuse(TOOL, `--kinds: "${parsed.unknown}" isn't a kind brand search keeps.`);
  const kinds = parsed && "kinds" in parsed ? parsed.kinds : undefined;
  console.log(
    `[${TOOL}] project=${project ?? "(emulator)"} mode=${APPLY ? "APPLY" : "dry run"}${ONLY_TENANT ? ` tenant=${ONLY_TENANT}` : ""}` +
      `${ALL_BRANDS ? " every brand (the family for brands without brand_search)" : ""}${kinds ? ` kinds=${[...kinds].join(",")}` : ""}`,
  );
  console.log(
    `[${TOOL}] ${settings ? `settings ${settings.path}` : "--all-brands"}: ` +
      Object.entries(decided.env)
        .map(([name, value]) => `${name}=${value}`)
        .join(" "),
  );

  const targets = backfillTargets(await listAllTenants(), { allBrands: ALL_BRANDS, tenant: ONLY_TENANT });
  if (!targets.length) console.log("No brand to fill (check --tenant, and GRANTED_ONLY_FEATURES with the brand's grantedFeatures, or pass --all-brands).");
  let failed = 0;
  for (const { tenant: t, familyOnly } of targets) {
    const ctx = { tenantId: t.id, region: t.region, source: "system" as const };
    try {
      const c = await sweepBrand(ctx, { dryRun: !APPLY, estimate: !APPLY, familyOnly, familyNow: true, kinds });
      const byKind = Object.entries(c.byKind)
        .map(([k, n]) => `${k} ${n}`)
        .join(", ");
      console.log(
        `  ${t.id} (${t.region})${familyOnly ? " family only" : ""}: ${c.records} records [${byKind || "none"}]; ` +
          (APPLY
            ? `indexed ${c.indexed}, unchanged ${c.unchanged}, removed ${c.removed}, failed ${c.failed}`
            : `would index ${c.changed}, would remove ${c.removed}${c.estimate ? `; would embed ${costWords(c.estimate)}` : ""}`) +
          // A kind whose read failed is neither filled nor removed: a failure to run again for.
          (c.unread.length ? `; couldn't read ${c.unread.join(", ")}` : ""),
      );
      failed += c.failed + c.unread.length;
    } catch (err) {
      failed += 1;
      console.error(`  ${t.id}: failed: ${err instanceof Error ? err.message.slice(0, 300) : "error"}`);
    }
  }
  console.log(APPLY ? `[${TOOL}] done${failed ? `, ${failed} failed (run it again to retry)` : ""}` : `[${TOOL}] dry run: nothing written. Add --apply to fill.`);
  process.exit(failed ? 1 : 0);
}

void main();
