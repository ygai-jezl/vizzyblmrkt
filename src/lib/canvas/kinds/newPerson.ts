import { z } from "zod";
import { isRateLimited } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { isVizzyAddPersonEnabled } from "@/lib/audience/peopleFlags";
import { personHref } from "@/lib/audience/paths";
import { draftHref, draftNewPerson } from "@/lib/audience/personDrafts";
import type { CanvasAuthorArgs, CanvasAuthorOutcome, CanvasKind } from "../types";

/**
 * The `new_person` canvas kind (AUDIENCE_VIZZY_ADD_PERSON_ENABLED): asked to add someone, Vizzy
 * fills in the New person form from what the user typed. Always a draft: an admin opens it from
 * the card or Review, checks it, records how they agreed themselves, and adds them. Vizzy can never
 * record consent: the request has no place for it, and one that tries is refused.
 *
 * Admins only, like New person: a token without a role fails closed. The card's link holds the
 * draft's id only, never what was typed.
 */

const NewPersonInput = z
  .object({
    kind: z.literal("new_person"),
    action: z.literal("save_draft"),
    brief: z.string().max(4000).optional(),
    email: z.string().max(320).nullish(),
    phone: z.string().max(40).nullish(),
    firstName: z.string().max(200).nullish(),
    lastName: z.string().max(200).nullish(),
    /** Field name (or id) to its value. */
    fields: z.record(z.string().max(100), z.unknown()).nullish(),
  })
  .strict();

const AUTHOR_LIMIT = { prefix: "new_person_author", burstLimit: 10, hourlyLimit: 60 };

export async function authorNewPerson({ ctx, input, made }: CanvasAuthorArgs, deps: { db?: FirestoreLike; nowMs?: number } = {}): Promise<CanvasAuthorOutcome> {
  if (!isVizzyAddPersonEnabled()) return { ok: false, status: 503, error: "unavailable" };
  // Adding people is admin-only, so filling in the form through Vizzy is too.
  if (ctx.role !== "admin") return { ok: false, status: 403, error: "forbidden" };
  if ("agreed" in input || "consent" in input) return { ok: false, status: 400, error: "consent_not_allowed" };
  const req = NewPersonInput.safeParse(input);
  if (!req.success) {
    return { ok: false, status: 400, error: "invalid_input", issues: req.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  if (await isRateLimited(`tenant:${ctx.tenantId}`, AUTHOR_LIMIT, { db: deps.db })) return { ok: false, status: 429, error: "rate_limited" };

  const r = await draftNewPerson(ctx, req.data, { ...deps, made });
  // Every refusal is the request's to fix, a draft too big to save (`too_large`) included.
  if (!r.ok) return { ok: false, status: 400, error: r.error };
  if (r.outcome === "existing") {
    const url = personHref(r.personId);
    return {
      ok: true,
      id: r.personId,
      status: "existing",
      url,
      summary: "They're already in People, so nothing was drafted. Their page is linked.",
      warnings: [],
      card: { kind: "new_person", id: r.personId, title: "Already in People", url, stats: [], warnings: 0, note: "Nothing was added.", cta: "Open their page" },
    };
  }
  const url = draftHref(r.action.id);
  return {
    ok: true,
    id: r.action.id,
    status: "draft",
    url,
    summary:
      r.outcome === "open"
        ? "That form is already filled in and waiting. Nobody is added until an admin opens it, says how they agreed, and confirms."
        : "Filled in the New person form. Nobody is added until an admin opens it, says how they agreed, and confirms. It is kept for 7 days.",
    warnings: r.warnings,
    card: {
      kind: "new_person",
      id: r.action.id,
      title: "New person, filled in",
      url,
      stats: [{ label: r.fields === 1 ? "field" : "fields", value: r.fields }],
      warnings: r.warnings.length,
      note: "Nobody is added until you confirm it and say how they agreed.",
      cta: "Open the form",
    },
  };
}

export const newPersonCanvasKind: CanvasKind<"new_person"> = {
  kind: "new_person",
  label: "New person form, filled in",
  authorDraft: (args) => authorNewPerson(args),
};
