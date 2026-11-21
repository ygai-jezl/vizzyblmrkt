import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { CONSENT_HOW } from "@/lib/ontology/consent";
import { CONSENT_WAYS, consentWayLabel, NEW_PERSON_MESSAGES, NEW_PERSON_NOTES, newPersonErrorText, parseAgreed, parseNewPerson, peopleWarning } from "./newPerson";

describe("parseNewPerson", () => {
  it("takes an email, a phone or both, with names, and leaves empty boxes out", () => {
    expect(parseNewPerson({ email: " Sam@Example.com ", firstName: " Sam ", lastName: "", phone: "" })).toEqual({
      ok: true,
      value: { email: "Sam@Example.com", phone: null, firstName: "Sam", lastName: null, agreed: null, fields: {}, via: "form", draftId: null },
    });
    expect(parseNewPerson({ phone: " +44 7700 900123 ", via: "palette" })).toMatchObject({ ok: true, value: { email: null, phone: "+44 7700 900123", via: "palette" } });
  });

  it("needs an email or a phone, each that looks right", () => {
    expect(parseNewPerson({ firstName: "Sam" })).toEqual({ ok: false, error: "email_or_phone" });
    expect(parseNewPerson({ email: "  ", phone: "" })).toEqual({ ok: false, error: "email_or_phone" });
    expect(parseNewPerson({ email: "sam at example" })).toEqual({ ok: false, error: "invalid_email" });
    expect(parseNewPerson({ phone: "call me" })).toEqual({ ok: false, error: "invalid_phone" });
    expect(parseNewPerson({ phone: "sam@example.com" })).toEqual({ ok: false, error: "invalid_phone" });
  });

  it("records how they agreed, and Other needs a note", () => {
    expect(parseNewPerson({ email: "sam@example.com", agreed: { how: "in_person" } })).toMatchObject({ ok: true, value: { agreed: { how: "in_person", note: null } } });
    expect(parseNewPerson({ email: "sam@example.com", agreed: { how: "other" } })).toEqual({ ok: false, error: "note_needed" });
    expect(parseNewPerson({ email: "sam@example.com", agreed: { how: "other", note: " At our stand " } })).toMatchObject({
      ok: true,
      value: { agreed: { how: "other", note: "At our stand" } },
    });
    expect(parseNewPerson({ email: "sam@example.com", agreed: { how: "joined_a_list" } })).toEqual({ ok: false, error: "invalid_input" });
    expect(parseNewPerson({ email: "sam@example.com", agreed: null })).toMatchObject({ ok: true, value: { agreed: null } });
  });

  it("refuses anything the form doesn't send", () => {
    expect(parseNewPerson({ email: "sam@example.com", tenantId: "ten_B" })).toEqual({ ok: false, error: "invalid_input" });
    // From Vizzy's draft only with the draft (AUDIENCE_VIZZY_ADD_PERSON_ENABLED).
    expect(parseNewPerson({ email: "sam@example.com", via: "vizzy" })).toEqual({ ok: false, error: "invalid_input" });
    expect(parseNewPerson({ email: "sam@example.com", via: "vizzy", draftId: "aa_1" })).toMatchObject({ ok: true, value: { via: "vizzy", draftId: "aa_1" } });
    expect(parseNewPerson("sam@example.com")).toEqual({ ok: false, error: "invalid_input" });
  });
});

describe("the ways to agree", () => {
  it("are the four the owner chose, each a code the consent event takes", () => {
    expect(CONSENT_WAYS.map((w) => w.label)).toEqual(["Told me in person", "Signed a form", "Replied by email", "Other"]);
    for (const w of CONSENT_WAYS) expect(CONSENT_HOW.test(w.how), w.how).toBe(true);
    expect(consentWayLabel("signed_form")).toBe("Signed a form");
    expect(consentWayLabel("something_else")).toBe("Another way");
    expect(parseAgreed({ how: "email_reply", note: "" })).toEqual({ ok: true, value: { how: "email_reply", note: null } });
  });
});

describe("peopleWarning", () => {
  it("speaks when the limit is reached or under 1% of it is left, and never blocks", () => {
    expect(peopleWarning(null)).toBeNull();
    expect(peopleWarning({ used: 9_899, limit: 10_000 })).toBeNull();
    expect(peopleWarning({ used: 9_960, limit: 10_000 })).toBe("Your plan includes 10,000 people and you have 9,960. You can still add people.");
    expect(peopleWarning({ used: 10_012, limit: 10_000 })).toContain("You can still add people.");
    expect(peopleWarning({ used: 100, limit: 100 })).not.toBeNull();
    expect(peopleWarning({ used: 99, limit: 100 })).toBeNull();
  });
});

describe("the words", () => {
  it("follow the house style, and every error has words", () => {
    const all = [...Object.values(NEW_PERSON_MESSAGES), ...Object.values(NEW_PERSON_NOTES), ...CONSENT_WAYS.map((w) => w.label), peopleWarning({ used: 1, limit: 1 })!];
    for (const text of all) {
      expect(dashesIn(text), text).toEqual([]);
      expect(aiTellsIn(text), text).toEqual([]);
    }
    expect(newPersonErrorText({ error: "note_needed" })).toBe(NEW_PERSON_MESSAGES.note_needed);
    expect(newPersonErrorText({ error: "teapot" })).toBe(NEW_PERSON_MESSAGES.failed);
  });
});
