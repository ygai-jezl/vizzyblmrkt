import { NextResponse } from "next/server";
import { z } from "zod";
import { personViewAdmin } from "@/lib/audience/admin";
import { loadPersonSummaries, SUMMARY_LIMIT } from "@/lib/audience/personRecord";
import { readJson } from "@/lib/connect/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ ids: z.array(z.string().min(1).max(128)).min(1).max(SUMMARY_LIMIT) });

/** The journey, email counts and reach of the people on screen (a POST only because the ids don't fit a URL). */
export async function POST(req: Request) {
  const gate = await personViewAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const summaries = await loadPersonSummaries(gate.ctx, parsed.data.ids);
  return NextResponse.json({ summaries }, { headers: { "cache-control": "no-store" } });
}
