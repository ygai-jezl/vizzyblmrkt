import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { connectedDataHelp, connectorHelp, SHARE_ACCESS_HELP, SIGN_IN_HELP, TROUBLESHOOTING_QUOTES, VIZZY_HELP } from "./helpText";
import { parseManifest } from "./manifest";
import { cloudflareManifest } from "./manifests/cloudflare";
import { ga4Manifest } from "./manifests/ga4";
import { searchConsoleManifest } from "./manifests/searchConsole";
import { CONNECTOR_ERRORS, SIGNIN_REASONS } from "./messages";
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
    expect(help.signIn?.steps[0]).toBe("Open Google Search Console under Settings › Connections › Browse, then press Sign in with Google.");
    expect(help.signIn?.steps.at(-1)).toContain("pick which site or property");
    expect(help.signIn?.reads).toEqual(["Search numbers for the site you pick", "The sites your Google account, or the address you share with, can see in Search Console"]);
    expect(help.numbers.map((n) => n.name)).toEqual(["Search clicks", "Search impressions", "Search click rate", "Average search position"]);
    expect(help.lag).toBe("A day's numbers are complete about 3 days later.");
    expect(connectorHelp(parseManifest(cloudflareManifest)).signIn).toBeNull();
  });

  it("takes share access's role and steps from each manifest, and Google Analytics' numbers and lag", () => {
    const sc = connectorHelp(parseManifest(searchConsoleManifest));
    expect(sc.share?.role).toBe("Restricted");
    expect(sc.share?.steps[0]).toBe(
      "Open Google Search Console under Settings › Connections › Browse, then press Make the address under Share access. YouGrow shows a Google address made for this one connection.",
    );
    expect(sc.share?.steps.at(-1)).toBe("Back in YouGrow, press Check access, then pick the site.");
    const ga = connectorHelp(parseManifest(ga4Manifest));
    expect(ga.share?.role).toBe("Viewer");
    expect(ga.share?.steps.join(" ")).toContain("Property access management");
    expect(ga.signIn?.reads).toEqual(ga.share?.reads);
    expect(ga.numbers.map((n) => n.name)).toEqual(["Analytics sessions", "Analytics active users", "Analytics views", "Analytics key events"]);
    expect(ga.lag).toBe("A day's numbers are complete about 2 days later.");
    expect(connectorHelp(parseManifest(cloudflareManifest)).share).toBeNull();
  });

  it("says what share access keeps, what Disconnect leaves on the property, and quotes its messages", () => {
    const help = connectedDataHelp();
    expect(help.share).toBe(SHARE_ACCESS_HELP);
    expect(help.share.disconnect).toContain("does no harm");
    expect(help.share.hidden).toContain("CONNECTORS_IDENTITIES_PROJECT");
    expect(help.troubleshooting).toBe(TROUBLESHOOTING_QUOTES);
    expect(help.troubleshooting.shareNotVisible).toBe(CONNECTOR_ERRORS.share_not_visible);
    expect(help.troubleshooting.shareNotVisible).toMatch(/^We can't see your property yet\./);
    expect(help.troubleshooting.shareQuota).toContain("Sign in with Google instead");
    expect(help.troubleshooting.shareWorkspace).toContain("Google Workspace admin");
    expect(help.vizzy).toBe(VIZZY_HELP);
    expect(help.vizzy.join(" ")).toContain("only when an admin allows Vizzy to read it");
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

describe("where the help words can run", () => {
  // The How to drawer renders the Connected data page in the browser, so everything helpText.ts
  // imports, all the way down, must be pure: no store, provider, Google client or Node module.
  const SRC = join(process.cwd(), "src");
  const FORBIDDEN = [/^node:/, /^@\/lib\/tenant/, /^@\/lib\/auth/, /google-auth-library/, /firebase/, /\/(registry|service|safeFetch|shareAccess|google|tokenKeeper|vault|live)$/];

  function importsOf(file: string): string[] {
    const src = readFileSync(file, "utf8");
    return [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]!);
  }

  function resolveFile(from: string, spec: string): string | null {
    if (!spec.startsWith(".") && !spec.startsWith("@/")) return null;
    const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : resolve(dirname(from), spec);
    for (const f of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
      try {
        readFileSync(f);
        return f;
      } catch {
        // try the next
      }
    }
    return null;
  }

  it("imports only pure modules, all the way down", () => {
    const seen = new Set<string>();
    const queue = [join(SRC, "lib", "connectors", "helpText.ts")];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of importsOf(file)) {
        expect(FORBIDDEN.some((re) => re.test(spec)), `${file.slice(SRC.length)} imports ${spec}`).toBe(false);
        const next = resolveFile(file, spec);
        if (next) queue.push(next);
      }
    }
    expect([...seen].some((f) => f.endsWith("catalog.ts"))).toBe(true);
  });
});
