import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { CatalogRevision } from "@/lib/types/catalogRevision";

/**
 * Catalog history once stored who saved a version as their sign-in address. It keeps a user id
 * now (decision 30), and scripts/scrub-catalog-savers.ts replaces each stored address with that
 * person's user id, or null when nobody has it any more. The logic lives here so it is tested.
 */

/** An address in `savedBy`, from before history kept user ids. */
export function isSaverAddress(savedBy: unknown): savedBy is string {
  return typeof savedBy === "string" && savedBy.includes("@");
}

/** Looks an address up: the user id of whoever signs in with it, or null when nobody does. */
export type ResolveSaver = (email: string) => Promise<string | null>;

/** One address's resolution, asked once per run however many versions name it. */
export function cachedResolver(resolve: ResolveSaver): ResolveSaver {
  const seen = new Map<string, Promise<string | null>>();
  return (email) => {
    const key = email.trim().toLowerCase();
    let hit = seen.get(key);
    if (!hit) {
      hit = resolve(key);
      seen.set(key, hit);
    }
    return hit;
  };
}

export interface ScrubCounts {
  scanned: number;
  /** Addresses replaced (or that would be) by a user id. */
  replaced: number;
  /** Addresses cleared (or that would be): nobody signs in with them now. */
  cleared: number;
  /** Versions with no address: a user id already, or nobody. */
  already: number;
  /** Versions gone between the read and the write (none are pruned now); also counted above. */
  gone: number;
}

export const emptyScrubCounts = (): ScrubCounts => ({ scanned: 0, replaced: 0, cleared: 0, already: 0, gone: 0 });

const PAGE = 300;

/**
 * Replace every address in one brand's catalog history with the saver's user id, or null. Reads
 * the brand's versions by document id a page at a time, so it needs no index. With `dryRun` it
 * counts what it would write. Safe to run again: a version without an address is left alone.
 */
export async function scrubCatalogSavers(
  ctx: TenantContext,
  opts: { resolve: ResolveSaver; dryRun: boolean; db?: FirestoreLike },
): Promise<ScrubCounts> {
  const counts = emptyScrubCounts();
  const resolve = cachedResolver(opts.resolve);
  const col = forTenant(ctx, opts.db).catalogRevisions;
  let startAfter: string | null = null;
  for (;;) {
    let replaced = 0;
    let cleared = 0;
    const page = await col.updateWhere(
      [],
      async (row: CatalogRevision) => {
        if (!isSaverAddress(row.savedBy)) return null;
        const uid = await resolve(row.savedBy);
        if (uid) replaced += 1;
        else cleared += 1;
        return { savedBy: uid };
      },
      { startAfter, limit: PAGE, dryRun: opts.dryRun },
    );
    counts.scanned += page.scanned;
    counts.already += page.unchanged;
    counts.replaced += replaced;
    counts.cleared += cleared;
    counts.gone += page.gone;
    if (!page.more) break;
    startAfter = page.last;
  }
  return counts;
}
