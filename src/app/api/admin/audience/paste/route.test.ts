import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Paste a list (RAISE_PASTE_ENABLED): the switch, the same origin, a session, an admin; rows read by
// code into one card; skipped rows by number only; the brand is the session's, never the body's.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));
const limiter = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant/rateLimit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant/rateLimit")>()), ...limiter }));

const { POST } = await import("./route");
const { DONE_WHEN_TSV } = await import("@/lib/crm/paste/testing/samples");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "u_admin", role: "admin" } as const;
const member = { ...admin, userId: "u_member", role: "member" };
const SWITCHES = [
  "AUDIENCE_PERSON_LINKS_ENABLED",
  "AUDIENCE_ONE_VIEW_ENABLED",
  "ONTOLOGY_PERSON_IDS_ENABLED",
  "AUDIENCE_ADD_PERSON_ENABLED",
  "NEXT_PUBLIC_NAV_V2_ENABLED",
  "NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED",
  "NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED",
  "RAISE_PASTE_ENABLED",
];

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request("http://localhost/api/admin/audience/paste", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

let db: FakeFirestore;
beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  for (const s of SWITCHES) vi.stubEnv(s, "true");
  session.getAdminContext.mockResolvedValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/admin/audience/paste", () => {
  it("doesn't exist with the switch off, and reads nothing", async () => {
    vi.stubEnv("RAISE_PASTE_ENABLED", "false");
    const res = await post({ text: DONE_WHEN_TSV, source: "An event" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(session.getAdminContext).not.toHaveBeenCalled();
    vi.stubEnv("RAISE_PASTE_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "false");
    expect((await post({ text: DONE_WHEN_TSV, source: "An event" })).status).toBe(404);
    expect(db.dump("agent_actions")).toHaveLength(0);
  });

  it("blocks another origin, a signed out visitor and a member", async () => {
    expect((await post({ text: DONE_WHEN_TSV, source: "An event" }, { origin: "https://evil.example.com" })).status).toBe(403);
    session.getAdminContext.mockResolvedValue(null);
    expect((await post({ text: DONE_WHEN_TSV, source: "An event" })).status).toBe(401);
    session.getAdminContext.mockResolvedValue(member);
    const res = await post({ text: DONE_WHEN_TSV, source: "An event" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(db.dump("agent_actions")).toHaveLength(0);
  });

  it("refuses a missing source, a tenantId in the body, bad JSON and a body over the size", async () => {
    const no = await post({ text: DONE_WHEN_TSV, source: "  " });
    expect(no.status).toBe(400);
    expect(await no.json()).toEqual({ error: "source_needed" });
    const brand = await post({ text: DONE_WHEN_TSV, source: "An event", tenantId: "ten_B" });
    expect(brand.status).toBe(400);
    expect(await brand.json()).toEqual({ error: "invalid_input" });
    expect((await post("{not json")).status).toBe(400);
    const big = await post({ text: "x".repeat(270_000), source: "An event" });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "too_long" });
    const said = await post({ text: "Email\njo@example.com", source: "An event" }, { "content-length": "300000" });
    expect(said.status).toBe(413);
    expect((await post({ text: `Email\n${"x".repeat(200_001)}`, source: "An event" })).status).toBe(413);
    expect((await post({ text: "jo@example.com,Jo", source: "An event" })).status).toBe(400);
    expect(db.dump("agent_actions")).toHaveLength(0);
  });

  it("reads the list into one card for the session's brand (201), skipped rows by number only", async () => {
    const res = await post({ text: DONE_WHEN_TSV, source: "An event" });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.batch).toMatchObject({ source: "An event", counts: { read: 14, people: 10, companies: 3, left: 1, already: 0 } });
    expect(body.batch.id).toMatch(/^aa_[0-9a-f]{40}$/);
    expect(body.skipped).toEqual([{ row: 15, reason: "no_contact" }]);
    expect(body.warning).toBeNull();
    const [a] = db.dump("agent_actions") as Array<{ tenantId: string; agent: string }>;
    expect(a).toMatchObject({ tenantId: "ten_A", agent: "paste" });
    expect(db.dump("contacts")).toHaveLength(0);
  });

  it("answers 200 with nothing saved when nothing is left to add", async () => {
    const res = await post({ text: "Name,Email\nUna Nameonly,", source: "An event" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ batch: null, skipped: [{ row: 2, reason: "no_contact" }], warning: null, error: "nothing_to_add" });
    expect(db.dump("agent_actions")).toHaveLength(0);
  });

  it("answers 429 past its rate, per member", async () => {
    limiter.isRateLimited.mockResolvedValueOnce(true);
    const res = await post({ text: DONE_WHEN_TSV, source: "An event" });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(limiter.isRateLimited).toHaveBeenCalledWith("user:ten_A:u_admin", expect.objectContaining({ prefix: "paste_read", burstLimit: 10, hourlyLimit: 60 }));
    expect(db.dump("agent_actions")).toHaveLength(0);
  });
});
