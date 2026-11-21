import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { connectedDataHelp, connectorHelp, SIGN_IN_HELP } from "./helpText";
import { parseManifest } from "./manifest";
import { cloudflareManifest } from "./manifests/cloudflare";
import { searchConsoleManifest } from "./manifests/searchConsole";
import { SIGNIN_REASONS } from "./messages";
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

  it("takes Search Console's sign in, what it reads, its numbers and its lag from its manifest", () => {
    const help = connectorHelp(parseManifest(searchConsoleManifest));
    expect(help.token).toBeNull();
    expect(help.signIn?.steps[0]).toBe("On Google Search Console in Connected data, press Sign in with Google.");
    expect(help.signIn?.steps.at(-1)).toContain("pick which site or property");
    expect(help.signIn?.reads).toEqual(["Search numbers for the site you pick", "The sites your Google account can see in Search Console"]);
    expect(help.numbers.map((n) => n.name)).toEqual(["Search clicks", "Search impressions", "Search click rate", "Average search position"]);
    expect(help.lag).toBe("A day's numbers are complete about 3 days later.");
    expect(connectorHelp(parseManifest(cloudflareManifest)).signIn).toBeNull();
  });

  it("says Google's 100 sign in limit, the 7 day testing limit, how to remove access and what Disconnect leaves", () => {
    const help = connectedDataHelp();
    expect(help.signIn).toBe(SIGN_IN_HELP);
    expect(help.signIn.limit).toContain("at most 100 sign ins for one Google account");
    expect(help.signIn.testing).toContain("7 days");
    expect(help.signIn.removeAccess).toContain("myaccount.google.com/permissions");
    expect(help.signIn.disconnect).toContain("leaves the access in your Google account");
    expect(help.signIn.message).toContain("Reconnect");
    expect(help.signInReasons).toBe(SIGNIN_REASONS);
    expect(Object.keys(help.signInReasons)).toEqual(expect.arrayContaining(["wrong_browser", "wrong_admin", "state_used", "state_expired", "scope_not_granted"]));
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
