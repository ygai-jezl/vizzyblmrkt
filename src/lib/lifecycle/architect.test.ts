import { describe, it, expect } from "vitest";
import type { ConnectionCatalog } from "@/lib/types/productConnection";
import { buildProductOnboardingDraft } from "./templates/productOnboarding";
import { validateLifecycleDraft } from "./graph";
import { applyOptions, ArchitectOptionsSchema, architectLifecycleDraft, tidyCopy } from "./architect";

const catalog: ConnectionCatalog = {
  events: [],
  traits: [],
  onboardingSteps: [
    { id: "create_brand", label: "Add your brand", url: "https://app.example.com/brand", order: 0 },
    { id: "run_audit", label: "Run an audit", url: null, order: 1 },
  ],
  glossary: [{ term: "AI answers", definition: "What assistants say about you." }],
};
const connection = { name: "Vizzybl", catalog };
const opts = (o: Record<string, unknown> = {}) => ArchitectOptionsSchema.parse(o);

describe("applyOptions", () => {
  it("keeps the 7-day template as is by default", () => {
    const base = buildProductOnboardingDraft(catalog);
    const d = applyOptions(base, opts());
    expect(d.graph).toEqual(base.graph);
    expect(d.settings.sendPolicy.hardStopDays).toBe(12);
  });

  it("stretches the schedule for a longer sequence and trims the pools", () => {
    const d = applyOptions(buildProductOnboardingDraft(catalog), opts({ days: 14, reminders: 2, education: 1 }));
    const wait4 = d.graph.nodes.find((n) => n.id === "wait_4")!.data.wait!;
    expect(wait4.sinceEnrolHours).toBe(328);
    expect(wait4.minHours).toBe(80);
    expect(d.settings.sendPolicy.hardStopDays).toBe(24);
    expect(d.pools.find((p) => p.id === "reminders")!.items.map((i) => i.id)).toEqual(["r1", "r2"]);
    expect(d.pools.find((p) => p.id === "education")!.items.map((i) => i.id)).toEqual(["e1"]);
    expect(validateLifecycleDraft(d, catalog).ok).toBe(true);
  });

  it("applies the send window, sender and category", () => {
    const d = applyOptions(
      buildProductOnboardingDraft(catalog),
      opts({ sendDays: [1, 3, 5], sendTime: "08:30", windowMinutes: 60, sender: { fromName: "Jez", fromEmail: "jez@vizzybl.ai" }, categoryLabel: "Getting started" }),
    );
    expect(d.settings.sendPolicy).toMatchObject({ days: [1, 3, 5], startHour: 8, startMinute: 30, windowMinutes: 60 });
    expect(d.settings.sender).toMatchObject({ fromName: "Jez", fromEmail: "jez@vizzybl.ai" });
    expect(d.settings.category.label).toBe("Getting started");
  });

  it("keeps the window inside the day", () => {
    const d = applyOptions(buildProductOnboardingDraft(catalog), opts({ sendTime: "23:30", windowMinutes: 120 }));
    expect(d.settings.sendPolicy.windowMinutes).toBe(30);
  });
});

describe("tidyCopy", () => {
  it("drops tokens the platform can't fill and restores required blocks", () => {
    const out = tidyCopy("<p>Hi {{user.first_name|there}}, your {{score}} is {{fact.sov}}.</p>", ["block.insight"]);
    expect(out).toContain("{{user.first_name|there}}");
    expect(out).not.toContain("{{score}}");
    expect(out).not.toContain("{{fact.sov}}");
    expect(out).toContain("{{block.insight}}");
  });
});

describe("architectLifecycleDraft", () => {
  it("writes fresh copy for every email, keeping each email's blocks", async () => {
    const prompts: string[] = [];
    const generate = async (prompt: string) => {
      prompts.push(prompt);
      return JSON.stringify({ subject: "Hello {{user.first_name|there}}", previewText: "A quick note", body: "<p>Hi {{user.first_name|there}}!</p>" });
    };
    const r = await architectLifecycleDraft({ connection, brief: "Friendly, founder voice", brandVoice: "Plain and warm", generate });
    if ("error" in r) throw new Error(r.detail);
    expect(prompts).toHaveLength(9);
    expect(prompts[0]).toContain("Vizzybl");
    expect(prompts[0]).toContain("<brief>");
    const w = r.draft.pools.find((p) => p.id === "welcome")!.items[0]!;
    expect(w.subject).toBe("Hello {{user.first_name|there}}");
    expect(w.body).toContain("{{block.checklist}}");
    expect(w.body).toContain("{{block.next_step}}");
    const r1 = r.draft.pools.find((p) => p.id === "reminders")!.items[0]!;
    expect(r1.body).toContain("{{block.insight}}");
    expect(r1.personalization).toBe("ai_line"); // structure and settings stay the template's
    expect(r.notes).toEqual([]);
    expect(validateLifecycleDraft(r.draft, catalog).ok).toBe(true);
  });

  it("keeps the template copy where the model fails, and says so", async () => {
    const r = await architectLifecycleDraft({ connection, generate: async () => null });
    if ("error" in r) throw new Error(r.detail);
    expect(r.notes).toHaveLength(9);
    expect(r.draft.pools[0]!.items[0]!.subject).toBe("Welcome to {{product.name}}, {{user.first_name|there}}");
  });

  it("can skip the copy entirely, and rejects bad options", async () => {
    let called = false;
    const r = await architectLifecycleDraft({ connection, options: { writeCopy: false }, generate: async () => ((called = true), null) });
    expect(called).toBe(false);
    expect("draft" in r).toBe(true);
    expect(await architectLifecycleDraft({ connection, options: { days: 40 } })).toMatchObject({ error: "invalid_options" });
  });
});
