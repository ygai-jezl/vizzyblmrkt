/**
 * backfill-product-activation.ts — set `activated` / `activatedAt` on existing
 * product users (nav v2 phase 4). New events set it at ingest
 * (`applyMessage` in src/lib/connect/profile.ts); this covers users who finished
 * onboarding before that shipped, so Insights and invites can count them.
 *
 * DRY RUN by default. Pass --apply to write. Idempotent: users already activated,
 * deleted, or not (yet) activated are left alone, so it's safe to re-run.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-product-activation.ts
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-product-activation.ts --apply
 * Optional:  --tenant <tenantId>
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 * Pages each connection's users by the existing (tenantId, connectionId,
 * lastSeenAt DESC) index — no new index needed.
 */

// Never touch a local emulator (a dev shell may export these).
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

import { forTenant, listAllTenants } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import type { ProductUser } from "@/lib/types/productUser";
import { activationAt } from "@/lib/connect/profile";

const PAGE = 300;
const APPLY = process.argv.includes("--apply");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY_TENANT = flag("tenant");

/** Every user of one connection, newest first, without skipping users that share a lastSeenAt. */
async function* usersOf(ctx: TenantContext, connectionId: string): AsyncGenerator<ProductUser[]> {
  const repo = forTenant(ctx).productUsers;
  let cursor: string | null = null;
  for (;;) {
    const page: ProductUser[] = await repo.find({
      where: [["connectionId", "==", connectionId]],
      orderBy: [["lastSeenAt", "desc"]],
      limit: PAGE,
      ...(cursor ? { startAfter: [cursor] } : {}),
    });
    if (page.length < PAGE) {
      yield page;
      return;
    }
    // A full page: hold back trailing users that share the last lastSeenAt, so the
    // next page (which starts after the cursor value) includes all of them.
    const last = page[page.length - 1]!.lastSeenAt;
    const keep = page.filter((u) => u.lastSeenAt !== last);
    if (keep.length === 0) {
      console.warn(`[activation] ${connectionId}: ${PAGE}+ users share lastSeenAt ${last}; some may be skipped`);
      yield page;
      cursor = last;
      continue;
    }
    yield keep;
    cursor = keep[keep.length - 1]!.lastSeenAt;
  }
}

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error("Set GOOGLE_CLOUD_PROJECT to the project whose Firestore to backfill.");
    process.exit(1);
  }
  console.log(`[activation] project=${project} mode=${APPLY ? "APPLY" : "dry-run"}${ONLY_TENANT ? ` tenant=${ONLY_TENANT}` : ""}`);

  const tenants = (await listAllTenants()).filter((t) => !ONLY_TENANT || t.id === ONLY_TENANT);
  let scanned = 0;
  let toActivate = 0;
  let written = 0;
  for (const t of tenants) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    const connections = await forTenant(ctx).productConnections.find({ limit: 200 });
    for (const c of connections) {
      const steps = c.catalog?.onboardingSteps ?? [];
      for await (const page of usersOf(ctx, c.id)) {
        for (const u of page) {
          scanned += 1;
          if (u.status !== "active" || u.activated) continue;
          const at = activationAt(u, steps);
          if (!at) continue;
          toActivate += 1;
          if (!APPLY) continue;
          // claim() re-reads inside a transaction, so a racing ingest that already
          // set the flag wins and this write is skipped.
          const done = await forTenant(ctx).productUsers.claim(u.id, (cur) =>
            cur.status === "active" && !cur.activated ? { activated: true, activatedAt: at } : null,
          );
          if (done) written += 1;
        }
      }
      console.log(`[activation] ${t.id} (${t.region}) ${c.id}: scanned so far ${scanned}`);
    }
  }
  console.log(
    `[activation] done: scanned=${scanned} qualify=${toActivate} ${APPLY ? `written=${written}` : "(dry run — pass --apply to write)"}`,
  );
}

main().catch((err) => {
  console.error("[activation] failed:", err);
  process.exit(1);
});
