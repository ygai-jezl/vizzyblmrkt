import { describe, expect, it } from "vitest";
import { emailStylePrint, imageStylePrint, keyHash, launchJourneyPrint, lifecycleDraftPrint, notePrint, planPrint, stableJson, wavePrint } from "./fingerprints";

describe("fingerprints", () => {
  it("print the same value the same way whatever its key order", () => {
    expect(stableJson({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe(stableJson({ a: [2, { d: 3 }], b: 1 }));
  });

  it("ignore positions, ids and stray spaces, and see a changed subject", () => {
    const graph = (x: number, subject: string) => ({
      nodes: [
        { id: `n${x}`, type: "email", position: { x, y: 0 }, data: { subject, body: "Water weekly." } },
        { id: "w1", type: "wait", position: { x: 0, y: x }, data: { waitHours: 48 } },
      ],
    });
    expect(launchJourneyPrint(graph(10, "Repot in spring"))).toBe(launchJourneyPrint(graph(99, "Repot  in spring ")));
    expect(launchJourneyPrint(graph(10, "Repot in spring"))).not.toBe(launchJourneyPrint(graph(10, "Repot in May")));
    expect(launchJourneyPrint(graph(10, "Repot in spring"))).toMatch(/^[0-9a-f]{16}$/);
  });

  it("cover a lifecycle journey's emails, waits, start and own style", () => {
    const draft = (minHours: number, style: unknown = null) => ({
      graph: { nodes: [{ type: "wait", data: { wait: { minHours } } }] },
      pools: [{ items: [{ subject: "Welcome", body: "Hello" }] }],
      settings: { trigger: { event: "user.signed_up" }, emailStyle: style },
    });
    expect(lifecycleDraftPrint(draft(16))).toBe(lifecycleDraftPrint(draft(16)));
    expect(lifecycleDraftPrint(draft(16))).not.toBe(lifecycleDraftPrint(draft(40)));
    expect(lifecycleDraftPrint(draft(16))).not.toBe(lifecycleDraftPrint(draft(16, { headerColor: "#225533" })));
  });

  it("read a style the same as suggested and as saved", () => {
    const suggested = { logoId: "lg_1", companyName: "Fernhill", headerColor: "#2F6B3A", accentColor: "#AA3300", headerImageId: undefined, theme: { preset: "classic" } };
    const saved = { logo: { id: "lg_1" }, companyName: "Fernhill", headerColor: "#2f6b3a", accentColor: "#aa3300", headerGradientColor: "#2f6b3a", headerText: "auto", headerImage: null, theme: null };
    expect(emailStylePrint(suggested)).toBe(emailStylePrint(saved));
    expect(emailStylePrint(suggested)).not.toBe(emailStylePrint({ ...saved, accentColor: "#000000" }));
    expect(imageStylePrint({ defaultStyleId: "photo", channels: { linkedin: undefined } })).toBe(imageStylePrint({ defaultStyleId: "photo" }));
  });

  it("cover a wave, a plan and a note, and hash a map key", () => {
    expect(wavePrint({ size: 50, subject: "You're in", body: "Hi" })).not.toBe(wavePrint({ size: 60, subject: "You're in", body: "Hi" }));
    expect(planPrint({ graph: { nodes: [{ type: "hub", role: "Hub: Blog", body: "Care tips" }] } })).not.toBe(planPrint({ graph: { nodes: [{ type: "hub", role: "Hub: Blog", body: "More care tips" }] } }));
    expect(notePrint({ text: "Buyers repot in spring." })).toBe(notePrint({ text: " Buyers  repot in spring." }));
    expect(keyHash("add_name|fernhill")).toMatch(/^[0-9a-f]{16}$/);
    expect(keyHash("add_name|fernhill")).not.toContain("fernhill");
  });
});
