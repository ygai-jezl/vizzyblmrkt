import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signCanvasContext } from "@/lib/canvas/auth";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";

// Vizzy's routes for the brand's profile: the switch, then the signed token (the brand and role
// come from it), then the role and input. The database is the in-memory fake behind every store.
const fake = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => fake.db,
}));
const limits = vi.hoisted(() => ({ isRateLimited: vi.fn(async () => false) }));
vi.mock("@/lib/tenant/rateLimit", () => limits);

const profile = await import("./route");
const conversation = await import("./conversations/[conversationId]/route");

const ADMIN: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const MEMBER: TenantContext = { ...ADMIN, userId: "usr_member", role: "member" };
const CONV = `oc_${"a".repeat(32)}`;
const GOOD = { kind: "goal", text: "A hundred sign-ups by spring", quote: "We'd love a hundred sign-ups by the spring." };

let db: FakeFirestore;
const call = (method: "GET" | "POST", path: string, ctx: TenantContext | null, body?: unknown) =>
  new Request(`https://app.example.com/api/agent/business-profile${path}`, {
    method,
    headers: { ...(ctx ? { "x-canvas-context": signCanvasContext(ctx) } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const readConversation = (ctx: TenantContext | null, id = CONV) => conversation.GET(call("GET", `/conversations/${id}`, ctx), { params: Promise.resolve({ conversationId: id }) });

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeFirestore();
  fake.db = db;
  db.seed("tenants", "ten_A", {
    tenantName: "Fernhill Plants",
    rootDomain: "fernhill.example",
    status: "active",
    region: "us",
    allowedOrigins: [],
    ownerId: "usr_owner",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    businessProfile: { status: "done", answers: { run: "shop" }, rev: 3, startedAt: "2026-11-25T09:00:00.000Z" },
  });
  db.seed("onboarding_conversations", CONV, { tenantId: "ten_A", source: "voice", status: "ended", startedAt: "2026-11-25T10:00:00.000Z", lengthSec: 60, turns: [{ who: "member", text: "We sell plants.", atSec: 3 }] });
  vi.stubEnv("ONBOARDING_ENABLED", "true");
  vi.stubEnv("CANVAS_CONTEXT_SIGNING_KEY", "test-only-canvas-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("/api/agent/business-profile", () => {
  it("503s every route with the switch off", async () => {
    vi.stubEnv("ONBOARDING_ENABLED", "false");
    for (const res of [await profile.GET(call("GET", "?view=chat", ADMIN)), await profile.POST(call("POST", "", ADMIN, GOOD)), await readConversation(ADMIN)]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unavailable" });
    }
  });

  it("401s every route without a signed token", async () => {
    for (const res of [await profile.GET(call("GET", "", null)), await profile.POST(call("POST", "", null, GOOD)), await readConversation(null)]) {
      expect(res.status).toBe(401);
    }
  });

  it("reads the chat view, the answers only for a member, never cached", async () => {
    const res = await profile.GET(call("GET", "?view=chat", MEMBER));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ rev: 3, brand: { name: "Fernhill Plants" }, answers: [{ q: "What you run", a: "A shop or products" }], facts: [], more: 0 });
  });

  it("reads the whole profile, with the conversations for an admin only", async () => {
    const admin = await (await profile.GET(call("GET", "", ADMIN))).json();
    expect(admin.conversations).toHaveLength(1);
    const member = await (await profile.GET(call("GET", "", MEMBER))).json();
    expect(member).not.toHaveProperty("conversations");
  });

  it("403s a member's suggestion and conversation read, and 400s bad input", async () => {
    const res = await profile.POST(call("POST", "", MEMBER, GOOD));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "admins_only" });
    expect((await readConversation(MEMBER)).status).toBe(403);
    expect((await profile.POST(call("POST", "", ADMIN, { ...GOOD, kind: "wish" }))).status).toBe(400);
    expect((await profile.POST(new Request("https://app.example.com/api/agent/business-profile", { method: "POST", headers: { "x-canvas-context": signCanvasContext(ADMIN) }, body: "not json" }))).status).toBe(400);
  });

  it("files a suggestion for an admin, and reads a conversation, never another brand's", async () => {
    const res = await profile.POST(call("POST", "", ADMIN, GOOD));
    expect(res.status).toBe(200);
    expect((await res.json()).card.url).toBe("/admin/account/settings#about");
    const read = await readConversation(ADMIN);
    expect(read.status).toBe(200);
    expect((await read.json()).turns).toEqual([{ who: "founder", text: "We sell plants." }]);
    expect((await readConversation({ ...ADMIN, tenantId: "ten_B" })).status).toBe(404);
    expect((await readConversation(ADMIN, "oc_bad")).status).toBe(404);
  });

  it("429s a busy brand's suggestion", async () => {
    limits.isRateLimited.mockResolvedValueOnce(true);
    expect((await profile.POST(call("POST", "", ADMIN, GOOD))).status).toBe(429);
  });
});
