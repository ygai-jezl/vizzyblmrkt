/**
 * backfill-person-links.ts: build the person record for everyone a brand already has:
 * each contact (from launch sign-ups) and each user of a connected product, linked by
 * address (AUDIENCE_PERSON_LINKS_ENABLED). New writes keep the records up to date once
 * the switch is on; this covers everyone from before. Run it before turning the switch
 * on, and once more straight after, for the writes made in between.
 *
 * DRY RUN by default: it says how many people it would create, update, leave alone and
 * remove. Pass --apply to write. Safe to re-run: a person already right is left alone.
 * It prints counts only, never an address.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-person-links.ts
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-person-links.ts --apply
 * Optional:  --tenant <tenantId>
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 * Pages contacts by (tenantId, createdAt DESC) and each product's users by
 * (tenantId, connectionId, lastSeenAt DESC), both existing indexes.
 */

// Never touch a local emulator (a dev shell may export these).
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

import { forTenant, listAllTenants, type WhereClause } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { Contact } from "@/lib/types/contact";
import type { ProductUser } from "@/lib/types/productUser";
import { loadPeopleConnections, personKeyOf, syncPerson, type SyncOutcome } from "@/lib/audience/personSync";

const PAGE = 300;
const APPLY = process.argv.includes("--apply");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY_TENANT = flag("tenant");

/**
 * Every row, newest first by `field`, without skipping rows that share a value: a full
 * page holds back its trailing rows with the last value, so the next page includes them.
 */
async function* pages<T extends { id: string }>(
  find: (opts: { where: WhereClause[]; orderBy: Array<[string, "desc"]>; limit: number; startAfter?: unknown[] }) => Promise<T[]>,
  where: WhereClause[],
  field: keyof T & string,
  label: string,
): AsyncGenerator<T[]> {
  let cursor: unknown = null;
  for (;;) {
    const page = await find({ where, orderBy: [[field, "desc"]], limit: PAGE, ...(cursor ? { startAfter: [cursor] } : {}) });
    if (page.length < PAGE) {
      yield page;
      return;
    }
    const last = page[page.length - 1]![field];
    const keep = page.filter((row) => row[field] !== last);
    if (keep.length === 0) {
      console.warn(`[person-links] ${label}: ${PAGE}+ rows share one ${field}; some may be skipped`);
      yield page;
      cursor = last;
      continue;
    }
    yield keep;
    cursor = keep[keep.length - 1]![field];
  }
}

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error("Set GOOGLE_CLOUD_PROJECT to the project whose Firestore to backfill.");
    process.exit(1);
  }
  console.log(`[person-links] project=${project} mode=${APPLY ? "APPLY" : "dry-run"}${ONLY_TENANT ? ` tenant=${ONLY_TENANT}` : ""}`);

  const tenants = (await listAllTenants()).filter((t) => !ONLY_TENANT || t.id === ONLY_TENANT);
  const counts: Record<SyncOutcome | "failed", number> = { created: 0, updated: 0, unchanged: 0, deleted: 0, none: 0, failed: 0 };
  for (const t of tenants) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    const repo = forTenant(ctx);
    const connections = await loadPeopleConnections(ctx);
    const done = new Set<string>();
    const sync = async (key: string) => {
      if (done.has(key)) return;
      done.add(key);
      try {
        const r = await syncPerson(ctx, key, { connections, dryRun: !APPLY });
        counts[r.outcome] += 1;
      } catch (err) {
        counts.failed += 1;
        console.warn(`[person-links] ${t.id}: a sync failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
      }
    };
    for await (const page of pages<Contact>((o) => repo.contacts.find(o), [], "createdAt", `${t.id} contacts`)) {
      for (const c of page) await sync(c.contactKey);
    }
    for (const c of connections.values()) {
      for await (const page of pages<ProductUser>((o) => repo.productUsers.find(o), [["connectionId", "==", c.id]], "lastSeenAt", `${t.id} ${c.id}`)) {
        for (const u of page) if (u.status === "active") await sync(personKeyOf(u));
      }
    }
    console.log(`[person-links] ${t.id} (${t.region}): ${done.size} people`);
  }
  const verb = APPLY ? "" : "would be ";
  console.log(
    `[person-links] done: ${verb}created=${counts.created} ${verb}updated=${counts.updated} unchanged=${counts.unchanged} ${verb}removed=${counts.deleted} nothing-to-link=${counts.none} failed=${counts.failed}${APPLY ? "" : " (dry run: pass --apply to write)"}`,
  );
}

main().catch((err) => {
  console.error("[person-links] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
