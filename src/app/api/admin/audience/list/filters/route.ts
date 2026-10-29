import { NextResponse } from "next/server";
import { oneViewAdmin } from "@/lib/audience/admin";
import { peopleFilters } from "@/lib/audience/peopleList";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Audience → People (AUDIENCE_ONE_VIEW_ENABLED): the groups the list can show, with how many are in each. */
export async function GET(req: Request) {
  const gate = await oneViewAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  return NextResponse.json(await peopleFilters(gate.ctx), { headers: { "cache-control": "no-store" } });
}
