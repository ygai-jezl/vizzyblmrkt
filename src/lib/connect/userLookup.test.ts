import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { suppressEmail } from "@/lib/email/suppression";
import { ctx, publishOnboarding, seedWorld, T0 } from "@/lib/lifecycle/testing/fixtures";
import { createConnection } from "./keys";
import { SANDBOX_CATALOG } from "./sandbox";
import { deleteUser, patchUser } from "./v2/users";
import { lookupConnectionUser } from "./adminApi";

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});
afterEach(() => {
  delete process.env.LIFECYCLE_ENABLED;
});

async function world() {
  process.env.LIFECYCLE_ENABLED = "true";
  const db = new FakeFirestore();
  seedWorld(db);
  const { connection } = await createConnection(ctx, { name: "Acme", kind: "custom", catalog: SANDBOX_CATALOG }, db);
  const { journey } = await publishOnboarding(db, { mode: "live", connectionId: connection.id });
  const lookup = (userId: string, as: TenantContext = ctx) => lookupConnectionUser(as, connection.id, userId, db);
  return { db, connection, journey, lookup };
}

describe("looking a user up by the product's own id (Users tab)", () => {
  it("shows the state, the consent YouGrow applies, journeys by name, opt-outs and the latest writes first", async () => {
    const w = await world();
    const signup = { email: "alex@gmail.com", firstName: "Alex", timezone: "Europe/London", signedUpAt: new Date(T0).toISOString(), consent: "corporate_subscriber" as const };
    await patchUser(ctx, w.connection, "alex", signup, { db: w.db, nowMs: T0 + 60_000 });
    await patchUser(ctx, w.connection, "alex", { subscribed: false }, { db: w.db, nowMs: T0 + 120_000 });
    await suppressEmail(ctx, { email: "alex@gmail.com", reason: "unsubscribe", source: "footer" }, w.db);

    const r = await w.lookup("alex");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      found: true,
      user: {
        userId: "alex",
        email: "alex@gmail.com",
        timezone: "Europe/London",
        signedUpAt: new Date(T0).toISOString(),
        consent: "corporate_subscriber",
        subscribed: false,
        excluded: null,
        enrolments: [{ journeyId: w.journey.id, journeyName: "Onboarding" }],
        optOuts: [{ scope: "all" }],
      },
      effectiveConsent: "none", // corporate_subscriber doesn't count for a free-mail address
    });
    expect((r.body as { user: { entities: unknown } }).user.entities).toEqual({});
    const writes = (r.body as { writes: Array<{ payload: Record<string, unknown>; applied: boolean }> }).writes;
    expect(writes.map((x) => x.payload)).toEqual([{ subscribed: false }, signup]);
  });

  it("says when someone was erased, and when YouGrow doesn't hold the id", async () => {
    const w = await world();
    await patchUser(ctx, w.connection, "sam", { email: "sam@example.com" }, { db: w.db, nowMs: T0 });
    await deleteUser(ctx, w.connection, "sam", { db: w.db, nowMs: T0 + 1000 });
    expect((await w.lookup("sam")).body).toEqual({ found: false, erasedAt: new Date(T0 + 1000).toISOString() });
    expect((await w.lookup("Sam")).body).toEqual({ found: false }); // ids are case-sensitive
  });

  it("refuses an empty id, and another tenant can't look into the connection", async () => {
    const w = await world();
    await patchUser(ctx, w.connection, "alex", { email: "alex@example.com" }, { db: w.db, nowMs: T0 });
    expect((await w.lookup("  ")).status).toBe(400);
    expect((await w.lookup("alex", { tenantId: "ten_other", region: "us", source: "system" })).status).toBe(404);
  });
});
