import { describe, expect, it, vi } from "vitest";
import { renderPng, RENDER_SIZES } from "./render";
import { bundledFontPlan } from "./renderFonts";
import { partnerLockup, portraitCard, reportCover } from "./templates/formats";
import { skinFor } from "./templates/skins";
import { formatTemplate } from "./styleImage";
import { IMAGE_STYLE_IDS } from "@/lib/types/imageStyle";
import { paintFormatScene, sceneWords } from "../formatScene";

const PIXEL = { src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", width: 1, height: 1 };

describe("formats", () => {
  it("each format draws at every size, with a painted scene and without, in a drawn and a painted skin", async () => {
    const plan = await bundledFontPlan();
    const inputs = { quote: "UTMs tell you the platform.", name: "Sam Rivera", role: "Founder", partner: "Example", line: "Your data, *inside Example.*", title: "The state of AI search", subtitle: "What 120 teams said", figure: { value: "120", unit: "teams" } };
    for (const [name, tpl] of Object.entries({ portraitCard, partnerLockup, reportCover })) {
      for (const skin of ["headline_card", "soft_3d"]) {
        for (const art of [PIXEL, null]) {
          for (const [size, { width, height }] of Object.entries(RENDER_SIZES)) {
            const png = await renderPng(
              tpl({ width, height, headline: "A headline", accent: "#5B4FE6", brandName: "Example", fonts: { heading: plan.heading, body: plan.body }, formatInputs: inputs, skin, art }),
              { width, height, fonts: plan.fonts },
            );
            expect(png, `${name} ${skin} ${art ? "art" : "no art"} ${size}`).not.toBeNull();
            expect([png!.readUInt32BE(16), png!.readUInt32BE(20)]).toEqual([width, height]);
          }
        }
      }
    }
  }, 120_000);

  it("every style lends a skin, and the standard image has no format template", () => {
    for (const id of IMAGE_STYLE_IDS) {
      const s = skinFor(id, "#5B4FE6");
      expect(s.ink, id).toBeTruthy();
      expect(s.ground, id).toBeTruthy();
    }
    expect([formatTemplate("portrait"), formatTemplate("standard"), formatTemplate(undefined)]).toEqual(["portrait", null, null]);
  });
});

describe("a format's painted scene", () => {
  const req = { format: "portrait" as const, inputs: { quote: "Ship small, ship often." }, headline: "H", direction: { label: "Soft 3D", keywords: "soft clay" }, aspectRatio: "1:1", timeoutMs: 60_000 };

  it("pictures what the card says, never with too little time", async () => {
    expect(sceneWords(req)).toBe("Ship small, ship often.");
    expect(sceneWords({ ...req, format: "report_cover", inputs: { title: "T", subtitle: "S" } })).toBe("T. S");
    const brief = vi.fn(async (_p: string) => "A tidy workbench at dawn");
    const paint = vi.fn(async (_p: string, _a: string, _t: number) => ({ bytes: Buffer.from("x"), mimeType: "image/png" }));
    expect(await paintFormatScene(req, { brief, paint })).toMatchObject({ mimeType: "image/png" });
    expect(brief.mock.calls[0]![0]).toContain("NO people at all");
    expect(paint.mock.calls[0]![0]).toBe("A tidy workbench at dawn");
    expect(await paintFormatScene({ ...req, timeoutMs: 8_000 }, { brief, paint })).toBeNull();
  });

  it("without a brief, a safe stand-in prompt; a failed paint is null", async () => {
    const paint = vi.fn(async (_p: string, _a: string, _t: number) => null);
    expect(await paintFormatScene(req, { brief: async () => null, paint })).toBeNull();
    expect(paint.mock.calls[0]![0]).toContain("No people, no logos, no text.");
  });
});
