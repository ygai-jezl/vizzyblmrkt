import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import type { Region } from "@/lib/types/tenant";
import { workScopeFor, type WorkDeps, type WorkScope } from "../scope";
import { LUMEN_EU, LUMEN_US, NINA, ORG, OTHER_ORG, SAM } from "./fixtures";

/**
 * A made-up world for Work's service tests, one fake database per region and a control plane:
 *
 * - Lumen (org_ten_lumen, owned by Nina) has Lumen Notes in the United States (New York time, a
 *   GitHub repo selected) and Lumen Europe in Europe (Berlin time, no repo). Sam is a member and
 *   Leo an admin of one brand each; neither owns the organisation.
 * - Fernhill Plants (org_ten_fernhill) is one brand in Europe (London time), with no owners, like
 *   the local seed: everyone there sees all of its Work. Priya is an admin, Rosa a member.
 * - Hearth Bakery is a brand in Asia with no organisation yet (plans off).
 *
 * No real people or brands.
 */

export const FERNHILL = "ten_fernhill";
export const HEARTH = "ten_hearth";
export const LEO = "uid_leo";
export const PRIYA = "uid_priya";
export const ROSA = "uid_rosa";
export const HAL = "uid_hal";
export const REPO = "Lumen-Example/notes-app";
export const T0 = "2026-11-20T09:00:00.000Z";

const person = (tenantId: string, region: Region, userId: string, role: "admin" | "member", email?: string): TenantContext => ({
  tenantId,
  region,
  source: "idtoken",
  userId,
  role,
  ...(email ? { email, emailVerified: true } : {}),
});

export const PEOPLE = {
  nina: person(LUMEN_US, "us", NINA, "admin", "nina@lumen.example"),
  ninaEu: person(LUMEN_EU, "eu", NINA, "admin", "nina@lumen.example"),
  sam: person(LUMEN_US, "us", SAM, "member", "sam@lumen.example"),
  leo: person(LUMEN_EU, "eu", LEO, "admin", "leo@lumen.example"),
  priya: person(FERNHILL, "eu", PRIYA, "admin", "priya@fernhill.example"),
  rosa: person(FERNHILL, "eu", ROSA, "member", "rosa@fernhill.example"),
  hal: person(HEARTH, "asia", HAL, "admin", "hal@hearth.example"),
};

export interface World {
  control: FakeFirestore;
  us: FakeFirestore;
  eu: FakeFirestore;
  asia: FakeFirestore;
  deps: WorkDeps;
  /** Move the clock. */
  at(iso: string): void;
  scope(ctx: TenantContext): Promise<WorkScope>;
  dbOf(region: Region): FakeFirestore;
}

export function makeWorld(now: string = T0): World {
  const control = new FakeFirestore();
  const us = new FakeFirestore();
  const eu = new FakeFirestore();
  const asia = new FakeFirestore();
  let clock = new Date(now);
  const dbOf = (r: Region) => (r === "eu" ? eu : r === "asia" ? asia : us);
  const deps: WorkDeps = { controlDb: control, regionDb: dbOf, now: () => clock, lookup: async (uids) => uids.map((uid) => ({ uid, displayName: uid.replace("uid_", "") })) };
  const tenant = (id: string, name: string, region: Region, timeZone: string, organisationId: string | null, extra: Record<string, unknown> = {}) =>
    control.seed("tenants", id, {
      tenantName: name,
      rootDomain: `${id.replace("ten_", "")}.example`,
      ownerId: NINA,
      status: "active",
      region,
      allowedOrigins: [],
      createdAt: T0,
      updatedAt: T0,
      timeZone,
      ...(organisationId ? { organisationId, orgPlan: "self_hosted" } : {}),
      ...extra,
    });
  const org = (id: string, name: string, brandIds: string[], ownerIds: string[]) =>
    control.seed("organisations", id, { name, plan: "self_hosted", planSince: T0, brandIds, ownerIds, createdBy: NINA, createdAt: T0, updatedAt: T0 });
  const repo = { fullPath: REPO, owner: "Lumen-Example", private: false, defaultBranch: "main", webUrl: `https://github.com/${REPO}` };
  tenant(LUMEN_US, "Lumen Notes", "us", "America/New_York", ORG, { gitConnections: { github: { provider: "github", kind: "app", installationId: 7, connectedAt: T0, repos: [repo] } } });
  tenant(LUMEN_EU, "Lumen Europe", "eu", "Europe/Berlin", ORG);
  tenant(FERNHILL, "Fernhill Plants", "eu", "Europe/London", OTHER_ORG);
  tenant(HEARTH, "Hearth Bakery", "asia", "Asia/Singapore", null);
  org(ORG, "Lumen", [LUMEN_US, LUMEN_EU], [NINA]);
  org(OTHER_ORG, "Fernhill Plants", [FERNHILL], []);
  for (const [uid, t] of [
    [NINA, LUMEN_US],
    [NINA, LUMEN_EU],
    [SAM, LUMEN_US],
    [LEO, LUMEN_EU],
    [PRIYA, FERNHILL],
    [ROSA, FERNHILL],
    [HAL, HEARTH],
  ] as const) {
    control.seed("tenant_users", `${uid}_${t}`, { userId: uid, tenantId: t, role: "admin", joinedAt: T0 });
  }
  return {
    control,
    us,
    eu,
    asia,
    deps,
    at: (iso) => {
      clock = new Date(iso);
    },
    scope: async (ctx) => {
      const r = await workScopeFor(ctx, deps);
      if (!r.ok) throw new Error(`no scope: ${r.why}`);
      return r.scope;
    },
    dbOf,
  };
}
