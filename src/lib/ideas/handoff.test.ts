import { describe, expect, it } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { handoffOptions, loadHandoff } from "./handoff";

const ctx: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const conn = (id: string, name: string, over: Record<string, unknown> = {}) => ({ id, name, kind: "custom" as const, status: "active" as const, environment: null, ...over });

describe("handoffOptions", () => {
  it("lists the brand's products first, each copy named, then sandboxes labelled Sandbox, and no revoked one", () => {
    const options = handoffOptions([
      conn("pcn_sb", "Test app", { kind: "sandbox" }),
      conn("pcn_stg", "Lumen app", { environment: "staging" }),
      conn("pcn_prod", "Lumen app (production)"),
      conn("pcn_shop", "Online shop"),
      conn("pcn_old", "Old app", { status: "revoked" }),
      conn("pcn_sb_old", "Old sandbox", { kind: "sandbox", status: "revoked" }),
    ]);
    expect(options).toEqual([
      { id: "pcn_prod", name: "Lumen app", label: "Lumen app (Production)" },
      { id: "pcn_stg", name: "Lumen app", label: "Lumen app (Staging)" },
      { id: "pcn_shop", name: "Online shop", label: "Online shop" },
      { id: "pcn_sb", name: "Test app", label: "Test app (Sandbox)" },
    ]);
  });
});

describe("loadHandoff", () => {
  function world(): FakeFirestore {
    const db = new FakeFirestore();
    const seed = (id: string, data: Record<string, unknown>) => db.seed("product_connections", id, { tenantId: "ten_A", ...data });
    seed("pcn_app", conn("pcn_app", "Lumen app"));
    seed("pcn_shop", conn("pcn_shop", "Online shop"));
    seed("pcn_old", conn("pcn_old", "Old app", { status: "revoked" }));
    db.seed("product_connections", "pcn_theirs", { tenantId: "ten_B", ...conn("pcn_theirs", "Their app") });
    const wave = (id: string, connectionId: string, status: string, createdAt: string, campaignId = "team-spaces") =>
      db.seed("invite_waves", id, { tenantId: "ten_A", campaignId, connectionId, status, createdAt });
    wave("w1", "pcn_app", "sent", "2026-11-01T00:00:00.000Z");
    wave("w2", "pcn_shop", "sent", "2026-11-10T00:00:00.000Z");
    wave("w3", "pcn_app", "draft", "2026-11-20T00:00:00.000Z");
    wave("w4", "pcn_old", "sent", "2026-11-21T00:00:00.000Z");
    wave("w5", "pcn_app", "sent", "2026-11-22T00:00:00.000Z", "offline-mode");
    return db;
  }

  it("picks first the product the launch's latest sent wave went to, skipping drafts and revoked products", async () => {
    const h = await loadHandoff(ctx, "team-spaces", world());
    expect(h.options.map((o) => o.id)).toEqual(["pcn_app", "pcn_shop"]);
    expect(h).toMatchObject({ defaultId: "pcn_shop", fromWave: true });
    expect(h.names).toEqual({ pcn_app: "Lumen app", pcn_shop: "Online shop", pcn_old: "Old app" });
  });

  it("falls back to the first product when no wave went anywhere", async () => {
    expect(await loadHandoff(ctx, "calendar-sync", world())).toMatchObject({ defaultId: "pcn_app", fromWave: false });
    expect(await loadHandoff(ctx, "calendar-sync", new FakeFirestore())).toMatchObject({ options: [], defaultId: null, fromWave: false });
  });
});
