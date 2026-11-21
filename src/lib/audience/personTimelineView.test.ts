import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { setRecordFieldValues } from "@/lib/tenant";
import { InvalidCursorError } from "@/lib/ontology/timeline";
import { CONNECTION_ID, T0, TENANT_ID, ctx, seedUser, seedWorld } from "@/lib/lifecycle/testing/fixtures";
import { saveFieldListChange } from "./fieldList";
import { addPerson } from "./addPerson";
import { parseNewPerson } from "./newPerson";
import { personIdOf, syncPerson, syncProductLink } from "./personSync";
import { loadPersonTimeline, type TimelineEntry } from "./personTimelineView";

/** Made-up people at .test, with a launch, a product, a field and a voice chat. */

const MIN = 60_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const PLAN = "fld_000000000001";
const STARTER = "opt_00000001";
const PRO = "opt_00000002";
const lookup = async (uids: string[]) => uids.map((uid) => ({ uid, displayName: "Alex Morgan" }));

beforeEach(() => {
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
  vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_TIMELINE_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

/** Priya: joined the Spring launch with a voice chat, got a launch email, then used the product and moved stage. */
async function world() {
  const db = new FakeFirestore();
  seedWorld(db);
  db.seed("tenant_users", "m1", { tenantId: TENANT_ID, userId: "usr_1", role: "admin" });
  db.seed("campaigns", "spring", { tenantId: TENANT_ID, waitlistName: "Spring launch" });
  db.seed("signups", "sig_priya", {
    tenantId: TENANT_ID,
    campaignId: "spring",
    email: "priya@customer.test",
    firstName: "Priya",
    status: "verified_active",
    verified: true,
    amountReferred: 0,
    referralToken: "r1",
    referralLink: "https://example.test/r/1",
    score: 0,
    createdAt: iso(T0),
    aiConversation: { completed: true, transcript: [{ role: "user", text: "Exports please" }], summary: "Wants exports", capturedAt: iso(T0 + MIN) },
  });
  db.seed("journeys", "j1", { tenantId: TENANT_ID, graph: { nodes: [{ id: "n1", type: "email", data: { subject: "Welcome to the Spring launch" } }], edges: [] } });
  db.seed("email_events", "ee1", { tenantId: TENANT_ID, signupId: "sig_priya", journeyId: "j1", nodeId: "n1", variantId: "a", campaignId: "spring", type: "send", ts: iso(T0 + 2 * MIN), createdAt: iso(T0 + 2 * MIN) });
  db.seed("email_events", "ee2", { tenantId: TENANT_ID, signupId: "sig_priya", journeyId: "j1", nodeId: "n1", variantId: "a", campaignId: "spring", type: "open", ts: iso(T0 + 3 * MIN), createdAt: iso(T0 + 3 * MIN) });
  await syncPerson(ctx, "priya@customer.test", { db, nowMs: T0 });
  const user = seedUser(db, "priya", { email: "priya@customer.test", emailNormalized: "priya@customer.test" });
  await syncPerson(ctx, "priya@customer.test", { db, nowMs: T0 + DAY });
  const connection = { id: CONNECTION_ID, ...(db.raw("product_connections", CONNECTION_ID) as object) } as Parameters<typeof syncProductLink>[1];
  await syncProductLink(ctx, connection, user, { db, nowMs: T0 + 3 * DAY });
  await saveFieldListChange(ctx, "person", { baseRev: 0, change: { op: "add", label: "Plan", type: "select", options: ["Starter", "Pro"] }, by: { type: "member", id: "usr_1" }, newFieldId: () => PLAN, newOptionId: (() => { let n = 0; return () => (n++ ? PRO : STARTER); })() }, db);
  const id = personIdOf(TENANT_ID, "priya@customer.test");
  const by = { type: "member", id: "usr_1" } as const;
  await setRecordFieldValues(ctx, { object: "person", recordId: id, changes: { [PLAN]: STARTER }, by, source: "editor", nowIso: iso(T0 + 4 * DAY) }, { db });
  await setRecordFieldValues(ctx, { object: "person", recordId: id, changes: { [PLAN]: PRO }, by, source: "editor", nowIso: iso(T0 + 5 * DAY) }, { db });
  return { db, id };
}

const texts = (entries: TimelineEntry[]) => entries.map((e) => e.text);

describe("loadPersonTimeline", () => {
  it("merges the event history with sign-ups, launch emails and voice chats, newest first", async () => {
    const { db, id } = await world();
    const page = (await loadPersonTimeline(ctx, id, { db, lookup }))!;
    expect(page.next).toBeNull();
    expect(texts(page.entries)).toEqual([
      "Plan changed from Starter to Pro",
      "Plan set to Starter",
      "Moved from New to Onboarding in Sandbox",
      "Started using Sandbox",
      'Opened "Welcome to the Spring launch"',
      "Voice chat on the Spring launch sign-up page",
      "Joined the Spring launch waitlist",
    ]);
    expect(page.entries[0]).toMatchObject({ kind: "field", detail: "By Alex Morgan", at: iso(T0 + 5 * DAY) });
    expect(page.entries.find((e) => e.kind === "voice_chat")).toMatchObject({ signupId: "sig_priya", at: iso(T0 + MIN) });
    expect(page.entries.find((e) => e.kind === "signup")).toMatchObject({ detail: "Confirmed their email" });
    // Joining the launch shows once, as the sign-up; the first stage comes with starting to use the product.
    expect(page.entries.filter((e) => e.text.includes("Spring launch") && e.kind === "launch")).toEqual([]);
  });

  it("pages through everything once, in order, whatever the page size", async () => {
    const { db, id } = await world();
    const all = texts((await loadPersonTimeline(ctx, id, { db, lookup }))!.entries);
    for (const limit of [1, 2, 3]) {
      const seen: TimelineEntry[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const page: Awaited<ReturnType<typeof loadPersonTimeline>> = await loadPersonTimeline(ctx, id, { db, lookup, limit, cursor });
        seen.push(...page!.entries);
        cursor = page!.next;
        if (!cursor) break;
      }
      expect(texts(seen), `limit ${limit}`).toEqual(all);
      expect(new Set(seen.map((e) => e.id)).size).toBe(seen.length);
    }
  });

  it("shows being added by hand and how they agreed, and nothing about anyone else", async () => {
    const { db } = await world();
    const sam = parseNewPerson({ email: "sam@labs.test", firstName: "Sam", agreed: { how: "in_person" }, via: "palette" });
    if (!sam.ok) throw new Error(sam.error);
    await addPerson(ctx, sam.value, { db, nowIso: iso(T0 + 6 * DAY) });
    const page = (await loadPersonTimeline(ctx, personIdOf(TENANT_ID, "sam@labs.test"), { db, lookup }))!;
    expect(page.entries.map((e) => [e.text, e.detail])).toEqual([
      ["Agreed to marketing emails", "Told me in person. Recorded by Alex Morgan"],
      ["Added by hand", "By Alex Morgan, from ⌘K"],
    ]);
    expect(await loadPersonTimeline({ ...ctx, tenantId: "ten_other" }, personIdOf(TENANT_ID, "sam@labs.test"), { db })).toBeNull();
  });

  it("refuses a cursor it didn't make, and finds nobody for an unknown person", async () => {
    const { db, id } = await world();
    await expect(loadPersonTimeline(ctx, id, { db, cursor: "bm90IGEgY3Vyc29y" })).rejects.toBeInstanceOf(InvalidCursorError);
    expect(await loadPersonTimeline(ctx, personIdOf(TENANT_ID, "nobody@customer.test"), { db })).toBeNull();
    expect(await loadPersonTimeline(ctx, "ct_not-an-id", { db })).toBeNull();
  });
});
