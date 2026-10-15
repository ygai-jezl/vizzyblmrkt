import type { TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { isCanvasAuthConfigured, tenantContextFromCanvasToken, verifyCanvasContext } from "@/lib/canvas/auth";
import { computeCoverage } from "@/lib/content/blog/coverage";
import { describeChange } from "./changes";
import { isBrandMapChatEnabled, isBrandMapPagesEnabled } from "./flags";
import { listBrandMapPages } from "./pages";
import { isMapSaved } from "@/lib/types/brandMap";
import { readBrandMap } from "./store";

/**
 * What Vizzy may READ of the brand map (BRAND_MAP_CHAT_ENABLED): what is decided, and how
 * many suggestions wait (what they are, never who asked). With the pages switch on, which
 * questions are answered, being written, or open. Brand content only. Auth is the signed
 * canvas capability token (the tenant comes from it).
 */

export type ApiResult = { status: number; body: unknown };

const NOTE =
  "Vizzy can only suggest changes (suggest_brand_map): never links, and nothing in the map changes until an admin " +
  "accepts a suggestion on Brand › Brand map. Articles are written from the map only once it has been saved (rev ≥ 1).";

export function brandMapAgentGate(req: Request): { ok: true; ctx: TenantContext } | { ok: false; result: ApiResult } {
  if (!isBrandMapChatEnabled()) return { ok: false, result: { status: 503, body: { error: "unavailable" } } };
  if (!isCanvasAuthConfigured()) return { ok: false, result: { status: 503, body: { error: "canvas_auth_unconfigured" } } };
  const verified = verifyCanvasContext(req.headers.get("x-canvas-context") ?? "");
  if (!verified.ok) return { ok: false, result: { status: 401, body: { error: "unauthorized", reason: verified.error } } };
  return { ok: true, ctx: tenantContextFromCanvasToken(verified.claims) };
}

const STATE: Record<string, string> = { answered: "answered", drafted: "being written", planned: "planned", open: "open" };

export async function agentBrandMap(ctx: TenantContext, db?: FirestoreLike): Promise<ApiResult> {
  const read = await readBrandMap(ctx, db);
  if (read.state === "unreadable") return { status: 409, body: { error: "map_unreadable", note: "The saved brand map can't be read. An admin needs to look at it on the page." } };
  if (read.state === "none") return { status: 200, body: { map: null, note: `No brand map yet. ${NOTE}` } };
  const map = read.map;
  const pagesOn = isBrandMapPagesEnabled() && isMapSaved(map);
  const coverage = pagesOn ? computeCoverage(map, await listBrandMapPages(ctx, db).catch(() => [])) : null;
  const stateOf = new Map(coverage?.subjects.flatMap((s) => s.questions.map((q) => [q.id, q] as const)) ?? []);
  const i = map.identity;
  return {
    status: 200,
    body: {
      map: {
        rev: map.rev,
        saved: isMapSaved(map),
        identity: {
          name: i.name,
          category: i.category,
          statement: i.statement,
          isNot: i.isNot,
          avoid: i.avoid.map((a) => ({ term: a.term, useInstead: a.useInstead })),
          site: i.site,
          profiles: i.profiles.map((p) => p.url),
          categorySameAs: i.categorySameAs.map((p) => p.url),
        },
        subjects: map.subjects.map((s) => ({
          id: s.id,
          name: s.name,
          home: s.home ?? null,
          questions: s.questions.map((q) => {
            const c = stateOf.get(q.id);
            return {
              id: q.id,
              text: q.text,
              intent: q.intent,
              ...(c ? { state: STATE[c.state], ...(c.pages[0] ? { answeredBy: { title: c.pages[0].title, url: c.pages[0].url } } : {}) } : {}),
            };
          }),
        })),
        names: map.names.map((n) => ({ id: n.id, name: n.name, kind: n.kind, aliases: n.aliases, home: n.home ?? null, sameAs: n.sameAs.map((l) => l.url) })),
      },
      suggestions: {
        waiting: map.suggestions.length,
        latest: [...map.suggestions]
          .sort((a, b) => b.at.localeCompare(a.at))
          .slice(0, 10)
          .map((s) => ({ change: describeChange(s.change), from: s.from, reason: s.reason })),
      },
      statesKnown: Boolean(coverage),
      note: NOTE,
    },
  };
}
