import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenant")>();
  return { ...actual, getTenantById: vi.fn(async () => null) };
});

import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { __resetRateLimitState } from "@/lib/tenant/rateLimit";
import { ctx, seedConnection, seedLaunch, seedSignup } from "@/lib/invites/testing/fixtures";
import { authorInviteWaveDraft } from "./inviteWave";

const write = vi.fn(async () => ({ subject: "You're in", body: "Hi {{first_name}}, Fernlight is ready for you." }));

beforeEach(() => {
  __resetRateLimitState();
  vi.stubEnv("INVITES_ENABLED", "true");
  vi.stubEnv("EMAIL_LINK_ORIGIN", "https://yougrow.test");
  write.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

function world(withProduct = true) {
  const db = new FakeFirestore();
  seedLaunch(db);
  seedSignup(db, "s1");
  seedSignup(db, "s2");
  if (withProduct) seedConnection(db);
  return db;
}
const author = (db: FakeFirestore, input: Record<string, unknown>, brief = "Keep it short") =>
  authorInviteWaveDraft({ ctx, input, brief }, { db, write });

describe("invite_wave canvas kind", () => {
  it("is unavailable while invites are off, and says why a locked launch can't be invited", async () => {
    vi.stubEnv("INVITES_ENABLED", "false");
    expect(await author(world(), { scope: { campaignId: "beta" } })).toMatchObject({ ok: false, status: 503 });
    vi.stubEnv("INVITES_ENABLED", "true");
    expect(await author(world(false), { scope: { campaignId: "beta" } })).toMatchObject({
      ok: false,
      status: 409,
      error: "invites_locked",
      issues: ["Connect your product first."],
    });
    expect(await author(world(), { scope: { campaignId: "nope" } })).toMatchObject({ ok: false, status: 404 });
  });

  it("drafts a wave (never sends) with on-brand copy that always carries the link", async () => {
    const db = world();
    const r = await author(db, { scope: { campaignId: "beta" }, expiresInDays: 14 });
    expect(r).toMatchObject({ ok: true, status: "draft", card: { kind: "invite_wave", stats: [{ label: "people", value: 2 }, { label: "link days", value: 14 }] } });
    if (!r.ok) throw new Error("expected a draft");
    expect(r.url).toBe(`/admin/launches/beta/invites?wave=${r.id}`);
    const wave = db.raw("invite_waves", r.id)!;
    expect(wave).toMatchObject({ status: "draft", authoredBy: "agent", subject: "You're in" });
    expect(String(wave.body)).toContain("{{invite_link}}");
    expect(db.dump("invites")).toHaveLength(0);
    expect(db.dump("email_jobs")).toHaveLength(0);
  });

  it("falls back to the default invite copy, and edits an existing draft in place", async () => {
    const db = world();
    write.mockResolvedValueOnce(null as never);
    const first = await author(db, { scope: { campaignId: "beta" } });
    if (!first.ok) throw new Error("expected a draft");
    expect(db.raw("invite_waves", first.id)?.subject).toContain("{{product_name}}");
    const edited = await author(db, { scope: { campaignId: "beta", waveId: first.id }, size: 1, subject: "Doors open", body: "Come in" });
    expect(edited).toMatchObject({ ok: true, id: first.id });
    expect(db.raw("invite_waves", first.id)).toMatchObject({ subject: "Doors open", size: 1 });
    expect(await author(db, { scope: { campaignId: "beta", waveId: "wav_missing" } })).toMatchObject({ ok: false, status: 404 });
  });
});
