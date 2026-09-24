import { z } from "zod";
import { ContentObjective, SequenceType, type ContentPlan } from "@/lib/types/contentPlan";
import { isChannel } from "@/lib/content/channels";
import { isContentMatrixTopic } from "@/lib/content/contentMatrix";

/**
 * A new content plan's intake — shared by the Create wizard's route and Vizzy's
 * `content_plan` canvas kind (nav v2 phase 4), so both make identical plans.
 */

/** Only http(s) hub URLs (substituted into copy as {{hub_url}}); reject javascript: etc. */
const HubUrl = z
  .string()
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL")
  .nullable()
  .optional();

export const IntakeSchema = z.object({
  name: z.string().min(1).max(200),
  strategy: z.object({
    objective: ContentObjective,
    hubUrl: HubUrl,
    subscriberCount: z.number().int().nonnegative().max(1_000_000_000).nullable().optional(),
    sequenceType: SequenceType.nullable().optional(),
  }),
  scope: z.object({
    topics: z.array(z.string().max(60)).max(26).default([]),
    spark: z.string().max(4000).default(""),
    industryLens: z.string().max(500).default(""),
  }),
  knowledge: z.object({
    groundingScope: z.enum(["global", "scoped"]).default("global"),
    proofAssets: z.array(z.string().max(4000)).max(10).default([]),
  }),
  topology: z.object({
    hubChannel: z.enum(["newsletter", "blog", "ebook"]).default("newsletter"),
    spokeChannels: z.array(z.string().max(40)).max(8).default([]),
  }),
});
export type Intake = z.infer<typeof IntakeSchema>;

export type NewPlanFields = Omit<ContentPlan, "id" | "tenantId" | "workspaceId" | "createdAt" | "updatedAt">;

/** The new plan's fields from a validated intake. The graph is empty: the architect builds it next. */
export function planFromIntake(input: Intake): NewPlanFields {
  const topics = [...new Set(input.scope.topics.filter(isContentMatrixTopic))];
  // Spokes must be real, non-hub social channels (never the hub channel or "standalone").
  const spokeChannels = [
    ...new Set(
      input.topology.spokeChannels.filter((c) => isChannel(c) && c !== input.topology.hubChannel && c !== "standalone"),
    ),
  ];
  return {
    name: input.name,
    status: "draft",
    strategy: {
      objective: input.strategy.objective,
      hubUrl: input.strategy.hubUrl ?? null,
      subscriberCount: input.strategy.subscriberCount ?? null,
      sequenceType: input.strategy.objective === "email_sequence" ? (input.strategy.sequenceType ?? "welcome") : null,
    },
    scope: { topics, spark: input.scope.spark, industryLens: input.scope.industryLens },
    knowledge: {
      groundingScope: input.knowledge.groundingScope,
      proofAssets: input.knowledge.proofAssets,
    },
    topology: { hubChannel: input.topology.hubChannel, spokeChannels },
    graph: { nodes: [], edges: [] },
  };
}
