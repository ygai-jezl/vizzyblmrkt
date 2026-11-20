import { describe, expect, it } from "vitest";
import { CONSENT_PURPOSES, ConsentRecordedPropertiesSchema, type ConsentRecordedProperties } from "./consent";

const ok: ConsentRecordedProperties = {
  purpose: "marketing_email",
  state: "granted",
  how: "signed_form",
  note: null,
  recordedBy: "uid_member_1",
  agreedAt: "2026-11-19T09:00:00.000Z",
};

describe("consent purposes", () => {
  it("are exactly marketing, product and transactional email", () => {
    expect([...CONSENT_PURPOSES]).toEqual(["marketing_email", "product_email", "transactional"]);
  });

  it("record who by id, how by a short code, and a short note", () => {
    expect(ConsentRecordedPropertiesSchema.safeParse(ok).success).toBe(true);
    expect(ConsentRecordedPropertiesSchema.safeParse({ ...ok, state: "withdrawn", agreedAt: null, note: "Said yes on the phone." }).success).toBe(true);
    expect(ConsentRecordedPropertiesSchema.safeParse({ ...ok, recordedBy: "lee@example.com" }).success).toBe(false);
    for (const how of ["Signed form", "signed-form", "", "x".repeat(41)]) {
      expect(ConsentRecordedPropertiesSchema.safeParse({ ...ok, how }).success, how).toBe(false);
    }
    expect(ConsentRecordedPropertiesSchema.safeParse({ ...ok, purpose: "support" }).success).toBe(false);
    expect(ConsentRecordedPropertiesSchema.safeParse({ ...ok, note: "x".repeat(501) }).success).toBe(false);
  });
});
