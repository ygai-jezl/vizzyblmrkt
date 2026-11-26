import { NextResponse } from "next/server";
import { historyAdmin } from "@/lib/settings/admin";
import { previewRestore } from "@/lib/settings/restorePlan";
import { parseHistorySubject, shownKinds } from "@/lib/settings/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * What restoring a version would do (`?subject=&rev=`): what comes back, what is archived, what
 * changes back and what a restore never undoes, with the base a restore sends back. Admins only,
 * since only they restore.
 */
export async function GET(req: Request) {
  const gate = await historyAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const url = new URL(req.url);
  const subject = parseHistorySubject(url.searchParams.get("subject"));
  const rawRev = url.searchParams.get("rev");
  const rev = rawRev ? Number(rawRev) : Number.NaN;
  if (!subject || !Number.isInteger(rev) || rev < 0) return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: noStore });
  if (!shownKinds().includes(subject.kind)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
  const r = await previewRestore(gate.ctx, subject, rev);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status, headers: noStore });
  return NextResponse.json({ preview: r.preview }, { headers: noStore });
}
