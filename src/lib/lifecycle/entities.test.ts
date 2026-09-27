import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import type { ProductEntity } from "@/lib/types/productUser";
import { JourneyAboutSchema, type JourneyAbout } from "@/lib/types/lifecycle";
import { activationAt } from "@/lib/connect/profile";
import {
  digestRows,
  entitiesField,
  entitiesFor,
  entityActivationAt,
  enrolTargets,
  entityViewFor,
  focusOf,
  pickEntity,
  stepsFor,
  viewedUser,
} from "./entities";
import { enrolOnEvents, enrolmentIdFor } from "./enrol";
import { processEnrolment } from "./runner";
import { CONNECTION_ID, STEPS, T0, contextStub, publishOnboarding, seedUser, seedWorld, sendStub, system } from "./testing/fixtures";

const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const brandSteps = STEPS.map((s) => ({ ...s, kind: "brand" }));
const catalog = {
  onboardingSteps: brandSteps,
  facts: [{ id: "sov", label: "Share of voice", type: "number" as const, unit: "%", description: "", source: "", kind: "brand" }],
  entityKinds: [{ kind: "brand", label: "brand", plural: "brands", parent: "workspace", multiple: true, description: "" }],
};
const about = (over: Partial<JourneyAbout> = {}): JourneyAbout => JourneyAboutSchema.parse({ mode: "one", kind: "brand", ...over });
const entity = (over: Partial<ProductEntity> = {}): ProductEntity => ({
  kind: "brand",
  name: null,
  parentId: null,
  role: "owner",
  steps: {},
  facts: {},
  activeAt: null,
  firstSeenAt: iso(T0),
  updatedAt: iso(T0),
  ...over,
});
const done = (...ids: string[]) => Object.fromEntries(ids.map((id, i) => [id, { doneAt: iso(T0 + i * HOUR) }]));

describe("which entity an email is about", () => {
  const user = {
    entities: {
      acme: entity({ name: "Acme", steps: done("create_brand", "run_audit"), facts: { sov: { value: 12, at: iso(T0) } } }),
      beta: entity({ name: "Beta", activeAt: iso(T0 + 5 * HOUR), facts: { sov: { value: 30, at: iso(T0) } } }),
      joined: entity({ name: "Their client", role: "member", steps: done("create_brand", "run_audit", "monitor_prompts") }),
      site: entity({ kind: "site", name: "acme.com" }),
    },
  };

  it("counts only what they own, of the journey's kind, unless it includes joined ones", () => {
    expect(entitiesFor(user, about()).map((x) => x.id)).toEqual(["acme", "beta"]);
    expect(entitiesFor(user, about({ includeJoined: true })).map((x) => x.id)).toEqual(["acme", "beta", "joined"]);
    expect(entitiesFor(user, about({ kind: null })).map((x) => x.id)).toEqual(["acme", "beta", "site"]);
  });

  it("focus: the one furthest along — and a finished one first, which ends onboarding", () => {
    expect(focusOf(entitiesFor(user, about()), catalog)?.id).toBe("acme");
    const finished = { entities: { ...user.entities, beta: entity({ name: "Beta", steps: done("create_brand", "run_audit", "monitor_prompts") }) } };
    expect(focusOf(entitiesFor(finished, about()), catalog)?.id).toBe("beta");
    const tie = { entities: { a: entity({ activeAt: iso(T0) }), b: entity({ activeAt: iso(T0 + HOUR) }) } };
    expect(focusOf(entitiesFor(tie, about()), catalog)?.id).toBe("b"); // equal progress: the most recent
  });

  it("every other rule keeps its first choice; focus is re-read", () => {
    expect(pickEntity(user, about({ pick: "recent" }), catalog)?.id).toBe("beta");
    expect(pickEntity(user, about({ pick: "fact_high", fact: "sov" }), catalog)?.id).toBe("beta");
    expect(pickEntity(user, about({ pick: "fact_low", fact: "sov" }), catalog)?.id).toBe("acme");
    expect(pickEntity(user, about({ pick: "trigger" }), catalog, { triggerId: "beta" })?.id).toBe("beta");
    expect(pickEntity(user, about({ pick: "recent" }), catalog, { pinned: "acme" })?.id).toBe("acme");
    expect(pickEntity(user, about({ pick: "focus" }), catalog, { pinned: "beta" })?.id).toBe("acme");
    expect(pickEntity(user, about({ pick: "recent" }), catalog, { pinned: "gone" })?.id).toBe("beta"); // re-picked
    expect(pickEntity({ entities: {} }, about(), catalog)).toBeNull();
  });

  it("views the person through it: its steps (and, about one, its facts) on top of theirs", () => {
    const view = entityViewFor(user, about(), catalog);
    const seen = viewedUser({ steps: {}, facts: { plan_seats: { value: 3, at: iso(T0) } } }, view);
    expect(Object.keys(seen.steps)).toEqual(["create_brand", "run_audit"]);
    expect(seen.facts).toMatchObject({ plan_seats: { value: 3 }, sov: { value: 12 } });
    // About the person: the checklist follows the onboarding focus, the facts stay theirs.
    const person = entityViewFor(user, about({ mode: "person", kind: null }), catalog);
    expect(person.entity).toBeNull();
    expect(person.onboarding?.id).toBe("acme");
    expect(viewedUser({ steps: {}, facts: {} }, person).facts).toEqual({});
  });

  it("answers entities.* conditions, and unknown when there's nothing to read", () => {
    const list = entitiesFor(user, about());
    expect(entitiesField("count", list, catalog)).toBe(2);
    expect(entitiesField("finished", list, catalog)).toBe(0);
    expect(entitiesField("unfinished", list, catalog)).toBe(2);
    expect(entitiesField("any.step.run_audit", list, catalog)).toBe(true);
    expect(entitiesField("all.step.run_audit", list, catalog)).toBe(false);
    expect(entitiesField("min.fact.sov", list, catalog)).toBe(12);
    expect(entitiesField("max.fact.sov", list, catalog)).toBe(30);
    expect(entitiesField("min.fact.sov", [], catalog)).toBeUndefined();
  });

  it("lists them for a digest, capped, with progress and their facts", () => {
    const d = digestRows(entitiesFor(user, about()), catalog, 1);
    expect(d).toEqual({ rows: [{ name: "Beta", done: 0, total: 3, facts: [{ label: "Share of voice", value: "30%" }] }], more: 1 });
  });

  it("uses every step for a kind when the catalog marks none per entity", () => {
    expect(stepsFor("brand", { onboardingSteps: STEPS })).toHaveLength(3);
    expect(stepsFor("site", catalog)).toHaveLength(0);
  });

  it("enrols once per entity when the journey is about each; else once", () => {
    expect(enrolTargets(user, about({ mode: "each" }))).toEqual(["acme", "beta"]);
    expect(enrolTargets(user, about({ mode: "each" }), "beta")).toEqual(["beta"]);
    expect(enrolTargets(user, about({ mode: "each" }), "site")).toEqual([]);
    expect(enrolTargets(user, about({ pick: "trigger" }), "beta")).toEqual(["beta"]);
    expect(enrolTargets(user, about({ mode: "all" }))).toEqual([null]);
  });

  it("counts them activated once any brand they own is finished", () => {
    const finished = { entities: { acme: entity({ steps: done("create_brand", "run_audit", "monitor_prompts") }), beta: entity() } };
    expect(entityActivationAt(finished, catalog)).toBe(iso(T0 + 2 * HOUR));
    expect(entityActivationAt(user, catalog)).toBeNull(); // the joined one doesn't count
    expect(activationAt({ milestones: {}, steps: {}, entities: finished.entities }, brandSteps)).toBe(iso(T0 + 2 * HOUR));
    expect(activationAt({ milestones: {}, steps: {}, entities: user.entities }, brandSteps)).toBeNull();
  });
});

describe("journeys about entities, in the runner (CONNECT_ENTITIES_ENABLED)", () => {
  beforeEach(() => {
    process.env.CONNECT_ENTITIES_ENABLED = "true";
    process.env.EMAIL_LINK_ORIGIN = "https://mk.test";
    process.env.LIFECYCLE_MODE_CEILING = "live";
  });
  afterEach(() => {
    delete process.env.CONNECT_ENTITIES_ENABLED;
    delete process.env.EMAIL_LINK_ORIGIN;
    delete process.env.LIFECYCLE_MODE_CEILING;
  });

  async function world(journeyAbout: JourneyAbout, entities: Record<string, ProductEntity>) {
    const db = new FakeFirestore();
    seedWorld(db);
    await forTenant(system, db).productConnections.update(CONNECTION_ID, {
      catalog: { events: [], traits: [], onboardingSteps: brandSteps, facts: catalog.facts, glossary: [], entityKinds: catalog.entityKinds },
    });
    const user = seedUser(db, "alex", { entities });
    const { journey, version } = await publishOnboarding(db, {
      mode: "live",
      settings: { about: journeyAbout, trigger: { event: journeyAbout.mode === "each" ? "entity.created" : "user.signed_up", maxEventAgeHours: 72 } },
    });
    let now = T0;
    const sends = sendStub();
    const deps = { db, now: () => now, send: sends.send, fetchContext: contextStub(() => null).fetchContext };
    const run = (enrolmentId: string, at: number) => {
      now = at;
      return processEnrolment(system, enrolmentId, deps);
    };
    return { db, user, journey, version, sent: sends.sent, run };
  }

  it("about one brand (focus): the welcome's next step is the brand they're furthest along with", async () => {
    const w = await world(about(), { acme: entity({ name: "Acme", steps: done("create_brand", "run_audit") }), beta: entity({ name: "Beta" }) });
    await enrolOnEvents(system, { id: CONNECTION_ID, status: "active" }, [{ user: w.user, event: "user.signed_up", timestamp: iso(T0) }], { db: w.db, nowMs: T0 });
    const id = enrolmentIdFor(w.journey.id, w.user.id, about(), null);
    await w.run(id, T0);
    expect(await w.run(id, T0 + 15 * MIN)).toBe("sent");
    expect(w.sent[0]!.html).toContain("Monitor prompts →"); // Acme's next step, not "Add your brand"
  });

  it("about each brand: one enrolment per brand, at most one email a day, and a removed brand ends its own", async () => {
    const each = about({ mode: "each" });
    const w = await world(each, { acme: entity({ name: "Acme" }), beta: entity({ name: "Beta" }) });
    const events = ["acme", "beta"].map((entityId) => ({ user: w.user, event: "entity.created", timestamp: iso(T0), entityId }));
    expect(await enrolOnEvents(system, { id: CONNECTION_ID, status: "active" }, events, { db: w.db, nowMs: T0 })).toEqual({ enrolled: 2 });
    const [a, b] = ["acme", "beta"].map((e) => enrolmentIdFor(w.journey.id, w.user.id, each, e));
    const repo = forTenant(system, w.db).lifecycleEnrolments;
    expect(await repo.getById(a!)).toMatchObject({ entityId: "acme" });

    await w.run(a!, T0);
    await w.run(b!, T0);
    expect(await w.run(a!, T0 + 15 * MIN)).toBe("sent");
    await w.run(b!, T0 + 15 * MIN); // Beta's welcome waits: one email a day across them
    expect(w.sent).toHaveLength(1);
    expect((await repo.getById(b!))!.log.some((l) => l.detail === "entity_frequency_cap" || l.event === "entity_frequency_cap")).toBe(true);

    await forTenant(system, w.db).productUsers.update(w.user.id, { entities: { acme: entity({ name: "Acme" }) } });
    await w.run(b!, T0 + 2 * 24 * HOUR);
    expect(await repo.getById(b!)).toMatchObject({ status: "exited", stopReason: "entity_removed" });
  });

  it("with the flag off, a journey about entities runs about the person", async () => {
    delete process.env.CONNECT_ENTITIES_ENABLED;
    const w = await world(about(), { acme: entity({ name: "Acme", steps: done("create_brand", "run_audit") }) });
    await enrolOnEvents(system, { id: CONNECTION_ID, status: "active" }, [{ user: w.user, event: "user.signed_up", timestamp: iso(T0) }], { db: w.db, nowMs: T0 });
    const id = enrolmentIdFor(w.journey.id, w.user.id, about(), null);
    await w.run(id, T0);
    expect(await w.run(id, T0 + 15 * MIN)).toBe("sent");
    expect(w.sent[0]!.html).toContain("Add your brand →");
  });
});
