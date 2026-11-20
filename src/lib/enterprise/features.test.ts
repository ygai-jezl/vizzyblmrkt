import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import {
  ENTERPRISE_FEATURE_IDS,
  ENTERPRISE_FEATURES,
  enterpriseFeatureLabel,
  HOSTED_ONLY,
  isEnterpriseFeature,
} from "./features";

describe("Enterprise features", () => {
  it("keeps the ids written into licence keys (renaming one means reissuing keys)", () => {
    expect(ENTERPRISE_FEATURE_IDS).toEqual([
      "sso",
      "scim",
      "field_access",
      "record_access",
      "audit_export",
      "audit_retention",
      "retention_rules",
      "legal_hold",
    ]);
  });

  it("has unique snake_case ids", () => {
    expect(new Set(ENTERPRISE_FEATURE_IDS).size).toBe(ENTERPRISE_FEATURE_IDS.length);
    for (const id of ENTERPRISE_FEATURE_IDS) expect(id).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
  });

  it("writes every label and hosted-only item in house style", () => {
    const copy = [...ENTERPRISE_FEATURES.map((f) => f.label), ...HOSTED_ONLY];
    for (const text of copy) {
      expect(text.trim(), text).not.toBe("");
      expect(dashesIn(text), text).toEqual([]);
      expect(aiTellsIn(text), text).toEqual([]);
    }
  });

  it("knows its own ids and nothing else", () => {
    for (const id of ENTERPRISE_FEATURE_IDS) expect(isEnterpriseFeature(id)).toBe(true);
    for (const x of ["", "SSO", "marketplace", "sso ", null, undefined, 1, {}]) expect(isEnterpriseFeature(x)).toBe(false);
    expect(enterpriseFeatureLabel("scim")).toBe("User provisioning (SCIM)");
  });

  it("imports nothing, so pages and client components can use it", () => {
    const source = readFileSync(fileURLToPath(new URL("./features.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });
});
