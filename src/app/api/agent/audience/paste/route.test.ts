import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Vizzy's paste_list_propose: the switches, the canvas token's brand and member (never the body's),
// admins only, never consent, and an answer that echoes no cell.
const auth = vi.hoisted(() => ({ isCanvasAuthConfigured: vi.fn(() => true), verifyCanvasContext: vi.fn(), tenantContextFromCanvasToken: vi.fn() }));
vi.mock("@/lib/canvas/auth", () => auth);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));
const limiter = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant/rateLimit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant/rateLimit")>()), ...limiter }));

const { POST } = await import("./route");
const { DONE_WHEN_ROWS, DONE_WHEN_TSV } = await import("@/lib/crm/paste/testing/samples");

const admin = { tenantId: "ten_A", region: "us", source: "agent", userId: "u_admin", role: "admin" };
const member = { ...admin, userId: "u_member", role: "member" };
const SWITCHES = [
  "AUDIENCE_PERSON_LINKS_ENABLED",
  "AUDIENCE_ONE_VIEW_ENABLED",
  "ONTOLOGY_PERSON_IDS_ENABLED",
  "AUDIENCE_ADD_PERSON_ENABLED",
  "AUDIENCE_VIZZY_ADD_PERSON_ENABLED",
  "NEXT_PUBLIC_NAV_V2_ENABLED",
  "NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED",
  "NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED",
  "RAISE_PASTE_ENABLED",
];

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/agent/audience/paste?tenantId=ten_B", { method: "POST", headers: { "content-type": "application/json", "x-canvas-context": "tok" }, body: JSON.stringify(body) }));

let db: FakeFirestore;
beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  store.db = db;
  for (const s of SWITCHES) vi.stubEnv(s, "true");
  auth.verifyCanvasContext.mockReturnValue({ ok: true, claims: {} });
  auth.tenantContextFromCanvasToken.mockReturnValue(admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/agent/audience/paste", () => {
  it("is unavailable with the paste switch off or People not on screen, and chat_unavailable with only Vizzy's New person off", async () => {
    vi.stubEnv("RAISE_PASTE_ENABLED", "false");
    const off = await post({ text: DONE_WHEN_TSV, source: "An event" });
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: "unavailable" });
    vi.stubEnv("RAISE_PASTE_ENABLED", "true");
    // Without People on screen the card couldn't open, so there is no box to point to either.
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "false");
    const noPeople = await post({ text: DONE_WHEN_TSV, source: "An event" });
    expect(noPeople.status).toBe(503);
    expect(await noPeople.json()).toEqual({ error: "unavailable" });
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "true");
    vi.stubEnv("AUDIENCE_VIZZY_ADD_PERSON_ENABLED", "false");
    const chat = await post({ text: DONE_WHEN_TSV, source: "An event" });
    expect(chat.status).toBe(503);
    expect(await chat.json()).toEqual({ error: "chat_unavailable" });
    expect(auth.verifyCanvasContext).not.toHaveBeenCalled();
    expect(db.dump("agent_actions")).toHaveLength(0);
  });

  it("is unavailable without canvas auth, 401s a bad token, 403s a member and 429s past the brand's rate", async () => {
    auth.isCanvasAuthConfigured.mockReturnValueOnce(false);
    const unset = await post({ text: DONE_WHEN_TSV, source: "An event" });
    expect(unset.status).toBe(503);
    expect(await unset.json()).toEqual({ error: "canvas_auth_unconfigured" });
    auth.verifyCanvasContext.mockReturnValueOnce({ ok: false, error: "expired" });
    expect((await post({ text: DONE_WHEN_TSV, source: "An event" })).status).toBe(401);
    auth.tenantContextFromCanvasToken.mockReturnValueOnce(member);
    const m = await post({ text: DONE_WHEN_TSV, source: "An event" });
    expect(m.status).toBe(403);
    expect(await m.json()).toEqual({ error: "forbidden" });
    limiter.isRateLimited.mockResolvedValueOnce(true);
    expect((await post({ text: DONE_WHEN_TSV, source: "An event" })).status).toBe(429);
    expect(limiter.isRateLimited).toHaveBeenLastCalledWith("tenant:ten_A", expect.objectContaining({ prefix: "paste_agent", burstLimit: 5, hourlyLimit: 30 }), expect.anything());
    expect(db.dump("agent_actions")).toHaveLength(0);
  });

  it("never takes consent, and says the route's words for a list it can't read", async () => {
    const consent = await post({ text: DONE_WHEN_TSV, source: "An event", agreed: { how: "in_person" } });
    expect(consent.status).toBe(400);
    expect(await consent.json()).toEqual({
      ok: false,
      error: "consent_not_allowed",
      message: "Nobody can be added as agreeing to emails from a pasted list. Record that on their page.",
    });
    expect((await post({ text: DONE_WHEN_TSV, source: "An event", consent: true })).status).toBe(400);
    expect(await (await post({ text: DONE_WHEN_TSV })).json()).toEqual({ ok: false, error: "source_needed", message: "Say where this list is from." });
    expect(await (await post({ text: DONE_WHEN_TSV, source: "An event", tenantId: "ten_B" })).json()).toMatchObject({ ok: false, error: "invalid_input" });
    expect(await (await post({ text: "jo@example.com\tJo", source: "An event" })).json()).toMatchObject({ ok: false, error: "no_header" });
    expect(db.dump("agent_actions")).toHaveLength(0);
  });

  it("reads the list into one card for the token's brand, with left out rows by number and no cell echoed", async () => {
    const res = await post({ text: DONE_WHEN_TSV, source: "An event" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      status: "ready",
      summary: "Read 14 rows: 10 people and 3 companies to add, 1 left out. Nobody is added until an admin opens the card and adds them. It waits in Review for 7 days.",
      counts: { read: 14, people: 10, companies: 3, left: 1, already: 0 },
      leftOut: [{ row: 15, reason: "no_contact", text: "Needs an email, a phone or a web address" }],
      card: {
        kind: "paste_batch",
        title: "Pasted list, ready to add",
        stats: [
          { label: "people", value: 10 },
          { label: "companies", value: 3 },
          { label: "left out", value: 1 },
        ],
        warnings: 0,
        note: "Nobody is added until an admin adds them. Everyone starts at Not yet for emails.",
        cta: "Open the list",
      },
    });
    expect(body.url).toMatch(/^\/admin\/crm\?paste=aa_[0-9a-f]{40}$/);
    expect(body.card.url).toBe(body.url);
    expect(body.card.id).toBe(body.id);
    const said = JSON.stringify(body);
    for (const row of DONE_WHEN_ROWS) for (const cell of row) if (cell) expect(said, cell).not.toContain(cell);
    // The brand is the token's, whatever the query says, and the card is Vizzy's.
    expect(db.dump("agent_actions")).toEqual([expect.objectContaining({ tenantId: "ten_A", agent: "vizzy", requestedBy: { type: "member", id: "u_admin" } })]);
    expect(db.dump("contacts")).toHaveLength(0);
  });

  it("names one person and one company in the singular, and leaves zero stats off the card", async () => {
    const res = await post({ text: "Email\tWebsite\njo@example.com\t\n\tnorthfield-ventures.test", source: "An event" });
    const body = await res.json();
    expect(body.card.stats).toEqual([
      { label: "person", value: 1 },
      { label: "company", value: 1 },
    ]);
    expect(body.card.warnings).toBe(0);
  });

  it("says so when there is nothing to add, saving nothing", async () => {
    const res = await post({ text: "Name,Email\nUna Nameonly,", source: "An event" });
    expect(await res.json()).toEqual({
      ok: true,
      status: "nothing_to_add",
      summary: "Nothing to add: every row is already here or was left out.",
      leftOut: [{ row: 2, reason: "no_contact", text: "Needs an email, a phone or a web address" }],
    });
    expect(db.dump("agent_actions")).toHaveLength(0);
  });
});
