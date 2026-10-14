import { ContentPlanSchema, type ContentNode, type ContentPlan } from "@/lib/types/contentPlan";
import { SAMPLE_ARTICLE, SAMPLE_BRIEF } from "./sampleArticle";

/** A made-up blog plan for tests: one hub written from the sample brief. */
export const sampleHub = (over: Partial<ContentNode> = {}): ContentNode =>
  ({
    id: "hub",
    type: "hub",
    channel: "blog",
    role: "Hub",
    position: { x: 0, y: 0 },
    brief: "",
    body: SAMPLE_ARTICLE,
    placeholderValues: {},
    status: "generated",
    warnings: [],
    subjectVariants: [],
    ...over,
  }) as ContentNode;

export const samplePlan = (over: Partial<ContentPlan> = {}, hub: ContentNode | null = sampleHub()): ContentPlan =>
  ContentPlanSchema.parse({
    id: "plan_1",
    tenantId: "ten_A",
    workspaceId: "ws1",
    name: "Visibility guide",
    status: "ready",
    strategy: { objective: "brand_visibility", hubUrl: "https://acme.example/blog/visibility" },
    scope: {},
    knowledge: {},
    topology: { hubChannel: "blog", spokeChannels: [] },
    graph: { nodes: hub ? [hub] : [], edges: [] },
    blog: {
      ...SAMPLE_BRIEF,
      subjectId: "sub_aaaaaaaa",
      primaryRef: "q_aaaaaaaa",
      questions: [{ ...SAMPLE_BRIEF.questions[0], ref: "q_bbbbbbbb" }, SAMPLE_BRIEF.questions[1]],
    },
    createdAt: "2026-10-07T08:00:00.000Z",
    updatedAt: "2026-10-07T08:00:00.000Z",
    ...over,
  });
