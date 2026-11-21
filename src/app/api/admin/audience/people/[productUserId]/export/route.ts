import { NextResponse } from "next/server";
import { personViewAdmin } from "@/lib/audience/admin";
import { exportPerson } from "@/lib/audience/personExport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Download everything held about one product user (a data subject access request). Admins only. */
export async function GET(req: Request, { params }: { params: Promise<{ productUserId: string }> }) {
  const gate = await personViewAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const { productUserId } = await params;
  const r = await exportPerson(gate.ctx, productUserId);
  if (!r.found) return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  // The file is named by our id for them, never by their name or address.
  const name = productUserId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "person";
  return new Response(JSON.stringify(r.document, null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${name}.person.json"`,
      "cache-control": "no-store",
    },
  });
}
