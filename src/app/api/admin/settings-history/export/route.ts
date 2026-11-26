import { NextResponse } from "next/server";
import { historyAdmin } from "@/lib/settings/admin";
import { exportFileName, exportHistoryVersion } from "@/lib/settings/restore";
import { parseHistorySubject, shownKinds } from "@/lib/settings/sources";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Download one version as JSON (`?subject=&rev=`, or `rev=draft` for a journey's draft). Anyone on
 * the team exports. It holds settings only, never a person's values.
 */
export async function GET(req: Request) {
  const gate = await historyAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const url = new URL(req.url);
  const subject = parseHistorySubject(url.searchParams.get("subject"));
  const rawRev = url.searchParams.get("rev");
  const rev = rawRev === "draft" ? "draft" : rawRev ? Number(rawRev) : Number.NaN;
  if (!subject || (rev !== "draft" && (!Number.isInteger(rev) || rev < 0))) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  if (!shownKinds().includes(subject.kind)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  const r = await exportHistoryVersion(gate.ctx, { subject, rev });
  if (r.status !== 200) return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
  return new NextResponse(JSON.stringify(r.body, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFileName(subject, rev)}"`,
      "cache-control": "no-store",
    },
  });
}
