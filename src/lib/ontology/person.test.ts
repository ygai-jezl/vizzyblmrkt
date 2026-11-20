import { describe, expect, it } from "vitest";
import { deterministicContactId } from "@/lib/crm/identifiers";
import { productUserDocId } from "@/lib/connect/profile";
import { personIdOf } from "@/lib/audience/personSync";
import { asContactPersonId, ContactPersonIdSchema, isContactPersonId } from "./person";

describe("ContactPersonId", () => {
  it("accepts the id a person record gets", () => {
    const id = deterministicContactId("ten_demo", "a@b.co");
    expect(isContactPersonId(id)).toBe(true);
    expect(ContactPersonIdSchema.safeParse(id).success).toBe(true);
    expect(asContactPersonId(id)).toBe(id);
    // A person known only from a product (a pu: key) gets the same shape.
    const fromProduct = personIdOf("ten_demo", "pu:pu_0123");
    expect(isContactPersonId(fromProduct)).toBe(true);
  });

  it("refuses a product user id, an empty string and the bare prefix", () => {
    const productUser = productUserDocId("conn_1", "user_1");
    expect(productUser.startsWith("pu_")).toBe(true);
    for (const bad of [productUser, "", "ct_", `ct_${"A".repeat(40)}`, `ct_${"a".repeat(39)}`, `ct_${"a".repeat(41)}`]) {
      expect(isContactPersonId(bad), bad).toBe(false);
      expect(ContactPersonIdSchema.safeParse(bad).success, bad).toBe(false);
      expect(() => asContactPersonId(bad), bad).toThrow("not_a_contact_person_id");
    }
  });

  it("refuses anything that isn't a string", () => {
    for (const bad of [null, undefined, 42, { id: "ct_" }]) {
      expect(isContactPersonId(bad)).toBe(false);
      expect(() => asContactPersonId(bad)).toThrow();
    }
  });
});
