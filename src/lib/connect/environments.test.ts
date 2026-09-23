import { describe, it, expect } from "vitest";
import { environmentOf, groupProducts, productNameOf, promotionTarget } from "./environments";

const conn = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: "custom" as const,
  status: "active",
  ...extra,
});

describe("environmentOf / productNameOf", () => {
  it("prefers the saved field", () => {
    expect(environmentOf({ name: "Fernlight app", environment: "production" })).toBe("production");
    expect(environmentOf({ name: "Fernlight app (staging)", environment: "production" })).toBe("production");
  });

  it.each([
    ["vizzybl.ai (staging)", "staging", "vizzybl.ai"],
    ["vizzybl.ai (production)", "production", "vizzybl.ai"],
    ["App [prod]", "production", "App"],
    ["App — staging", "staging", "App"],
    ["App · Live", "production", "App"],
    ["App: stg", "staging", "App"],
  ])("infers %s from the name", (name, env, base) => {
    expect(environmentOf({ name })).toBe(env);
    expect(productNameOf({ name })).toBe(base);
  });

  it("leaves other names alone", () => {
    expect(environmentOf({ name: "Fernlight app" })).toBeNull();
    expect(environmentOf({ name: "Staging" })).toBeNull(); // nothing left for a product name
    expect(environmentOf({ name: "App (beta)" })).toBeNull();
    expect(productNameOf({ name: "App (beta)" })).toBe("App (beta)");
  });
});

describe("groupProducts", () => {
  it("groups a product's environments and keeps sandboxes apart", () => {
    const { products, sandboxes } = groupProducts([
      conn("a", "vizzybl.ai (staging)"),
      conn("b", "Vizzybl.ai", { environment: "production" }),
      conn("c", "Fernlight app"),
      conn("d", "Old (production)", { status: "revoked" }),
      { ...conn("s", "Sandbox"), kind: "sandbox" as const },
    ]);
    expect(products.map((p) => [p.product, p.staging.map((c) => c.id), p.production.map((c) => c.id), p.other.map((c) => c.id)])).toEqual([
      ["vizzybl.ai", ["a"], ["b"], []],
      ["Fernlight app", [], [], ["c"]],
    ]);
    expect(sandboxes.map((s) => s.id)).toEqual(["s"]);
  });
});

describe("promotionTarget", () => {
  const all = [
    conn("stg", "App (staging)"),
    conn("prd", "App (production)"),
    conn("other", "Other (production)"),
  ];

  it("finds the same product's production connection", () => {
    expect(promotionTarget(all[0]!, all)?.id).toBe("prd");
  });

  it("only promotes from staging, and not to revoked connections", () => {
    expect(promotionTarget(all[1]!, all)).toBeNull();
    expect(promotionTarget(all[0]!, [all[0]!, { ...all[1]!, status: "revoked" }])).toBeNull();
  });
});
