import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import type { AdminGate } from "@/lib/connect/admin";
import type { TenantContext } from "@/lib/tenant/types";
import { setTenantNotesRest } from "@/lib/tenant/control";
import { BRAND_NOTE_LIMITS, BrandNoteInputSchema, BrandNotePatchSchema, NotesRestInputSchema } from "@/lib/types/brandNote";
import { isBrandNotesEnabled, isBrandNotesQuestionsEnabled, isBrandNotesRestEnabled } from "./flags";
import { answerQuestion, createNote, listNotes, removeNote, summariseNotes, updateNote, type NotesDeps, type NotesResult } from "./store";

/**
 * The APIs behind Brand › What we've seen: origin, flag, sign-in and (to change anything)
 * admin, in that order, as the brand map's. Members can read the notes; admins add, change and
 * remove them.
 */

async function gate(req: Request, admin: boolean): Promise<AdminGate> {
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  if (!isBrandNotesEnabled()) return { ok: false, response: NextResponse.json({ error: "brand_notes_disabled" }, { status: 503 }) };
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (admin && ctx.role !== "admin") return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { ok: true, ctx };
}

export const notesAdmin = (req: Request) => gate(req, true);
export const notesReader = (req: Request) => gate(req, false);

function respond<T>(r: NotesResult<T>, ok: (value: T) => unknown, status = 200): Response {
  return r.ok ? NextResponse.json(ok(r.value), { status }) : NextResponse.json({ error: r.error }, { status: r.status });
}

function invalid(issues: { path: PropertyKey[]; message: string }[]): Response {
  return NextResponse.json(
    { error: "invalid_input", issues: issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "note"}: ${i.message}`) },
    { status: 400 },
  );
}

export async function listFromRequest(ctx: TenantContext, deps: NotesDeps = {}): Promise<Response> {
  const notes = await listNotes(ctx, deps);
  return NextResponse.json({ notes, summary: summariseNotes(notes) }, { headers: { "cache-control": "no-store" } });
}

/** Where a note added on the page came from: typed there, or ticked after pasting a call or document. */
const PageSource = z.enum(["typed", "paste"]).catch("typed");

export async function createFromRequest(ctx: TenantContext, body: unknown, deps: NotesDeps = {}): Promise<Response> {
  const parsed = BrandNoteInputSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error.issues);
  const source = PageSource.parse((body as { source?: unknown } | null)?.source ?? "typed");
  return respond(await createNote(ctx, parsed.data, { source }, deps), (note) => ({ note }), 201);
}

export async function updateFromRequest(ctx: TenantContext, id: string, body: unknown, deps: NotesDeps = {}): Promise<Response> {
  const parsed = BrandNotePatchSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error.issues);
  return respond(await updateNote(ctx, id, parsed.data, deps), (note) => ({ note }));
}

export async function removeFromRequest(ctx: TenantContext, id: string, deps: NotesDeps = {}): Promise<Response> {
  return respond(await removeNote(ctx, id, deps), () => ({ ok: true }));
}

const AnswerBody = z.object({ text: z.string().max(BRAND_NOTE_LIMITS.MAX_TEXT), done: z.boolean().default(false) });

/** Answer an open question on the page, saved as it is typed (BRAND_NOTES_QUESTIONS_ENABLED; admins). */
export async function answerFromRequest(ctx: TenantContext, id: string, body: unknown, deps: NotesDeps = {}): Promise<Response> {
  if (!isBrandNotesQuestionsEnabled()) return NextResponse.json({ error: "brand_notes_questions_disabled" }, { status: 503 });
  const parsed = AnswerBody.safeParse(body);
  if (!parsed.success) return invalid(parsed.error.issues);
  return respond(await answerQuestion(ctx, id, parsed.data.text, { done: parsed.data.done }, deps), (note) => ({ note }));
}

/** How often the brand's notes go into articles by themselves (BRAND_NOTES_REST_ENABLED; admins). */
export async function restFromRequest(ctx: TenantContext, body: unknown, deps: NotesDeps = {}): Promise<Response> {
  if (!isBrandNotesRestEnabled()) return NextResponse.json({ error: "brand_notes_rest_disabled" }, { status: 503 });
  const parsed = NotesRestInputSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error.issues);
  return NextResponse.json({ rest: await setTenantNotesRest(ctx.tenantId, parsed.data, deps.db) });
}
