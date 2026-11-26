/**
 * What scripts/search-backfill.ts must know before any library code loads: which switches decide
 * what the index keeps on the deployment it fills (ADR-0023). Pure, and it imports nothing from
 * src/lib on purpose, as scripts/lib/operatorCli.ts.
 */

/** The switches that decide what the index keeps, read from the deployment's settings file. */
export const BACKFILL_SWITCHES = ["SEARCH_FAMILY_INDEX_ENABLED", "SEARCH_KIND_IDEA_BOARD_ENABLED"] as const;

/**
 * What the index keeps on the deployment being filled, so the run writes what its scheduled check
 * writes. Run as a deployment without the brand map family, it would take statuses, proposals and
 * answered questions out of brand search for every granted brand, and each scheduled check would
 * put them back only on the brand's family turn, up to 6 hours later.
 * - `--settings <apphosting.<env>.yaml>`: each of BACKFILL_SWITCHES as that file sets it ("true"
 *   or off), whatever the shell says.
 * - `--all-brands` alone: the family on, as on a deployment that keeps it.
 * - Neither: refused, since the shell can't say what the deployment keeps.
 * Returns the environment to set before library code loads, or why it refuses.
 */
export function backfillSwitches(opts: { allBrands: boolean; settings: { path: string; entries: ReadonlyMap<string, { value?: string }> } | null }): { env: Record<string, string> } | { refuse: string } {
  if (opts.settings) {
    const on = (name: string) => opts.settings!.entries.get(name)?.value === "true";
    if (opts.allBrands && !on("SEARCH_FAMILY_INDEX_ENABLED")) {
      return { refuse: `--all-brands fills a deployment that keeps the brand map family, and SEARCH_FAMILY_INDEX_ENABLED isn't "true" in ${opts.settings.path}. Leave out --all-brands, or turn the switch on there and roll it out first.` };
    }
    return { env: Object.fromEntries(BACKFILL_SWITCHES.map((name) => [name, on(name) ? "true" : "false"])) };
  }
  if (opts.allBrands) return { env: { SEARCH_FAMILY_INDEX_ENABLED: "true" } };
  return {
    refuse:
      "Say what this deployment's index keeps: pass --settings <its apphosting.<env>.yaml> (its SEARCH_FAMILY_INDEX_ENABLED and SEARCH_KIND_IDEA_BOARD_ENABLED decide), " +
      "or --all-brands where SEARCH_FAMILY_INDEX_ENABLED is on. Without either, a run would write brand search as a deployment without the brand map family does.",
  };
}
