import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { recordEmailEvent, emailEventId } from "./events";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { personIdForAddress } from "@/lib/ontology/personRef";

const ctx: TenantContext = { tenantId: "t1", region: "us", source: "system" };

const base = {
  campaignId: "c1",
  journeyId: "journey_c1",
  nodeId: "email1",
  signupId: "s1",
  variantId: "control",
  type: "open" as const,
  ts: "2026-06-20T00:00:00.000Z",
};

describe("recordEmailEvent", () => {
  it("records once and dedupes repeats (unique-per-recipient)", async () => {
    const db = new FakeFirestore();
    expect(await recordEmailEvent(ctx, base, db)).toBe("recorded");
    expect(await recordEmailEvent(ctx, base, db)).toBe("duplicate");
    expect(await recordEmailEvent(ctx, { ...base, ts: "later" }, db)).toBe("duplicate");
    expect(db.dump("email_events")).toHaveLength(1);
  });

  it("keys distinctly by type and variant", async () => {
    const db = new FakeFirestore();
    await recordEmailEvent(ctx, base, db);
    await recordEmailEvent(ctx, { ...base, type: "click" }, db);
    await recordEmailEvent(ctx, { ...base, variantId: "var_a" }, db);
    expect(db.dump("email_events")).toHaveLength(3);
  });

  it("emailEventId encodes journey/node/signup/variant/type", () => {
    expect(emailEventId(base)).toBe("evt:journey_c1:email1:s1:control:open");
  });
});

describe("the person on an email event (ONTOLOGY_PERSON_IDS_ENABLED)", () => {
  const PERSON = personIdForAddress("t1", "ada@example.com")!;
  beforeEach(() => {
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is written when given, and the id stays the same", async () => {
    const db = new FakeFirestore();
    await recordEmailEvent(ctx, { ...base, personId: PERSON }, db);
    expect(db.raw("email_events", emailEventId(base))).toMatchObject({ personId: PERSON, signupId: "s1" });
    expect(emailEventId({ ...base, personId: PERSON } as typeof base)).toBe("evt:journey_c1:email1:s1:control:open");
  });

  it("is absent when not given, or while the switch is off", async () => {
    const db = new FakeFirestore();
    await recordEmailEvent(ctx, { ...base, personId: null }, db);
    expect(db.raw("email_events", emailEventId(base))).not.toHaveProperty("personId");
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "false");
    await recordEmailEvent(ctx, { ...base, type: "click", personId: PERSON }, db);
    expect(db.raw("email_events", emailEventId({ ...base, type: "click" }))).not.toHaveProperty("personId");
  });
});
