import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signCanvasContext } from "@/lib/canvas/auth";
import type { CanvasAuthorArgs } from "@/lib/canvas/types";

/**
 * The canvas route stamps every Vizzy draft (learning loops step 5, 4.1 of the plan for steps 4
 * and 5): `canvas.<kind>`, made by Vizzy, handed to the kind to keep and counted made once a new
 * draft is saved, never for a rewrite or a draft already waiting (decision 20). Off, the kind is
 * told `loops_off` and nothing is counted. Acme is made up.
 */

const authorDraft = vi.fn(async (_args: CanvasAuthorArgs) => ({
  ok: true as const,
  id: "wave_1",
  status: "draft",
  url: "/admin/launches/c1",
  summary: "Drafted an invite wave.",
  warnings: [],
  card: { kind: "invite_wave", id: "wave_1", title: "Invite wave", url: "/admin/launches/c1", stats: [], warnings: 0 },
  saved: "created" as "created" | "rewritten" | "none",
}));
const countMade = vi.fn(async () => {});

vi.mock("@/lib/canvas/registry", () => ({
  getCanvasKind: (kind: string) => (kind === "invite_wave" ? { kind: "invite_wave", label: "invite wave", authorDraft } : null),
  canvasKindNames: () => ["invite_wave"],
}));
vi.mock("@/lib/loops/count", () => ({ countMade }));

const acme = { tenantId: "ten_acme", region: "us" as const, userId: "u_sam", role: "admin" as const, source: "idtoken" as const };

async function post(body: unknown) {
  const { POST } = await import("./route");
  return POST(
    new Request("https://app.example.com/api/agent/canvas", {
      method: "POST",
      headers: { "content-type": "application/json", "x-canvas-context": signCanvasContext(acme) },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("CANVAS_CONTEXT_SIGNING_KEY", "test-signing-key-abc");
  authorDraft.mockClear();
  countMade.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/agent/canvas stamps every Vizzy draft", () => {
  it("hands the kind loops_off with LOOPS_ENABLED off, and counts nothing it can write", async () => {
    const res = await post({ kind: "invite_wave", action: "save_draft", scope: { campaignId: "c1" } });
    expect(res.status).toBe(200);
    expect(authorDraft.mock.calls[0]![0].made).toEqual({ unstamped: "loops_off" });
  });

  it("with LOOPS_ENABLED on, stamps the draft canvas.<kind> by vizzy and counts it made once saved", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    const res = await post({ kind: "invite_wave", action: "save_draft", scope: { campaignId: "c1" } });
    expect(res.status).toBe(200);
    const made = authorDraft.mock.calls[0]![0].made;
    expect(made).toMatchObject({ made: "m1.canvas.invite_wave.0.n", kind: "canvas.invite_wave", arm: "none", by: "vizzy" });
    // The tenant comes from the signed token only.
    expect(authorDraft.mock.calls[0]![0].ctx.tenantId).toBe("ten_acme");
    expect(countMade).toHaveBeenCalledTimes(1);
    expect(countMade).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "ten_acme" }), "canvas.invite_wave", made);
  });

  it("counts made once per saved draft: never for Vizzy's new words on one it counted, or for nothing new", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    const base = await authorDraft({} as CanvasAuthorArgs);
    authorDraft.mockClear();
    for (const saved of ["rewritten", "none"] as const) {
      authorDraft.mockResolvedValueOnce({ ...base, saved });
      const res = await post({ kind: "invite_wave", action: "save_draft", scope: { campaignId: "c1", waveId: "wave_1" } });
      expect(res.status).toBe(200);
    }
    expect(authorDraft).toHaveBeenCalledTimes(2);
    expect(countMade).not.toHaveBeenCalled();
  });

  it("counts nothing when the kind refuses the draft", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    authorDraft.mockResolvedValueOnce({ ok: false, status: 409, error: "invites_locked" } as never);
    const res = await post({ kind: "invite_wave", action: "save_draft", scope: { campaignId: "c1" } });
    expect(res.status).toBe(409);
    expect(countMade).not.toHaveBeenCalled();
  });
});
