import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { forTenant } from "@/lib/tenant";
import { createContentPlan, listContentPlans } from "@/lib/tenant/workspaceContent";
import { ContentObjective } from "@/lib/types/contentPlan";
import { isChannel } from "@/lib/content/channels";
import { isContentMatrixTopic } from "@/lib/content/contentMatrix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only https(s) hub URLs (substituted into copy as {{hub_url}}); reject javascript: etc. */
const HubUrl = z
  .string()
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL")
  .nullable()
  .optional();

const IntakeSchema = z.object({
  name: z.string().min(1).max(200),
  strategy: z.object({
    objective: ContentObjective,
    hubUrl: HubUrl,
    subscriberCount: z.number().int().nonnegative().max(1_000_000_000).nullable().optional(),
  }),
  scope: z.object({
    topics: z.array(z.string().max(60)).max(26).default([]),
    spark: z.string().max(4000).default(""),
  }),
  knowledge: z.object({
    groundingScope: z.enum(["global", "scoped"]).default("global"),
    proofAssets: z.array(z.string().max(4000)).max(10).default([]),
  }),
  topology: z.object({
    hubChannel: z.enum(["newsletter", "blog"]).default("newsletter"),
    spokeChannels: z.array(z.string().max(40)).max(8).default([]),
  }),
});

/** Create a ContentPlan from intake (graph empty; the Architect builds it next). */
export async function POST(req: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = IntakeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues.map((i) => i.path.join(".")) },
      { status: 400 },
    );
  }
  const input = parsed.data;
  const topics = [...new Set(input.scope.topics.filter(isContentMatrixTopic))];
  // Spokes must be real, non-hub social channels (never the hub channel or "standalone").
  const spokeChannels = [
    ...new Set(
      input.topology.spokeChannels.filter(
        (c) => isChannel(c) && c !== input.topology.hubChannel && c !== "standalone",
      ),
    ),
  ];

  const plan = await createContentPlan(ctx, workspaceId, {
    name: input.name,
    status: "draft",
    strategy: {
      objective: input.strategy.objective,
      hubUrl: input.strategy.hubUrl ?? null,
      subscriberCount: input.strategy.subscriberCount ?? null,
    },
    scope: { topics, spark: input.scope.spark },
    knowledge: {
      groundingScope: input.knowledge.groundingScope,
      proofAssets: input.knowledge.proofAssets,
    },
    topology: { hubChannel: input.topology.hubChannel, spokeChannels },
    graph: { nodes: [], edges: [] },
  });
  return NextResponse.json({ plan });
}

/** List the workspace's content plans (newest first). */
export async function GET(req: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  const blocked = sameOriginGuard(req);
  if (blocked) return blocked;
  const ctx = await getAdminContext();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { workspaceId } = await params;
  const ws = await forTenant(ctx).workspaces.getById(workspaceId);
  if (!ws) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const plans = await listContentPlans(ctx, workspaceId);
  return NextResponse.json({ plans });
}
