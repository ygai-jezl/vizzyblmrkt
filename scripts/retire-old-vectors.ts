/**
 * retire-old-vectors.ts: empty brand_map_vectors once brand search has taken over its readers
 * (ADR-0023). DRY RUN by default: it counts, per region, brand and kind, the vectors the old store
 * still holds beside the records brand search holds of the same kind, and deletes nothing.
 *
 * --apply deletes them, and refuses unless:
 *   - the settings file named by --settings (the environment's apphosting.<env>.yaml) turns on
 *     SEARCH_INDEX_ENABLED, SEARCH_FAMILY_INDEX_ENABLED, the three read switches
 *     (SEARCH_SUBJECT_READS_ENABLED, SEARCH_NOTE_READS_ENABLED, SEARCH_COMPETITOR_READS_ENABLED) and
 *     SEARCH_OLD_VECTORS_RETIRED_ENABLED, all "true";
 *   - no brand holds old vectors of a kind with nothing of that kind in brand search (run
 *     scripts/search-backfill.ts --all-brands first).
 * Run it only after the retire switch has been on through the soak. THE DELETE CAN'T BE UNDONE:
 * text-embedding-005 retires, so nothing could embed them again, and turning a read switch off
 * afterwards finds nothing.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/retire-old-vectors.ts --settings <path to apphosting.<env>.yaml>
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/retire-old-vectors.ts --settings <path to apphosting.<env>.yaml> --apply
 * Optional: --tenant <tenantId> (one brand)   --local (the emulators only)
 *
 * Auth = Application Default Credentials that can read every regional database and the search
 * databases (and delete in the regional ones, for --apply).
 */

import { readFileSync } from "node:fs";
import { parseOperatorArgs, printHeader, refuse, settleEnvironment } from "./lib/operatorCli";
import { entryMap } from "./selfhost/envfile.mjs";

const TOOL = "retire-old-vectors";
const args = parseOperatorArgs(TOOL, process.argv.slice(2), ["settings", "tenant"], ["apply", "local"]);
const APPLY = args.has("apply");

async function main() {
  const settingsPath = args.get("settings");
  if (APPLY && !settingsPath) refuse(TOOL, "--apply needs --settings <the environment's apphosting.<env>.yaml>, to check its switches.");
  const where = settleEnvironment(TOOL, args.has("local"));
  const { listAllTenants } = await import("@/lib/tenant");
  const { deleteOldVectors, retireBlockers, retireCounts, retireLines, switchesNotOn } = await import("@/lib/search/retire");

  let off: string[] | null = null;
  if (settingsPath) {
    let text: string;
    try {
      text = readFileSync(settingsPath, "utf8");
    } catch {
      refuse(TOOL, `Can't read ${settingsPath}.`);
    }
    off = switchesNotOn(entryMap(text) as Map<string, { value?: string }>);
  }
  printHeader(TOOL, where, [
    `mode=${APPLY ? "APPLY: deletes, and can't be undone" : "dry run"}`,
    args.get("tenant") ? `brand ${args.get("tenant")}` : "every brand",
    settingsPath ? `settings ${settingsPath}: ${off!.length ? `not on: ${off!.join(", ")}` : "every switch it needs is on"}` : "settings: none given (needed for --apply)",
  ]);

  const tenants = (await listAllTenants()).filter((t) => !args.get("tenant") || t.id === args.get("tenant"));
  const rows = await retireCounts(tenants.map((t) => ({ id: t.id, region: t.region })));
  for (const line of retireLines(rows)) console.log(`[${TOOL}] ${line}`);
  if (!rows.some((r) => r.old > 0)) {
    console.log(`[${TOOL}] brand_map_vectors holds nothing for ${args.get("tenant") ? "this brand" : "any brand"}.`);
    return;
  }
  const blockers = retireBlockers(rows);
  if (!APPLY) {
    console.log(`[${TOOL}] Dry run: nothing deleted.${blockers.length ? ` --apply would refuse (marked above): fill brand search first (scripts/search-backfill.ts --all-brands).` : ""}`);
    return;
  }
  if (off!.length) refuse(TOOL, `Refused: ${off!.join(", ")} not "true" in ${settingsPath}. Turn them on there, deploy, and let the soak run first.`);
  if (blockers.length) refuse(TOOL, `Refused: ${blockers.length === 1 ? "a brand holds old vectors of a kind" : `${blockers.length} brand and kind pairs hold old vectors`} with nothing of it in brand search (marked above). Run scripts/search-backfill.ts --all-brands, then this again.`);
  const deleted = await deleteOldVectors(rows);
  console.log(`[${TOOL}] Deleted ${deleted.toLocaleString("en-US")} old ${deleted === 1 ? "vector" : "vectors"}. Run the dry run again: it should find nothing.`);
}

main().catch((err) => {
  console.error(`[${TOOL}] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
