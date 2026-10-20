import { z } from "zod";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { isRateLimited } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { BRAND_NOTE_KIND_LABEL, BRAND_NOTE_KINDS, BRAND_NOTE_LIMITS, BrandNoteKind } from "@/lib/types/brandNote";
import { isBrandNotesChatEnabled, isBrandNotesQuestionsEnabled } from "./flags";
import { suggestKind } from "./prompts";
import { createNote, listNotes, nearestNotes, summariseNotes, type NotesDeps } from "./store";

/**
 * What Vizzy may do with What we've seen (BRAND_NOTES_CHAT_ENABLED): read the brand's notes (a
 * summary, the newest, or those nearest some words) and file new ones as SUGGESTIONS in the
 * person's own words. Nothing it files is used by an article until an admin keeps it on Brand ›
 * What we've seen. With BRAND_NOTES_QUESTIONS_ENABLED it also reads the open questions: what
 * articles asked the team that nobody has answered yet. Auth is the signed canvas capability
 * token (the tenant comes from it).
 */

export type ApiResult = { status: number; body: unknown };

const NOTE =
  "Vizzy only files suggested notes, in the person's own words: an article uses a note only after an admin keeps it on Brand › What we've seen. " +
  "Never invent experience or figures.";
const LINK = "/admin/brand-kit/notes";
const OPEN_NOTE =
  "Open questions: articles asked the team these and nobody has answered yet. Ask the person one; they answer it in the article's What we've seen box or on Brand › What we've seen, and every article that asked it can use the answer.";
const MAX_OPEN = 5;
/** Suggestions from chat are bounded per brand. */
const CHAT_LIMIT = { prefix: "brand_notes_chat", burstLimit: 5, hourlyLimit: 40 };
const MAX_PER_CALL = 5;

export function brandNotesAgentGate(req: Request): { ok: true; ctx: TenantContext } | { ok: false; result: ApiResult } {
  if (!isBrandNotesChatEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  return { ok: true, ctx: tenantContextFromCanvasToken(verified.claims) };
}

const brief = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 400);

export async function agentReadNotes(ctx: TenantContext, opts: { find?: string | null } = {}, deps: NotesDeps = {}): Promise<ApiResult> {
  const notes = await listNotes(ctx, deps);
  const summary = summariseNotes(notes);
  const kinds = BRAND_NOTE_KINDS.map((k) => ({ kind: k, label: BRAND_NOTE_KIND_LABEL[k].many, kept: summary.kinds[k] }));
  const find = opts.find?.trim().slice(0, 300);
  const shown = find
    ? (await nearestNotes(ctx, find, { limit: 8 }, deps)).map((n) => n.note)
    : notes.filter((n) => n.status === "kept").slice(0, 10);
  const open = isBrandNotesQuestionsEnabled() ? notes.filter((n) => n.status === "asked") : [];
  return {
    status: 200,
    body: {
      total: summary.total,
      kept: summary.kept,
      waiting: summary.suggested,
      kinds,
      fewest: kinds.filter((k) => k.kept === Math.min(...kinds.map((x) => x.kept))).map((k) => k.kind),
      notes: shown.map((n) => ({ kind: n.kind, text: brief(n.text), usedIn: n.usedBy?.length ?? 0, ...(n.status === "suggested" ? { waiting: true } : {}) })),
      ...(find ? { find } : {}),
      ...(open.length
        ? {
            open: {
              count: open.length,
              questions: open.slice(0, MAX_OPEN).map((n) => ({ question: brief(n.question ?? ""), askedFor: (n.askedFor ?? []).map((a) => a.title).slice(0, 3) })),
              note: OPEN_NOTE,
            },
          }
        : {}),
      link: LINK,
      note: NOTE,
    },
  };
}

const SuggestBody = z.object({
  notes: z
    .array(
      z.object({
        text: z.string().trim().min(BRAND_NOTE_LIMITS.MIN_TEXT).max(BRAND_NOTE_LIMITS.MAX_TEXT),
        kind: BrandNoteKind.optional(),
      }),
    )
    .min(1)
    .max(MAX_PER_CALL),
});

export async function agentSuggestNotes(
  ctx: TenantContext,
  body: unknown,
  deps: NotesDeps & { limited?: (key: string) => Promise<boolean> } = {},
): Promise<ApiResult> {
  const parsed = SuggestBody.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid_input", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join(".")}: ${i.message}`) } };
  }
  const limited = deps.limited ?? ((key: string) => isRateLimited(key, CHAT_LIMIT));
  if (await limited(`tenant:${ctx.tenantId}`)) return { status: 429, body: { error: "rate_limited" } };
  let filed = 0;
  for (const n of parsed.data.notes) {
    const r = await createNote(
      ctx,
      { text: n.text, kind: n.kind ?? suggestKind(n.text), subjectIds: [], canName: false },
      { source: "chat", status: "suggested" },
      deps,
    );
    if (!r.ok) {
      if (!filed) return { status: r.status, body: { error: r.error } };
      break;
    }
    filed += 1;
  }
  return {
    status: 200,
    body: {
      filed,
      link: LINK,
      message: `Filed ${filed === 1 ? "1 suggested note" : `${filed} suggested notes`} on Brand › What we've seen. An admin keeps the ones that are right, and articles use only those.`,
    },
  };
}
