/**
 * backfill-note-uses.ts: date the uses What we've seen notes had before dates were kept
 * (BRAND_NOTES_REST_ENABLED). A note rests after an article uses it, and only a dated use can
 * make it rest; an undated one only counts toward the limit. Each article a note was used in gets
 * a dated use, from when its hub was last fact checked, or else the plan's last save (both on or
 * after the real use, so a note rests a little longer, never less). Run it straight after turning
 * the switch on.
 *
 * DRY RUN by default: it says how many uses it would date, per brand. Pass --apply to write.
 * Safe to re-run: a use already dated is never moved. It prints counts only, never a note.
 *
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-note-uses.ts
 *   GOOGLE_CLOUD_PROJECT=<your-project> npx tsx scripts/backfill-note-uses.ts --apply
 * Optional:  --tenant <tenantId>
 *
 * Auth = Application Default Credentials (`gcloud auth application-default login`).
 * Reads each brand's notes by (tenantId, createdAt DESC), an existing index, and plans by id.
 */

// Never touch a local emulator (a dev shell may export these).
delete process.env.FIRESTORE_EMULATOR_HOST;
delete process.env.FIREBASE_AUTH_EMULATOR_HOST;

import { listAllTenants } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { listNotes } from "@/lib/brandNotes/store";
import { backfillNoteUses } from "@/lib/brandNotes/backfillUses";

const APPLY = process.argv.includes("--apply");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY_TENANT = flag("tenant");

async function main() {
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.error("Set GOOGLE_CLOUD_PROJECT to the project whose Firestore to backfill.");
    process.exit(1);
  }
  console.log(`[note-uses] project=${project} mode=${APPLY ? "APPLY" : "dry-run"}${ONLY_TENANT ? ` tenant=${ONLY_TENANT}` : ""}`);

  const tenants = (await listAllTenants()).filter((t) => !ONLY_TENANT || t.id === ONLY_TENANT);
  const total = { notes: 0, dated: 0, gone: 0, failed: 0 };
  for (const t of tenants) {
    const ctx: TenantContext = { tenantId: t.id, region: t.region, source: "system" };
    const notes = (await listNotes(ctx)).filter((n) => n.usedBy?.length);
    const counts = { dated: 0, gone: 0 };
    for (const n of notes) {
      try {
        const r = await backfillNoteUses(ctx, n, { apply: APPLY });
        counts.dated += r.dated;
        counts.gone += r.gone;
      } catch (err) {
        total.failed += 1;
        console.warn(`[note-uses] ${t.id}: a note failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
      }
    }
    total.notes += notes.length;
    total.dated += counts.dated;
    total.gone += counts.gone;
    if (notes.length) console.log(`[note-uses] ${t.id} (${t.region}): ${notes.length} notes used, ${counts.dated} uses ${APPLY ? "" : "to be "}dated, ${counts.gone} articles gone`);
  }
  console.log(
    `[note-uses] done: ${total.notes} notes used, ${APPLY ? "" : "would date "}${total.dated} uses${APPLY ? " dated" : ""}, ${total.gone} articles gone (left undated), failed=${total.failed}${APPLY ? "" : " (dry run: pass --apply to write)"}`,
  );
}

main().catch((err) => {
  console.error("[note-uses] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
