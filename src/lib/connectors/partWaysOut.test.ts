import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeOrganisationConnection, forTenant, type TenantContext } from "@/lib/tenant";
import { failingFirestore } from "@/lib/tenant/testing/failingFirestore";
import { getAgentAction } from "@/lib/ontology/agentActions";
import { isAgentActionId } from "@/lib/types/agentAction";
import { freshCollect } from "@/lib/types/dataConnection";
import { readableConnections } from "@/lib/search/query";
import { agentCollectedNumbers } from "./numbers";
import { agentNumberSuggestions } from "./signals/agentApi";
import { readSearchPlanning } from "./signals/planning";
import { planFromSignal, signalReviewItems } from "./signals/review";
import { addDays } from "./period";
import { LAST_DAY, search, seedSuggestion, writePlanning } from "./testing/signals";
import { brandDeps, OCN, ORG, OTHER_ORG, orgWorld, seedFernhill, seedPart, seedSource, seedTenant, US_BRAND, USE_US, type OrgWorld } from "./testing/organisation";

// Every way out of what a part collected (Connectors 2 pick 5) checks the part live (pick 9): once
// Fernhill US leaves Fernhill Group, its old Search Console part reads nothing anywhere, before the
// lane's erase. Every site, search and number is made up.
const CTX: TenantContext = { ...US_BRAND, source: "idtoken", userId: "usr_leo", role: "admin" };
const SITE = "sc-domain:fernhill-us.example";
const NOW = new Date("2026-11-23T10:00:00.000Z");
const vizzy = { kind: "agent" as const, agent: "vizzy" as const, forRole: "admin" as const };

let w: OrgWorld;
const db = () => w.us;
/** The brand's own database, with the control one and each region's for its part's source. */
const where = () => ({ db: w.us, controlDb: w.us, regionDb: w.regionDb });

beforeEach(async () => {
  for (const name of ["CONNECTORS_ENABLED", "PLANS_ENABLED", "CONNECTORS_SHARING_ENABLED", "CONNECTORS_COLLECT_ENABLED", "CONNECTORS_CHAT_ENABLED", "CONNECTOR_SIGNALS_ENABLED", "CONNECTORS_SEARCH_TEXT_ENABLED", "CONNECTOR_SEARCH_CONSOLE_ENABLED"]) {
    vi.stubEnv(name, "true");
  }
  w = orgWorld();
  seedFernhill(w);
  const source = await seedSource(w, {
    connectorId: "search-console",
    method: "share_access",
    label: "Search Console",
    serviceAccount: { email: "ygc-aaaaaaaaaaaaaaaaaaaa@made-up-identities.iam.gserviceaccount.com", uniqueId: "1001", createdAt: "2026-11-01T00:00:00.000Z", deletedAt: null },
  });
  await seedPart(w, source, US_BRAND, {
    useId: USE_US,
    account: SITE,
    connectorId: "search-console",
    method: "share_access",
    collect: { ...freshCollect(null, 0), lastDay: LAST_DAY, finalThrough: LAST_DAY, backfilledTo: addDays(LAST_DAY, -89), filled: true, timeZone: "America/Los_Angeles", rolledOn: "2026-11-23" },
  });
  // The brand record and everything it collected are in the brand's own region, the United States.
  await writePlanning(CTX, db(), USE_US, "question", [search("how often to water monstera", 1900, 40, 8.6)], { account: SITE });
  await seedSuggestion(CTX, db(), USE_US, "losing", { account: SITE });
});
afterEach(() => vi.unstubAllEnvs());

const leave = () => seedTenant(w, US_BRAND, OTHER_ORG);
const services = () => ({ ...brandDeps(w, US_BRAND), now: NOW });

describe("every way out checks the part live", () => {
  it("Review's suggestions and Vizzy's list of them", async () => {
    expect(await signalReviewItems(CTX, { ...where(), now: NOW })).toHaveLength(1);
    expect(((await agentNumberSuggestions(CTX, vizzy, {}, { ...where(), now: NOW })).body as { suggestions: unknown[] }).suggestions).toHaveLength(1);
    leave();
    expect(await signalReviewItems(CTX, { ...where(), now: NOW })).toEqual([]);
    expect(((await agentNumberSuggestions(CTX, vizzy, {}, { ...where(), now: NOW })).body as { suggestions: unknown[] }).suggestions).toEqual([]);
  });

  it("planning: Next up and the context pack", async () => {
    expect((await readSearchPlanning(CTX, where()))?.sites.map((s) => s.connectionId)).toEqual([USE_US]);
    leave();
    expect((await readSearchPlanning(CTX, where()))?.sites).toEqual([]);
  });

  it("brand search", async () => {
    const viewer = { role: "admin" as const, uid: "usr_leo" };
    expect([...(await readableConnections(CTX, viewer, [USE_US], where()))]).toEqual([USE_US]);
    leave();
    expect([...(await readableConnections(CTX, viewer, [USE_US], where()))]).toEqual([]);
  });

  it("the numbers route", async () => {
    const ask = { connectionId: USE_US, stream: "search_performance", by: "day", period: "last_28_days" };
    expect((await agentCollectedNumbers(CTX, vizzy, ask, services())).status).not.toBe(409);
    leave();
    expect(await agentCollectedNumbers(CTX, vizzy, ask, services())).toMatchObject({ status: 409, body: { error: "part_ended" } });
  });

  it("a part taken back, or pending, reads nothing either; sharing off reads nothing and ends nothing", async () => {
    await changeOrganisationConnection(ORG, OCN, "eu", (cur) => ({ patch: { parts: cur.parts.map((p) => ({ ...p, state: "pending" as const })) }, activity: [] }), { regionDb: w.regionDb });
    expect(await signalReviewItems(CTX, { ...where(), now: NOW })).toEqual([]);
    await changeOrganisationConnection(ORG, OCN, "eu", (cur) => ({ patch: { parts: cur.parts.map((p) => ({ ...p, state: "active" as const })) }, activity: [] }), { regionDb: w.regionDb });
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "false");
    expect(await signalReviewItems(CTX, { ...where(), now: NOW })).toEqual([]);
    expect((await readSearchPlanning(CTX, where()))?.sites).toEqual([]);
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
    expect(await signalReviewItems(CTX, { ...where(), now: NOW })).toHaveLength(1);
  });

  it("Plan an article: a part partLive refuses answers not_found and stays proposed, a live one plans", async () => {
    await forTenant(CTX, db()).workspaces.create("ws_care", { name: "Plant care", createdAt: NOW.toISOString() } as never);
    const { signalId, actionId } = await seedSuggestion(CTX, db(), USE_US, "rising", { account: SITE, now: new Date(NOW.getTime() + 1000) });
    const plan = () => planFromSignal(CTX, signalId, {}, { ...where(), now: NOW, loadTenant: async () => null });
    const state = async () => (isAgentActionId(actionId) ? (await getAgentAction(CTX, actionId, { db: db() }))?.state : null);
    const setParts = (to: "pending" | "active") =>
      changeOrganisationConnection(ORG, OCN, "eu", (cur) => ({ patch: { parts: cur.parts.map((p) => ({ ...p, state: to })) }, activity: [] }), { regionDb: w.regionDb });
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "false");
    expect(await plan()).toEqual({ ok: false, error: "not_found" });
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "true");
    await setParts("pending");
    expect(await plan()).toEqual({ ok: false, error: "not_found" });
    await setParts("active");
    leave();
    expect(await plan()).toEqual({ ok: false, error: "not_found" });
    expect(await state()).toBe("proposed");
    seedTenant(w, US_BRAND, ORG);
    // A read behind partLive failing hides the part too, but it isn't gone: the person is asked to try again.
    const down = { ...where(), controlDb: failingFirestore(w.us, { collections: ["tenants"] }) };
    expect(await planFromSignal(CTX, signalId, {}, { ...down, now: NOW, loadTenant: async () => null })).toEqual({ ok: false, error: "busy" });
    expect(await state()).toBe("proposed");
    expect(await plan()).toEqual({ ok: true, value: { href: "/admin/workspace/ws_care/create?numbers=search&text=pet%20safe%20hanging%20plants" } });
    expect(await state()).toBe("acted");
  });
});
