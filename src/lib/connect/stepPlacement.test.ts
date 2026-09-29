import { describe, expect, it } from "vitest";
import type { ProductEntity } from "@/lib/types/productUser";
import { applyStepMove, stepPlacement } from "./stepPlacement";

const at = { doneAt: "2026-09-29T10:00:00.000Z" };
const steps = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, at]));
const brand = (...ids: string[]): ProductEntity => ({
  kind: "brand", name: null, parentId: null, role: "owner", steps: steps(...ids), facts: {}, activeAt: null,
  firstSeenAt: at.doneAt, updatedAt: at.doneAt,
});
const catalogSteps = ["brand_settings", "competitors", "first_audit", "verify_email"].map((id, order) => ({ id, label: id, order }));
type Users = Parameters<typeof stepPlacement>[0];
const kinds = [{ kind: "brand", label: "brand", plural: "brands", parent: null, multiple: true, description: "" }];

describe("where the product sends each onboarding step", () => {
  it("flags steps the catalog counts per person that only ever arrive per brand", () => {
    const users: Users = [
      { status: "active", steps: steps("verify_email"), entities: { b1: brand("brand_settings", "competitors") } },
      { status: "active", steps: {}, entities: { b2: brand("brand_settings") } },
      { status: "deleted", steps: steps("first_audit"), entities: {} },
    ];
    const r = stepPlacement(users, { onboardingSteps: catalogSteps, entityKinds: kinds });
    expect(r.scanned).toBe(2);
    // verify_email arrives on the person, as counted; first_audit hasn't arrived (the erased user is left out).
    expect(r.moves).toEqual([{ from: null, to: "brand", stepIds: ["brand_settings", "competitors"], users: 2, unknownKind: false }]);
    expect(r.unknown).toEqual([]);
  });

  it("leaves a step alone once any user sends it where the catalog counts it", () => {
    const users: Users = [
      { status: "active", steps: steps("brand_settings"), entities: {} },
      { status: "active", steps: {}, entities: { b: brand("brand_settings") } },
    ];
    expect(stepPlacement(users, { onboardingSteps: catalogSteps }).moves).toEqual([]);
  });

  it("flags the other way round, a kind the catalog doesn't name, and ids it doesn't have", () => {
    const perBrand = catalogSteps.map((s) => ({ ...s, kind: "brand" }));
    const users: Users = [
      { status: "active", steps: steps("brand_settings", "setup_billing"), entities: { w: { ...brand("competitors"), kind: "workspace" } } },
    ];
    const r = stepPlacement(users, { onboardingSteps: perBrand, entityKinds: kinds });
    expect(r.moves).toEqual([
      { from: "brand", to: null, stepIds: ["brand_settings"], users: 1, unknownKind: false },
      { from: "brand", to: "workspace", stepIds: ["competitors"], users: 1, unknownKind: true },
    ]);
    expect(r.unknown).toEqual([{ id: "setup_billing", placement: null, users: 1 }]);
  });

  it("applies a move to just those steps", () => {
    const moved = applyStepMove(catalogSteps, { to: "brand", stepIds: ["competitors"] });
    expect(moved.map((s) => ("kind" in s ? s.kind : undefined))).toEqual([undefined, "brand", undefined, undefined]);
  });
});
