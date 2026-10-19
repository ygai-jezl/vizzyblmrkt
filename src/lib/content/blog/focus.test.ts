import { describe, expect, it } from "vitest";
import { BlogBriefSchema } from "@/lib/types/contentPlan";
import { focusedBrief, isChoosingQuestion, isSloganLabel, pageNameFromUrl, writerLinks } from "./focus";

const brief = BlogBriefSchema.parse({
  questions: [
    { question: "What is prompt monitoring?", intent: "definition", by: "research" },
    { question: "What are the top alternatives to Rivalco?", intent: "alternatives", by: "research" },
    { question: "How often should we check?", intent: "how_to", by: "research" },
    { question: "Which alternatives did our customers try first?", intent: "alternatives", by: "operator" },
  ],
  entities: [
    { name: "Acme", relation: "brand", by: "research" },
    { name: "Rivalco", relation: "alternative", by: "research" },
    { name: "Othero", relation: "alternative", by: "operator" },
  ],
});

describe("what keeps an editorial article on its question", () => {
  it("leaves research's alternatives and definitions out unless the question is about choosing; a person's rows stay", () => {
    const f = focusedBrief(brief, "How often should marketing teams run prompt monitoring tests?");
    expect(f.questions.map((q) => q.question)).toEqual(["How often should we check?", "Which alternatives did our customers try first?"]);
    expect(f.entities.map((e) => e.name)).toEqual(["Acme", "Othero"]);
    expect(focusedBrief(brief, "What are the best AI visibility tools?")).toBe(brief);
  });

  it("knows a question about choosing a product", () => {
    expect(isChoosingQuestion("Rivalco vs Acme: which is better?")).toBe(true);
    expect(isChoosingQuestion("Which tool should we choose for tracking?")).toBe(true);
    expect(isChoosingQuestion("How often should you check your AI visibility?")).toBe(false);
  });

  it("gives the writer a page's plain name in place of its slogan", () => {
    expect(isSloganLabel("Speak Fluent ChatGPT. No Code Required.")).toBe(true);
    expect(isSloganLabel("Pricing")).toBe(false);
    expect(isSloganLabel("Set Up Prompt Monitoring")).toBe(false);
    expect(pageNameFromUrl("https://acme.example/waitlist")).toBe("Waitlist page");
    expect(pageNameFromUrl("https://acme.example/docs/get-started/metrics-explained")).toBe("Metrics explained page");
    expect(pageNameFromUrl("https://acme.example/")).toBe("acme.example home page");
    const out = writerLinks([
      { url: "https://acme.example/waitlist", label: "Speak Fluent ChatGPT. No Code Required.", intent: "convert", by: "research" },
      { url: "https://acme.example/pricing", label: "Pricing", intent: "convert", by: "research" },
    ]);
    expect(out.map((l) => l.label)).toEqual(["Waitlist page", "Pricing"]);
  });
});
