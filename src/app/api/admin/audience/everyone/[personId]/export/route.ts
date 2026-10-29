import { NextResponse } from "next/server";
import { oneViewAdmin } from "@/lib/audience/admin";
import { exportWholePerson } from "@/lib/audience/personExport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Download everything held about one whole person (a data subject access request). Admins only. */
export async function GET(req: Request, { params }: { params: Promise<{ personId: string }> }) {
  const gate = await oneViewAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { personId } = await params;
  const r = await exportWholePerson(gate.ctx, personId);
  if (!r.found) return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  // The file is named by our id for them, never by their name or address.
  const name = personId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "person";
  return new Response(JSON.stringify(r.document, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${name}.person.json"`,
      "cache-control": "no-store",
    },
  });
}
