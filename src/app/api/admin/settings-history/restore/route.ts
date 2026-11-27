import { NextResponse } from "next/server";
import { z } from "zod";
import { historyAdmin } from "@/lib/settings/admin";
import { restoreHistoryVersion } from "@/lib/settings/restore";
import { parseHistorySubject, shownKinds } from "@/lib/settings/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

const Body = z
  .object({
    subject: z.string().max(80),
    rev: z.number().int().min(0),
    /** The base the preview showed: a rev, or a journey's updatedAt. */
    base: z.union([z.number().int().min(0), z.string().min(1).max(40)]),
  })
  .strict();

/**
 * Restore a version as a new one (a journey into its draft only). Admins only. A field list,
 * draft or catalog saved since the preview answers 409, and nothing is written.
 */
export async function POST(req: Request) {
  const gate = await historyAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  const subject = parsed.success ? parseHistorySubject(parsed.data.subject) : null;
  if (!parsed.success || !subject) return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: noStore });
  if (!shownKinds().includes(subject.kind)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
  const r = await restoreHistoryVersion(gate.ctx, { subject, rev: parsed.data.rev, base: parsed.data.base });
  return NextResponse.json(r.body, { status: r.status, headers: noStore });
}
