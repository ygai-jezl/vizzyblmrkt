import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { connectedDataHelp, connectorHelp } from "./helpText";
import { parseManifest } from "./manifest";
import { cloudflareManifest } from "./manifests/cloudflare";
import { allConnectors } from "./registry";

function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

describe("the connected data help words", () => {
  it("covers every connector the build knows, whatever its switch says", () => {
    expect(connectedDataHelp().connectors.map((c) => c.id)).toEqual(allConnectors().map((m) => m.id));
  });

  it("takes Cloudflare's token steps, permission, numbers and disconnect from its manifest", () => {
    const m = parseManifest(cloudflareManifest);
    const help = connectorHelp(m);
    expect(help.token?.permissions).toEqual(["Zone, Analytics, Read"]);
    expect(help.token?.steps).toEqual(m.connect[0]!.method === "token_fields" ? m.connect[0]!.steps : []);
    expect(help.token?.link).toMatch(/^https:\/\/dash\.cloudflare\.com\/profile\/api-tokens\?/);
    expect(help.numbers.map((n) => n.name)).toEqual(["Cloudflare requests", "Cloudflare page views", "Cloudflare visits"]);
    expect(help.shares.map((s) => s.direction)).toEqual(["Read only", "Never"]);
    expect(help.lag).toBe("A day's numbers are complete the next day.");
    expect(help.disconnect).toContain("delete it in Cloudflare");
  });

  it("explains every health state and quotes every message", () => {
    const help = connectedDataHelp();
    for (const state of help.healthOrder) expect(help.health[state], state).toBeTruthy();
    expect(Object.keys(help.messages).length).toBeGreaterThan(10);
    expect(help.grants.length).toBe(5);
  });

  it("writes in house style", () => {
    for (const text of stringsIn(connectedDataHelp()).filter((s) => !s.startsWith("https://"))) {
      expect(dashesIn(text), text).toEqual([]);
      expect(aiTellsIn(text), text).toEqual([]);
    }
  });
});
