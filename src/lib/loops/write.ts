import { createHash } from "node:crypto";
import { isImageStyleVersionsOn } from "@/lib/content/imageStyle/flags";
import { forTenant } from "@/lib/tenant";
import { readBrandPointersTx, runLoopsTransaction, writeBrandPointersTx } from "@/lib/tenant/loops";
import { appendPatternVersionTx } from "@/lib/tenant/patternVersions";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ImageAsset } from "@/lib/types/imageAsset";
import { EVIDENCE_IDS_MAX, type LearnedPatternVersion } from "@/lib/types/learnedPatternVersion";
import type { LearnReason } from "./learnLog";
import { IMAGE_STYLE_SCOPES, LOOP_RULES, type ImageStyleScope } from "./registry";
import { textRefusalOf, type TextRefusal } from "./textCheck";

/**
 * The one writer of what a loop learned (learning loops step 4, 3.4 of the plan for steps 4 and
 * 5): `proposeLearned(ctx, scope, change, evidenceIds, opts)`. Only the learners in
 * src/lib/loops/learners/ call it (oneWriter.test.ts). It adopts a learned look as a new version
 * of the scope, with a notice and Undo on the screens and no card.
 *
 * - Callers never say how far the words can be trusted. It reads every evidence id itself and
 *   refuses unless each is an image row of this brand that a person voted on, or uploaded
 *   (`brandVoteVia` vote or upload). So text from connectors, competitors, search, knowledge or an
 *   agent can never become a look: none of it is an image a person voted on.
 * - It runs the loops' one text check on the words (src/lib/loops/textCheck.ts) and refuses links,
 *   email addresses, @handles and phone numbers (reason trust), never cleaning them out.
 * - One item per version.
 * - The version row and the brand's pointer (`lb:`) are written in one transaction, the row with
 *   `create()` (appendPatternVersionTx), so the two never disagree and a second writer that worked
 *   out the same version fails instead of overwriting it.
 * - A refusal has a reason from step 2's LEARN_REASONS, for the learner to count and log.
 *
 * Server only.
 */

/** What a learner proposes: a first look (add) or a new look in place of the one in use (replace). */
export interface LearnedChange {
  op: "add" | "replace";
  text: string;
}

export type ProposeResult = { ok: true; v: number; itemId: string } | { ok: false; reason: LearnReason; code?: string };

export interface ProposeOptions {
  /**
   * The version the learner judged the scope at (0 for none). If a person's Undo, Edit, Forget,
   * Keep or another learn moved the scope since, the proposal is refused (code moved).
   */
  basedOn: number;
  now?: Date;
  db?: FirestoreLike;
}

/** A look's words as kept, or why they can't be. */
export type LookText =
  | { ok: true; text: string }
  | { ok: false; reason: Extract<LearnReason, "trust" | "full" | "error">; code: TextRefusal | "empty" | "too_long" };

/**
 * The one check on a look's words, shared by the learner (here) and a person's Edit the words
 * (the person actions): one line of plain text, at most LOOP_RULES.lookChars characters, with no
 * link, email address, handle or phone number. A refused look is never cleaned and kept; Edit the
 * words shows LOOK_REFUSED_MESSAGE (src/lib/loops/textCheck.ts).
 */
export function checkLookText(text: unknown): LookText {
  const t = typeof text === "string" ? text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!t) return { ok: false, reason: "error", code: "empty" };
  if (t.length > LOOP_RULES.lookChars) return { ok: false, reason: "full", code: "too_long" };
  const refused = textRefusalOf(t);
  if (refused) return { ok: false, reason: "trust", code: refused };
  return { ok: true, text: t };
}

/**
 * A look's words as Forget remembers them (`forgotHash` on its version row): a hash of the words,
 * spaces and case aside, so the learner never adopts the same look again and the words are gone.
 */
export function lookHash(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex");
}

const isLearningScope = (scope: string): scope is ImageStyleScope => (IMAGE_STYLE_SCOPES as readonly string[]).includes(scope);

/** How a person gave the vote that makes an image evidence. */
const EVIDENCE_VIA: ReadonlySet<string> = new Set(["vote", "upload"]);

type Evidence = Pick<ImageAsset, "id" | "brandVote" | "brandVoteVia" | "brandVoteReason" | "firstVotedAt" | "brandVoteSetAt">;

/** The evidence rows, or why they can't be evidence: every id must be this brand's image, voted on or uploaded by a person. */
async function readEvidence(ctx: TenantContext, ids: readonly string[], db?: FirestoreLike): Promise<Evidence[] | { code: string }> {
  const unique = [...new Set(ids)];
  if (unique.length === 0 || unique.length !== ids.length || unique.length > EVIDENCE_IDS_MAX) return { code: "evidence_ids" };
  const repo = forTenant(ctx, db).imageAssets;
  // getById checks each row is this brand's: another brand's id reads as missing.
  const rows = await Promise.all(unique.map((id) => repo.getById(id)));
  for (const row of rows) {
    if (!row || !row.brandVote || !row.brandVoteVia || !EVIDENCE_VIA.has(row.brandVoteVia)) return { code: "evidence" };
  }
  return rows as Evidence[];
}

/** Where the look came from, as counts: liked, disliked, the newest vote and the thumbs down reasons. */
function evidenceCountsOf(rows: readonly Evidence[]): NonNullable<LearnedPatternVersion["evidenceCounts"]> {
  let newestAt: string | null = null;
  const downReasons: Record<string, number> = {};
  for (const r of rows) {
    const at = r.firstVotedAt ?? r.brandVoteSetAt ?? null;
    if (at && (!newestAt || at > newestAt)) newestAt = at;
    if (r.brandVote === "down" && r.brandVoteReason) downReasons[r.brandVoteReason] = (downReasons[r.brandVoteReason] ?? 0) + 1;
  }
  return {
    liked: rows.filter((r) => r.brandVote === "up").length,
    disliked: rows.filter((r) => r.brandVote === "down").length,
    newestAt,
    ...(Object.keys(downReasons).length > 0 ? { downReasons } : {}),
  };
}

const refuse = (reason: LearnReason, code?: string): ProposeResult => ({ ok: false, reason, ...(code ? { code } : {}) });

/**
 * Adopt a learned look for a scope as its next version, or say why not. Only a learner in
 * src/lib/loops/learners/ may call it.
 */
export async function proposeLearned(
  ctx: TenantContext,
  scope: string,
  change: LearnedChange,
  evidenceIds: readonly string[],
  opts: ProposeOptions,
): Promise<ProposeResult> {
  if (!isImageStyleVersionsOn()) return refuse("switch");
  if (!isLearningScope(scope)) return refuse("error", "scope");
  if (change.op !== "add" && change.op !== "replace") return refuse("error", "change");
  const words = checkLookText(change.text);
  if (!words.ok) return refuse(words.reason, words.code);

  let evidence: Evidence[] | { code: string };
  try {
    evidence = await readEvidence(ctx, evidenceIds, opts.db);
  } catch (err) {
    console.warn("[loops] reading a look's evidence failed", err instanceof Error ? err.message.slice(0, 200) : "error");
    return refuse("error", "evidence_read");
  }
  if (!Array.isArray(evidence)) return refuse("trust", evidence.code);
  const counts = evidenceCountsOf(evidence);
  const now = (opts.now ?? new Date()).toISOString();

  try {
    return await runLoopsTransaction(
      ctx,
      async (txn) => {
        const pointers = await readBrandPointersTx(txn, ctx, opts.db);
        // The seed writes version 1 of every scope that had a look before versions; learning waits for it.
        if (!pointers.seededAt) return refuse("error", "not_seeded");
        if (pointers.pause?.image_style) return refuse("paused");
        const current = pointers.scopes[scope];
        if (current?.setBy === "person") return refuse("off_by_person", "set_by_person");
        if ((current?.v ?? 0) !== opts.basedOn) return refuse("error", "moved");
        const v = (current?.v ?? 0) + 1;
        const itemId = `look${v}`;
        appendPatternVersionTx(
          txn,
          ctx,
          {
            channel: scope,
            version: v,
            directive: null,
            perform: [],
            avoid: [],
            judgeRationale: "",
            evidence: [],
            createdBy: "auto",
            createdAt: now,
            loop: scope.split(".")[0]!,
            setBy: "learned",
            items: [{ id: itemId, type: "rule", text: words.text, trust: "own_content", from: "votes" }],
            change: { op: change.op, itemId },
            evidenceIds: [...evidenceIds],
            evidenceCounts: counts,
          },
          opts.db,
        );
        writeBrandPointersTx(txn, ctx, { ...pointers, scopes: { ...pointers.scopes, [scope]: { v, setBy: "learned", adoptedAt: now } } }, opts.db);
        return { ok: true as const, v, itemId };
      },
      opts.db,
    );
  } catch (err) {
    // A second writer created the same version first (create() refuses it), or the commit failed.
    console.warn("[loops] adopting a learned look failed", err instanceof Error ? err.message.slice(0, 200) : "error");
    return refuse("error", "conflict");
  }
}
