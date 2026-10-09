import { NextResponse } from "next/server";
import { z } from "zod";
import { personViewAdmin } from "@/lib/audience/admin";
import { isPersonPlansEnabled } from "@/lib/audience/flags";
import { approvePlan, dropPlan, getPersonPlan, savePlanDraft, type PlanResult } from "@/lib/audience/personPlans";
import { readJson } from "@/lib/connect/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ personId: string }> };

const off = () => NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });

function respond<T>(r: PlanResult<T>, body: (value: T) => unknown): Response {
  return r.ok
    ? NextResponse.json(body(r.value), { headers: { "cache-control": "no-store" } })
    : NextResponse.json({ error: r.error, ...(r.detail ? { detail: r.detail } : {}) }, { status: r.status });
}

/** One person's plan (LIFECYCLE_PERSON_PLANS): the draft waiting, and the one in force. */
export async function GET(req: Request, { params }: Params) {
  if (!isPersonPlansEnabled()) return off();
  const gate = await personViewAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const plan = await getPersonPlan(gate.ctx, (await params).personId);
  return NextResponse.json({ plan }, { headers: { "cache-control": "no-store" } });
}

/** Staff write or edit the draft. It still needs approving. */
export async function PUT(req: Request, { params }: Params) {
  if (!isPersonPlansEnabled()) return off();
  const gate = await personViewAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  return respond(await savePlanDraft(gate.ctx, (await params).personId, await readJson(req), { by: "human" }), (plan) => ({ plan }));
}

const Action = z.object({ action: z.enum(["approve", "discard_draft", "end_plan"]) });

/** Approve the draft, throw it away, or end the plan in force. Admins only: this is the human step. */
export async function POST(req: Request, { params }: Params) {
  if (!isPersonPlansEnabled()) return off();
  const gate = await personViewAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  const parsed = Action.safeParse(await readJson(req));
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  const { personId } = await params;
  const r =
    parsed.data.action === "approve"
      ? await approvePlan(gate.ctx, personId)
      : await dropPlan(gate.ctx, personId, parsed.data.action === "discard_draft" ? "draft" : "approved");
  return respond(r, (plan) => ({ plan }));
}
