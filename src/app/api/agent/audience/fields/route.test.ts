import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Vizzy's two field routes (AUDIENCE_VIZZY_FIELDS_ENABLED): the canvas token names the brand.
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const listRoute = await import("./route");
const personRoute = await import("../people/[personId]/fields/route");
const { signCanvasContext } = await import("@/lib/canvas/auth");
const { __resetRateLimitState } = await import("@/lib/tenant/rateLimit");
const { saveFieldListChange } = await import("@/lib/audience/fieldList");
const { deterministicContactId } = await import("@/lib/crm/identifiers");

const ctx = { tenantId: "ten_A", region: "us", source: "agent", userId: "u_member", role: "member" } as const;
const PERSON = deterministicContactId("ten_A", "alex@example.com");
const SEATS = "fld_bbbbbbbbbbb1";
const NOTES = "fld_bbbbbbbbbbb2";
const TITLE = "fld_bbbbbbbbbbb3";

const req = (path: string, token?: string) => new Request(`https://app.example.com${path}`, { headers: token ? { "x-canvas-context": token } : {} });

beforeEach(async () => {
  __resetRateLimitState();
  const db = new FakeFirestore();
  store.db = db;
  for (const k of ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "AUDIENCE_VIZZY_FIELDS_ENABLED"]) vi.stubEnv(k, "true");
  vi.stubEnv("CANVAS_CONTEXT_SIGNING_KEY", "test-only-canvas-key");
  const by = { type: "member", id: "u_admin" } as const;
  await saveFieldListChange({ ...ctx, role: "admin" }, "person", { baseRev: 0, change: { op: "add", label: "Seats", type: "number" }, by, newFieldId: () => SEATS }, db);
  await saveFieldListChange({ ...ctx, role: "admin" }, "person", { baseRev: 1, change: { op: "add", label: "Notes", type: "text" }, by, newFieldId: () => NOTES }, db);
  await saveFieldListChange({ ...ctx, role: "admin" }, "person", { baseRev: 2, change: { op: "add", label: "Job Title", type: "text", vizzyReads: true }, by, newFieldId: () => TITLE }, db);
  db.seed("contacts", PERSON, {
    tenantId: "ten_A",
    contactKey: "alex@example.com",
    email: "alex@example.com",
    firstName: "Alex",
    lastName: "Morgan",
    fields: { [SEATS]: 4, [NOTES]: "Prefers calls", [TITLE]: `Head of Growth, reports to Alex Morgan (alex@example.com). ${"More detail. ".repeat(60)}` },
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/agent/audience/fields and /people/[personId]/fields", () => {
  it("answer 503 unavailable while the switch is off, and 401 without a token", async () => {
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "false");
    const off = await listRoute.GET(req("/api/agent/audience/fields", signCanvasContext(ctx)));
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: "unavailable" });
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "true");
    expect((await personRoute.GET(req(`/api/agent/audience/people/${PERSON}/fields`), { params: Promise.resolve({ personId: PERSON }) })).status).toBe(401);
  });

  it("serve anyone on the team the list and one person's safe values", async () => {
    const token = signCanvasContext(ctx);
    const list = await listRoute.GET(req("/api/agent/audience/fields", token));
    expect(list.status).toBe(200);
    expect((await list.json()).fields).toEqual([{ id: SEATS, label: "Seats", type: "number" }]);
    const one = await personRoute.GET(req(`/api/agent/audience/people/${PERSON}/fields`, token), { params: Promise.resolve({ personId: PERSON }) });
    expect(one.status).toBe(200);
    expect(one.headers.get("cache-control")).toBe("no-store");
    const body = await one.json();
    expect(body.fields).toEqual([{ id: SEATS, label: "Seats", type: "number", value: 4, text: "4" }]);
    expect(JSON.stringify(body)).not.toContain("Prefers calls");
    expect(JSON.stringify(body)).not.toContain("Head of Growth");
  });

  it("serve a text field an admin let Vizzy read while its switch is on, scrubbed and cut at 500 characters", async () => {
    vi.stubEnv("AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED", "true");
    const token = signCanvasContext(ctx);
    const list = await (await listRoute.GET(req("/api/agent/audience/fields", token))).json();
    expect(list.fields).toEqual([
      { id: SEATS, label: "Seats", type: "number" },
      { id: TITLE, label: "Job Title", type: "text" },
    ]);
    const body = await (await personRoute.GET(req(`/api/agent/audience/people/${PERSON}/fields`, token), { params: Promise.resolve({ personId: PERSON }) })).json();
    const title = body.fields.find((f: { id: string }) => f.id === TITLE);
    expect(title).toMatchObject({ type: "text", cut: true });
    expect(title.value).toHaveLength(500);
    expect(title.value.startsWith("Head of Growth, reports to [name] [name] ([email]). More detail.")).toBe(true);
    expect(title.text).toBe(title.value);
    // Notes, a text field nobody ticked, never goes; nor do their name and address.
    const text = JSON.stringify(body);
    for (const never of ["Prefers calls", "Alex", "Morgan", "alex@example.com"]) expect(text).not.toContain(never);

    vi.stubEnv("AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED", "false");
    const off = await (await personRoute.GET(req(`/api/agent/audience/people/${PERSON}/fields`, token), { params: Promise.resolve({ personId: PERSON }) })).json();
    expect(off.fields.map((f: { id: string }) => f.id)).toEqual([SEATS]);
  });
});
