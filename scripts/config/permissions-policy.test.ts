import { describe, expect, it } from "vitest";
import type { Header } from "next/dist/lib/load-custom-routes";
// The matcher the Next server builds for each header rule, so this checks what really happens.
import { buildCustomRoute } from "next/dist/server/lib/router-utils/filesystem";
import nextConfig from "../../next.config";

/**
 * The microphone is allowed on the public waitlist pages, the embeddable widget, the homepage and
 * the admin welcome page (Talk with Vizzy), and nowhere else. Each path gets exactly one
 * Permissions-Policy: two would conflict. The welcome's own pages under it, every other admin
 * page and every API keep the microphone off.
 */

const MIC_ON = "camera=(), microphone=(self), geolocation=()";
const MIC_OFF = "camera=(), microphone=(), geolocation=()";

async function rules() {
  const headers = (await nextConfig.headers!()) as Header[];
  return headers.map((rule) => ({ rule, match: buildCustomRoute("header", rule, "", false).match }));
}

/** Every header the rules give a path, by key, in rule order (the last of a key wins in Next). */
async function headersFor(path: string): Promise<Array<{ key: string; value: string }>> {
  return (await rules()).filter(({ match }) => match(path) !== false).flatMap(({ rule }) => rule.headers);
}

async function permissionsFor(path: string): Promise<string[]> {
  return (await headersFor(path)).filter((h) => h.key === "Permissions-Policy").map((h) => h.value);
}

describe("the microphone header", () => {
  it("lets only the welcome page use the microphone in the admin", async () => {
    expect(await permissionsFor("/admin/welcome")).toEqual([MIC_ON]);
    // Next serves the same page with a trailing slash.
    expect(await permissionsFor("/admin/welcome/")).toEqual([MIC_ON]);
  });

  it.each(["/admin", "/admin/welcome/learned", "/admin/welcome/questions", "/admin/welcomes", "/admin/settings", "/api/admin/onboarding/voice/start"])(
    "keeps it off on %s",
    async (path) => {
      expect(await permissionsFor(path)).toEqual([MIC_OFF]);
    },
  );

  it.each(["/", "/waitlist/x", "/waitlist/x/y"])("keeps %s as it was, with the microphone", async (path) => {
    expect(await permissionsFor(path)).toEqual([MIC_ON]);
  });

  it("keeps the embeddable widget's own single rule", async () => {
    const embed = await permissionsFor("/embed/x");
    expect(embed).toHaveLength(1);
    expect(embed[0]).toContain("microphone=(self)");
  });

  it("keeps the welcome page out of other sites' frames", async () => {
    const headers = await headersFor("/admin/welcome");
    expect(headers).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
    const csp = headers.filter((h) => h.key === "Content-Security-Policy").map((h) => h.value);
    expect(csp).toHaveLength(1);
    expect(csp[0]).toContain("frame-ancestors 'none'");
  });

  it("gives every path one Permissions-Policy at most", async () => {
    for (const path of ["/admin/welcome", "/admin/welcome/", "/admin/brands/new", "/help", "/developers", "/embed.js", "/admin-preview/abc", "/login"]) {
      expect((await permissionsFor(path)).length, path).toBeLessThanOrEqual(1);
    }
  });
});
