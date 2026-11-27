import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { isMemoryBankConfigured, learnFromEdits } from "@/lib/agents/memoryBank";
import { readRequestTextCapped } from "@/lib/http/readBody";
import { isRateLimited } from "@/lib/tenant";
import type { RateLimitConfig } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import { isEditModeVizzyLearningEnabled } from "@/lib/content/editor/flags";
import type { LearningAccess } from "@/lib/content/editor/learningChoice";
import { LearnRequestSchema, LearnSkippedSchema, type LearnEntry } from "@/lib/content/editor/vizzyLearning";
import {
  isLearningOff,
  learningAccess,
  learningDisabled,
  learningNotConfigured,
  learningRefused,
} from "@/lib/content/editor/vizzyLearningAccess";
import { errorCode, learnLogEntry, writeLearnLog, type LearnResult } from "@/lib/loops/learnLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per person: one call when Edit mode closes, so a few a minute is plenty. */
const LIMIT: RateLimitConfig = { prefix: "edit_vizzy_learn", burstLimit: 6, hourlyLimit: 60 };

type LearnBody = { entries: LearnEntry[] } | { skipped: number };

async function readBody(req: Request): Promise<LearnBody | null> {
  const raw = await readRequestTextCapped(req, 64_000);
  let json: unknown = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  const entries = LearnRequestSchema.safeParse(json);
  if (entries.success) return entries.data;
  const skipped = LearnSkippedSchema.safeParse(json);
  return skipped.success ? skipped.data : null;
}

/** One loop_learn line for this close, with the brand's facts (never the changes themselves). */
async function logOutcome(ctx: TenantContext, body: LearnBody, result: LearnResult, access?: LearningAccess) {
  try {
    const facts = (access ?? (await learningAccess(ctx, "edit_mode"))).facts;
    const count = "entries" in body ? body.entries.length : body.skipped;
    // The line, and with LOOPS_ENABLED its count in the brand's week.
    await writeLearnLog(learnLogEntry("edit_mode", ctx.tenantId, facts, result, count));
  } catch {
    // A log line is never worth failing the close over.
  }
}

/**
 * What the person kept and undid in one Edit mode visit, for Memory Bank to learn from. Only the
 * changed words are sent (see vizzyLearning.ts). Nothing is sent when they've switched learning
 * off. Memory Bank does the work in the background. A visit Vizzy can't learn from sends only its
 * count. Every close a signed in person sends logs one loop_learn line, learned or why it skipped
 * (src/lib/loops/learnLog.ts, ADR-0021); the answers are as before.
 */
export async function POST(req: Request) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const body = await readBody(req);
  if (!isEditModeVizzyLearningEnabled()) {
    // Answered as before; the session is read only to log the close.
    if (body) {
      const ctx = await getAdminContext().catch(() => null);
      if (ctx?.userId) await logOutcome(ctx, body, { outcome: "skipped", reason: "switch" });
    }
    return learningDisabled();
  }
  const ctx = await getAdminContext();
  if (!ctx?.userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const access = await learningAccess(ctx, "edit_mode");
  if (!isMemoryBankConfigured()) {
    if (body) await logOutcome(ctx, body, { outcome: "skipped", reason: "not_configured" }, access);
    return learningNotConfigured();
  }
  if (!access.ok) {
    if (body) await logOutcome(ctx, body, { outcome: "skipped", reason: access.reason }, access);
    return learningRefused(access.reason);
  }
  if (!body) return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  let off: boolean;
  try {
    off = await isLearningOff(ctx);
  } catch (err) {
    // The person's choice couldn't be read, so nothing is learned; logged as the post path logs it.
    await logOutcome(ctx, body, { outcome: "skipped", reason: "error", code: errorCode(err) }, access);
    return NextResponse.json({ error: "memory_unavailable" }, { status: 502 });
  }
  if (off) {
    await logOutcome(ctx, body, { outcome: "skipped", reason: "off_by_person" }, access);
    return NextResponse.json({ learned: false, reason: "learning_off" });
  }
  if (!("entries" in body)) {
    // Learning was on but the page couldn't offer it, most often because the list didn't load.
    await logOutcome(ctx, body, { outcome: "skipped", reason: "error", code: "not_loaded" }, access);
    return NextResponse.json({ learned: false, reason: "not_loaded" });
  }
  if (await isRateLimited(`user:${ctx.tenantId}:${ctx.userId}`, LIMIT)) {
    await logOutcome(ctx, body, { outcome: "skipped", reason: "budget" }, access);
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  try {
    await learnFromEdits(ctx, body.entries);
  } catch (err) {
    console.warn("[edit-vizzy] learn failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
    await logOutcome(ctx, body, { outcome: "skipped", reason: "error", code: errorCode(err) }, access);
    return NextResponse.json({ error: "memory_unavailable" }, { status: 502 });
  }
  await logOutcome(ctx, body, { outcome: "learned", via: access.via }, access);
  return NextResponse.json({ learned: true }, { status: 202 });
}
