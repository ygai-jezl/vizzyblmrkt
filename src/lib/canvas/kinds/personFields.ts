import { z } from "zod";
import { isRateLimited } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { isVizzyFieldsEnabled } from "@/lib/audience/peopleFlags";
import { personHref } from "@/lib/audience/paths";
import { SUGGESTION_MAX_FIELDS, suggestFieldChanges, type SuggestError } from "@/lib/audience/fieldSuggestions";
import type { CanvasAuthorArgs, CanvasAuthorOutcome, CanvasKind } from "../types";

/**
 * The `person_fields` canvas kind (AUDIENCE_VIZZY_FIELDS_ENABLED): Vizzy suggests changes to one
 * person's fields from the chat, of the seven types it may read. Always a suggestion: an admin
 * confirms or dismisses it on the person's page or from Review, and only then does anything
 * change. The person is named by our id for them (`ct_`), found only in the token's brand.
 *
 * Admins only, like changing a value on the page: a token without a role fails closed.
 */

const SuggestInput = z.object({
  scope: z.object({ personId: z.string().min(1).max(128) }),
  /** Field id to the suggested value; null clears it. */
  changes: z.record(z.string().max(64), z.unknown()),
  /** Why, in a sentence: what Vizzy saw. Shown on the person's page. */
  why: z.string().max(1000).nullish(),
});

const AUTHOR_LIMIT = { prefix: "person_fields_author", burstLimit: 10, hourlyLimit: 60 };

const STATUS: Record<SuggestError, number> = {
  person_not_found: 404,
  unknown_field: 400,
  archived_field: 400,
  field_not_allowed: 400,
  invalid_value: 400,
  too_many_fields: 400,
  no_change: 409,
  already_decided: 409,
};

export async function authorPersonFields({ ctx, input }: CanvasAuthorArgs, deps: { db?: FirestoreLike; nowMs?: number; textFields?: boolean } = {}): Promise<CanvasAuthorOutcome> {
  if (!isVizzyFieldsEnabled()) return { ok: false, status: 503, error: "unavailable" };
  // Changing a value is admin-only on the person's page, so suggesting one through Vizzy is too.
  if (ctx.role !== "admin") return { ok: false, status: 403, error: "forbidden" };
  const req = SuggestInput.safeParse(input);
  if (!req.success) {
    return { ok: false, status: 400, error: "invalid_input", issues: req.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  if (Object.keys(req.data.changes).length === 0) return { ok: false, status: 400, error: "invalid_input", issues: ["changes: suggest at least one field"] };
  if (Object.keys(req.data.changes).length > SUGGESTION_MAX_FIELDS) return { ok: false, status: 400, error: "too_many_fields" };
  if (await isRateLimited(`tenant:${ctx.tenantId}`, AUTHOR_LIMIT, { db: deps.db })) return { ok: false, status: 429, error: "rate_limited" };

  const r = await suggestFieldChanges(ctx, { personId: req.data.scope.personId, changes: req.data.changes, why: req.data.why ?? null }, deps);
  if (!r.ok) return { ok: false, status: STATUS[r.error], error: r.error, ...(r.fieldId ? { issues: [r.fieldId] } : {}) };

  const url = `${personHref(r.action.personId!)}#vizzy`;
  const fields = r.fields;
  return {
    ok: true,
    id: r.action.id,
    status: "suggested",
    url,
    summary:
      r.outcome === "open"
        ? "That suggestion is already waiting on their page and in Review. Nothing changes until someone on your team confirms it."
        : `Saved as a suggestion on their page and in Review${r.superseded ? ", in place of the one that was waiting" : ""}. Nothing changes until someone on your team confirms it.`,
    warnings: [],
    card: {
      kind: "person_fields",
      id: r.action.id,
      title: "Field changes for this person",
      url,
      stats: [{ label: fields === 1 ? "field" : "fields", value: fields }],
      warnings: 0,
      note: "Suggested: nothing changes until someone confirms it on their page.",
      cta: "Open their page",
    },
  };
}

export const personFieldsCanvasKind: CanvasKind = {
  kind: "person_fields",
  label: "suggested field changes for one person",
  authorDraft: (args) => authorPersonFields(args),
};
