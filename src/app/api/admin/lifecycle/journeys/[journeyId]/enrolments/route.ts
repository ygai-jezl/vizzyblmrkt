import { lifecycleAdmin, readJson, respond } from "@/lib/connect/admin";
import { enrolByHand, listEnrolments } from "@/lib/lifecycle/adminApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ journeyId: string }> };

/** Who is in the journey, newest first. */
export async function GET(req: Request, { params }: Params) {
  const gate = await lifecycleAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? "100") || 100;
  return respond(await listEnrolments(gate.ctx, (await params).journeyId, { limit }));
}

/** Enrol an existing product user by hand ({ userId } = the product's own id). */
export async function POST(req: Request, { params }: Params) {
  const gate = await lifecycleAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  return respond(await enrolByHand(gate.ctx, (await params).journeyId, await readJson(req)));
}
