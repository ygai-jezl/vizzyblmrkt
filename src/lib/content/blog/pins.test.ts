import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import { evaluateCitable } from "./citable";
import { draftBlogArticle } from "./draft";
import { checkBlogFacts } from "./factCheck";
import { researchBlogBrief } from "./research";
import { suggestBlogSchema } from "./schema";
import { SAMPLE_ARTICLE, SAMPLE_BRIEF } from "./testing/sampleArticle";

/**
 * Pins what the blog hub sends and shows TODAY, before the brand map exists: the research,
 * writer, revision and fact-check prompts, the checklist's items and score, and the
 * suggested markup. With no brand map (or its switches off) every one must stay exactly
 * as it is, so these digests never change. The blog prompts are live in prod.
 */

afterEach(() => vi.unstubAllEnvs());

const digest = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);

const NOW = () => new Date("2026-10-07T09:00:00.000Z");

const plan = {
  id: "p1",
  tenantId: "ten_x",
  workspaceId: "ws1",
  name: "Visibility guide",
  status: "draft",
  strategy: { objective: "brand_visibility", hubUrl: "https://acme.example/blog/visibility", subscriberCount: null, sequenceType: null },
  scope: { topics: [], spark: "Buyers ask AI assistants for shortlists.", industryLens: "" },
  knowledge: { groundingScope: "global", proofAssets: [] },
  topology: { hubChannel: "blog", spokeChannels: [] },
  graph: { nodes: [], edges: [] },
  blog: SAMPLE_BRIEF,
  createdAt: "t",
  updatedAt: "t",
} as unknown as ContentPlan;

const node = {
  id: "hub",
  type: "hub",
  channel: "blog",
  role: "Hub",
  brief: "Explain it.",
  body: SAMPLE_ARTICLE,
  warnings: [],
  status: "generated",
} as unknown as ContentNode;

const KNOWLEDGE = "[Source: Customer story — https://acme.example/customers/harbor]\nHarbor's share of voice rose from 6% to 21%.";

describe("what the blog hub sends and shows today (no brand map)", () => {
  it("asks research the same questions", async () => {
    vi.stubEnv("CREATE_BLOG_CITE_SOURCES_ENABLED", "true");
    const grounded = vi.fn(async () => ({ text: "", model: "m", sources: [], supports: [] }));
    await researchBlogBrief(
      {
        ctx: { tenantId: "ten_x", region: "us" } as never,
        workspace: { id: "ws1", name: "Acme programme", audience: "Heads of marketing" },
        plan,
        brandName: "Acme",
        ownSites: ["acme.example"],
      },
      {
        grounded: grounded as never,
        retrieve: (async () => ({ formatted: KNOWLEDGE, chunks: [] })) as never,
        sitePages: async () => ({ pages: [], repoPaths: [] }),
        robots: async () => null,
        now: NOW,
      },
    );
    const prompts = grounded.mock.calls.map((c) => String((c as unknown[])[0]));
    const questions = prompts.find((p) => p.includes("ENTITY: <name>")) ?? "";
    const facts = prompts.find((p) => p.includes("FACT: <the sentence>")) ?? "";
    expect(digest(questions)).toBe("5ebce0883b7140d4");
    expect(digest(facts)).toBe("ffc1504371b22a9f");
  });

  it("gives the writer, and its second pass, the same instructions", async () => {
    const prompts: string[] = [];
    // The first draft has no Key facts box (a fail), so the writer gets one second pass.
    const firstDraft = SAMPLE_ARTICLE.replace(/> \*\*Key facts\*\*[\s\S]*?\n\n/, "");
    const generate = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      return `META_TITLE: T\nMETA_DESCRIPTION: D\nSLUG: s\n---\n${prompts.length === 1 ? firstDraft : SAMPLE_ARTICLE}`;
    });
    await draftBlogArticle(
      { plan, node, brief: SAMPLE_BRIEF, brandName: "Acme", knowledgeContext: KNOWLEDGE, knowledgeUrls: [], proofBlock: "" },
      { generate: generate as never, now: NOW },
    );
    expect(prompts).toHaveLength(2);
    expect(digest(prompts[0])).toBe("123d805c01dc4f3d");
    expect(digest(prompts[1])).toBe("dfde111de7da23da");
  });

  it("gives the fact check the same material", async () => {
    const generate = vi.fn(async () => "OK");
    await checkBlogFacts(
      { plan, node, brief: SAMPLE_BRIEF, brandName: "Acme", knowledgeContext: KNOWLEDGE, knowledgeUrls: [], proofBlock: "" },
      { generate: generate as never, now: NOW },
    );
    expect(digest(String((generate.mock.calls[0] as unknown[])[0]))).toBe("7149d8caf9815dbc");
  });

  it("scores an article the same way", () => {
    const report = evaluateCitable(SAMPLE_ARTICLE, { brief: SAMPLE_BRIEF, pageUrl: plan.strategy.hubUrl });
    const items = report.items.map((it) => `${it.id}:${it.status}:${it.detail}`);
    expect(report.items).toHaveLength(19);
    expect(digest({ score: report.score, items })).toBe("fa666269f281d069");
  });

  it("suggests the same markup", () => {
    const suggestion = suggestBlogSchema({
      markdown: SAMPLE_ARTICLE,
      brief: SAMPLE_BRIEF,
      pageUrl: plan.strategy.hubUrl,
      brandName: "Acme",
      logoUrl: "https://acme.example/logo.png",
    });
    expect(digest(suggestion)).toBe("79aaf225e49eabfb");
  });
});
