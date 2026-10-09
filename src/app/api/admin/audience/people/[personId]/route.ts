import { NextResponse } from "next/server";
import { personViewAdmin } from "@/lib/audience/admin";
import { loadPersonRecord } from "@/lib/audience/personRecord";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Everything held about one product user, for their page. */
export async function GET(req: Request, { params }: { params: Promise<{ personId: string }> }) {
  const gate = await personViewAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const { personId } = await params;
  const found = await loadPersonRecord(gate.ctx, personId);
  return NextResponse.json(found, { status: found.found ? 200 : 404, headers: { "cache-control": "no-store" } });
}
