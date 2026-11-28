import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Download data: an admin gets the deck and its kept versions as a JSON file.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()), getDb: () => store.db }));

const { GET } = await import("./route");
const { createRaiseDoc } = await import("@/lib/raise/docs/store");
const { preSeedSlides } = await import("@/lib/raise/docs/testing/fixtures");

const admin = { tenantId: "ten_acme", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" } as const;
const at = (docId: string) => ({ params: Promise.resolve({ docId }) });
const req = () => new Request("http://localhost/x");

let id: string;
beforeEach(async () => {
  vi.clearAllMocks();
  const db = new FakeFirestore();
  store.db = db;
  vi.stubEnv("RAISE_KIT_ENABLED", "true");
  session.getAdminContext.mockResolvedValue(admin);
  const made = await createRaiseDoc(admin, { audience: "lender", stage: "loan", title: "Fernhill stock loan", slides: preSeedSlides().slice(0, 5), sources: [], outline: "lender_loan", by: "vizzy", note: "First draft by Vizzy." }, { db });
  if (!made.ok) throw new Error(made.error);
  id = made.value.id;
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/admin/raise/docs/[docId]/export", () => {
  it("sends the deck as a file to an admin", async () => {
    const res = await GET(req(), at(id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="raise-deck-${id}.json"`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.deck).toMatchObject({ id, title: "Fernhill stock loan", audience: "lender", version: 1 });
    expect(body.deck.versions).toHaveLength(1);
  });

  it("is off with the switch, admins only, and 404s another brand's deck", async () => {
    vi.stubEnv("RAISE_KIT_ENABLED", "false");
    expect((await GET(req(), at(id))).status).toBe(503);
    vi.stubEnv("RAISE_KIT_ENABLED", "true");
    session.getAdminContext.mockResolvedValue({ ...admin, role: "member" });
    expect((await GET(req(), at(id))).status).toBe(403);
    session.getAdminContext.mockResolvedValue({ ...admin, tenantId: "ten_fernhill" });
    expect((await GET(req(), at(id))).status).toBe(404);
  });
});
