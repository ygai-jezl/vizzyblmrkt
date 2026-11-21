import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { moveRecordFieldValues, setRecordFieldValues } from "@/lib/tenant";
import { InvalidCursorError } from "@/lib/ontology/timeline";
import { CONNECTION_ID, T0, TENANT_ID, ctx, seedUser, seedWorld } from "@/lib/lifecycle/testing/fixtures";
import { saveFieldListChange } from "./fieldList";
import { addPerson, withdrawHandConsent } from "./addPerson";
import { decideFieldSuggestion, suggestFieldChanges } from "./fieldSuggestions";
import { parseNewPerson } from "./newPerson";
import { personIdOf, syncPerson, syncProductLink } from "./personSync";
import { expireAgentActions } from "@/lib/tenant";
import { compareTimelineEntries, FIELD_MOVED_DETAIL, loadPersonTimeline, TIMELINE_KIND_ORDER, type TimelineEntry } from "./personTimelineView";

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

  it("shows each sign-up, email and voice chat once when a whole page of events can't be read", async () => {
    const { db, id } = await world();
    const all = texts((await loadPersonTimeline(ctx, id, { db, lookup }))!.entries);
    // The two newest rows are unreadable (no kind): the first page of two holds nothing but them.
    for (const [n, day] of [[1, 6], [2, 7]] as const) {
      db.seed("ontology_events", `ev_${String(n).repeat(40)}`, { tenantId: TENANT_ID, personId: id, at: iso(T0 + day * DAY) });
    }
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = (await loadPersonTimeline(ctx, id, { db, lookup, limit: 2 }))!;
    expect(first.entries).toEqual([]);
    expect(first.next).not.toBeNull();
    const seen: TimelineEntry[] = [];
    let cursor: string | null = first.next;
    for (let i = 0; i < 20 && cursor; i++) {
      const page: Awaited<ReturnType<typeof loadPersonTimeline>> = await loadPersonTimeline(ctx, id, { db, lookup, limit: 2, cursor });
      seen.push(...page!.entries);
      cursor = page!.next;
    }
    expect(texts(seen)).toEqual(all);
  });

  it("shows being added by hand and how they agreed, and nothing about anyone else", async () => {
    const { db } = await world();
    const sam = parseNewPerson({ email: "sam@labs.test", firstName: "Sam", agreed: { how: "in_person" }, via: "palette" });
    if (!sam.ok) throw new Error(sam.error);
    await addPerson(ctx, sam.value, { db, nowIso: iso(T0 + 6 * DAY) });
    const page = (await loadPersonTimeline(ctx, personIdOf(TENANT_ID, "sam@labs.test"), { db, lookup }))!;
    // Both at the same moment: being added comes first, whatever their ids.
    expect(page.entries.map((e) => [e.text, e.detail])).toEqual([
      ["Added by hand", "By Alex Morgan, from ⌘K"],
      ["Agreed to marketing emails", "Told me in person. Recorded by Alex Morgan"],
    ]);
    expect(await loadPersonTimeline({ ...ctx, tenantId: "ten_other" }, personIdOf(TENANT_ID, "sam@labs.test"), { db })).toBeNull();
  });

  it("shows a withdrawal, with who recorded it and their note", async () => {
    const { db } = await world();
    const sam = parseNewPerson({ email: "sam@labs.test", agreed: { how: "in_person" } });
    if (!sam.ok) throw new Error(sam.error);
    await addPerson(ctx, sam.value, { db, nowIso: iso(T0 + 6 * DAY) });
    const id = personIdOf(TENANT_ID, "sam@labs.test");
    await withdrawHandConsent(ctx, id, { note: "Asked us to stop" }, { db, nowIso: iso(T0 + 7 * DAY) });
    const page = (await loadPersonTimeline(ctx, id, { db, lookup }))!;
    expect(page.entries.map((e) => [e.text, e.detail])).toEqual([
      ["Withdrew from marketing emails", "Asked us to stop. Recorded by Alex Morgan"],
      ["Added by hand", "By Alex Morgan"],
      ["Agreed to marketing emails", "Told me in person. Recorded by Alex Morgan"],
    ]);
  });

  it("says who confirmed Vizzy's suggestion and who undid it", async () => {
    const { db, id } = await world();
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "true");
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "true");
    const s = await suggestFieldChanges({ ...ctx, source: "agent", userId: "usr_1", role: "admin" }, { personId: id, changes: { [PLAN]: STARTER } }, { db, nowMs: T0 + 6 * DAY });
    if (!s.ok) throw new Error(s.error);
    const admin = { ...ctx, userId: "usr_1", role: "admin" as const };
    expect(await decideFieldSuggestion(admin, id, { id: s.action.id, rev: s.action.rev, decision: "confirm" }, { db, nowMs: T0 + 7 * DAY })).toEqual({ ok: true, state: "acted" });
    expect(await decideFieldSuggestion(admin, id, { id: s.action.id, rev: s.action.rev + 2, decision: "undo" }, { db, nowMs: T0 + 8 * DAY })).toEqual({ ok: true, state: "undone" });
    const page = (await loadPersonTimeline(ctx, id, { db, lookup, nowMs: T0 + 8 * DAY }))!;
    const pairs = page.entries.map((e) => [e.text, e.detail]);
    // The undo and its value change share a moment: the suggestion's step comes first.
    expect(pairs.slice(0, 4)).toEqual([
      ["A change was undone", "By Alex Morgan"],
      ["Plan changed from Starter to Pro", "Alex Morgan undid Vizzy's suggestion"],
      ["Plan changed from Pro to Starter", "Alex Morgan confirmed Vizzy's suggestion"],
      // Decided, so it says what came of it, not that it is waiting.
      ["Vizzy suggested a change", "Confirmed, then undone by Alex Morgan"],
    ]);
  });

  it("says a suggestion is waiting only until someone decides it", async () => {
    const { db, id } = await world();
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "true");
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "true");
    const agent = { ...ctx, source: "agent" as const, userId: "usr_1", role: "admin" as const };
    const admin = { ...ctx, userId: "usr_1", role: "admin" as const };
    const suggestion = () => loadPersonTimeline(ctx, id, { db, lookup, nowMs: T0 + 7 * DAY }).then((p) => p!.entries.find((e) => e.text === "Vizzy suggested a change")!.detail);

    const s = await suggestFieldChanges(agent, { personId: id, changes: { [PLAN]: STARTER } }, { db, nowMs: T0 + 6 * DAY });
    if (!s.ok) throw new Error(s.error);
    expect(await suggestion()).toBe("Nothing changes until someone confirms");

    expect(await decideFieldSuggestion(admin, id, { id: s.action.id, rev: s.action.rev, decision: "confirm" }, { db, nowMs: T0 + 7 * DAY })).toEqual({ ok: true, state: "acted" });
    expect(await suggestion()).toBe("Confirmed by Alex Morgan");
  });

  it("says a suggestion was dismissed, or expired, once it was", async () => {
    const { db, id } = await world();
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "true");
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "true");
    const agent = { ...ctx, source: "agent" as const, userId: "usr_1", role: "admin" as const };
    const admin = { ...ctx, userId: "usr_1", role: "admin" as const };
    const s = await suggestFieldChanges(agent, { personId: id, changes: { [PLAN]: STARTER } }, { db, nowMs: T0 + 6 * DAY });
    if (!s.ok) throw new Error(s.error);
    expect(await decideFieldSuggestion(admin, id, { id: s.action.id, rev: s.action.rev, decision: "dismiss" }, { db, nowMs: T0 + 7 * DAY })).toMatchObject({ ok: true });
    const dismissed = (await loadPersonTimeline(ctx, id, { db, lookup, nowMs: T0 + 7 * DAY }))!.entries.find((e) => e.text === "Vizzy suggested a change");
    expect(dismissed?.detail).toBe("Dismissed by Alex Morgan");

    const { db: db2, id: id2 } = await world();
    const t = await suggestFieldChanges(agent, { personId: id2, changes: { [PLAN]: STARTER } }, { db: db2, nowMs: T0 + 6 * DAY });
    if (!t.ok) throw new Error(t.error);
    const later = T0 + 60 * DAY;
    // Past its expiry before the sweep runs, and after it.
    const before = (await loadPersonTimeline(ctx, id2, { db: db2, lookup, nowMs: later }))!.entries.find((e) => e.text === "Vizzy suggested a change");
    expect(before?.detail).toBe("Expired before anyone decided");
    await expireAgentActions(ctx, { now: new Date(later).toISOString(), db: db2 });
    const after = (await loadPersonTimeline(ctx, id2, { db: db2, lookup, nowMs: later }))!.entries.find((e) => e.text === "Vizzy suggested a change");
    expect(after?.detail).toBe("Expired before anyone decided");
    for (const e of [dismissed, before, after]) expect(e?.detail).not.toContain("Nothing changes");
  });

  it("orders entries at the same moment by a fixed kind order, then id", () => {
    const at = iso(T0);
    const entry = (kind: TimelineEntry["kind"], id: string): TimelineEntry => ({ id, at, kind, text: kind, detail: null });
    const shuffled = [entry("email", "a"), entry("consent", "z"), entry("created", "a"), entry("field", "b"), entry("field", "c"), { ...entry("signup", "a"), at: iso(T0 + 1) }];
    expect(shuffled.sort(compareTimelineEntries).map((e) => `${e.kind}:${e.id}`)).toEqual(["signup:a", "created:a", "consent:z", "field:c", "field:b", "email:a"]);
    expect(TIMELINE_KIND_ORDER.indexOf("created")).toBeLessThan(TIMELINE_KIND_ORDER.indexOf("consent"));
    expect(new Set(TIMELINE_KIND_ORDER).size).toBe(11);
  });

  it("shows a value that came with them from their earlier record, and not its clearing there", async () => {
    const { db, id } = await world();
    const SEATS = "fld_000000000002";
    await saveFieldListChange(ctx, "person", { baseRev: 1, change: { op: "add", label: "Seats", type: "number" }, by: { type: "member", id: "usr_1" }, newFieldId: () => SEATS }, db);
    const former = personIdOf(TENANT_ID, "priya@old.customer.test");
    db.seed("contacts", former, { tenantId: TENANT_ID, contactKey: "priya@old.customer.test", memberOf: [], fields: { [SEATS]: 4, [PLAN]: STARTER } });
    expect(await moveRecordFieldValues(ctx, { from: former, to: id, nowIso: iso(T0 + 6 * DAY) }, { db })).toMatchObject({ moved: [SEATS], kept: [PLAN] });
    // A merge brings the old record's rows here too: its clearing still isn't shown.
    const formerRows = [...db.cols.get("ontology_events")!.entries()].filter(([, e]) => e.personId === former);
    expect(formerRows).toHaveLength(1);
    for (const [rowId, row] of formerRows) db.seed("ontology_events", rowId, { ...row, personId: id });
    const page = (await loadPersonTimeline(ctx, id, { db, lookup }))!;
    expect(page.entries[0]).toMatchObject({ text: "Seats set to 4", detail: FIELD_MOVED_DETAIL, kind: "field" });
    expect(texts(page.entries).filter((t) => t.startsWith("Seats"))).toEqual(["Seats set to 4"]);
  });

  it("refuses a cursor it didn't make, and finds nobody for an unknown person", async () => {
    const { db, id } = await world();
    await expect(loadPersonTimeline(ctx, id, { db, cursor: "bm90IGEgY3Vyc29y" })).rejects.toBeInstanceOf(InvalidCursorError);
    expect(await loadPersonTimeline(ctx, personIdOf(TENANT_ID, "nobody@customer.test"), { db })).toBeNull();
    expect(await loadPersonTimeline(ctx, "ct_not-an-id", { db })).toBeNull();
  });
});
