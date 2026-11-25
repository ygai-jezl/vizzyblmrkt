import { NextResponse } from "next/server";
import { z } from "zod";
import { invalidInput, limitPerUser, onboardingAdmin } from "@/lib/onboarding/api";
import { setBusinessProfile } from "@/lib/tenant/control";
import { ProfileAnswersInputSchema } from "@/lib/types/businessProfile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Each pick saves at once, so a few a minute is normal; this only stops a loop hammering the brand's record. */
const PROFILE_LIMIT = { prefix: "onboarding_profile", burstLimit: 30, hourlyLimit: 300 };

const Body = z
  .object({
    answers: ProfileAnswersInputSchema.optional(),
    status: z.enum(["done", "skipped"]).optional(),
    /** Where the change came from: a pick on the questions, a chip in Settings, or Skip on the welcome. */
    via: z.enum(["questions", "settings", "welcome"]),
  })
  .strict()
  .refine((b) => (b.answers !== undefined && Object.keys(b.answers).length > 0) || b.status !== undefined, {
    message: "send an answer or a status",
  });

/**
 * The brand's profile (ONBOARDING_ENABLED; admins): an answer picked on the 4 quick questions or
 * in Settings, "That's all four" (done) or Skip for now (skipped). A skip only replaces started,
 * and done never goes back. The brand is the session's, never the body's.
 */
export async function PUT(req: Request) {
  const g = await onboardingAdmin(req, { need: "onboarding" });
  if (!g.ok) return g.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return invalidInput(parsed.error.issues);
  const limited = await limitPerUser(g.ctx, PROFILE_LIMIT);
  if (limited) return limited;

  const { answers, status, via } = parsed.data;
  const result = await setBusinessProfile(g.ctx.tenantId, {
    ...(answers ? { answers } : {}),
    ...(status ? { status } : {}),
    // Skip on the welcome gives no answers, so it says nothing about how they came.
    ...(via === "welcome" ? {} : { via }),
  });
  if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ profile: result.after }, { headers: { "cache-control": "no-store" } });
}
