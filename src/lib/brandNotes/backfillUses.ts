import { getContentPlan } from "@/lib/tenant/workspaceContent";
import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { BRAND_NOTE_LIMITS, type BrandNote, type NoteUse } from "@/lib/types/brandNote";
import type { ContentPlan } from "@/lib/types/contentPlan";
import { usesOf } from "./rest";

/**
 * Dates the uses a note had before dates were kept (BRAND_NOTES_REST_ENABLED): each article in
 * `usedBy` without a dated use gets one, dated when its hub was last fact checked (where the use
 * is recorded), or else when the plan was last saved, under the plan's name. Both are on or after
 * the real use, so a date is never earlier than it was: a note rests a little longer, never less.
 * An article that is gone stays undated (it still counts toward the limit). Safe to re-run.
 */

export interface BackfillCounts {
  /** Uses dated (or that would be, on a dry run). */
  dated: number;
  /** Uses whose article is gone, left undated. */
  gone: number;
}

/** When an article was written with its notes, as near as it can be told, and what it is called. */
export function articleUse(ref: string, plan: ContentPlan): NoteUse {
  const hub = plan.graph.nodes.find((n) => n.type === "hub" && n.channel === "blog");
  const at = hub?.blog?.checkedAt || plan.updatedAt;
  return { ref, title: plan.name.replace(/\s+/g, " ").trim().slice(0, BRAND_NOTE_LIMITS.MAX_ARTICLE_TITLE), at, written: true };
}

export async function backfillNoteUses(
  ctx: TenantContext,
  note: BrandNote,
  opts: { apply: boolean },
  deps: { db?: FirestoreLike } = {},
): Promise<BackfillCounts> {
  const dated = new Set(usesOf(note).map((u) => u.ref));
  const missing = [...new Set(note.usedBy ?? [])].filter((ref) => !dated.has(ref));
  if (!missing.length) return { dated: 0, gone: 0 };
  const found = await Promise.all(
    missing.map(async (ref) => {
      const [ws, planId] = ref.split("/");
      const plan = ws && planId ? await getContentPlan(ctx, ws, planId, deps.db).catch(() => null) : null;
      return plan ? articleUse(ref, plan) : null;
    }),
  );
  const add = found.filter((u): u is NoteUse => u !== null);
  if (opts.apply && add.length) {
    await forTenant(ctx, deps.db).brandNotes.claim(note.id, (n) => {
      const have = new Set(usesOf(n).map((u) => u.ref));
      const fresh = add.filter((u) => !have.has(u.ref));
      if (!fresh.length) return null;
      const uses = [...fresh, ...usesOf(n)].sort((a, b) => a.at.localeCompare(b.at)).slice(-BRAND_NOTE_LIMITS.MAX_USES);
      return { uses };
    });
  }
  return { dated: add.length, gone: missing.length - add.length };
}
