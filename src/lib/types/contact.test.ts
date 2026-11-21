import { describe, expect, it } from "vitest";
import { ContactAddedBySchema, ContactConsentSchema } from "./contact";

const NOW = "2026-11-20T10:00:00.000Z";

describe("a person added by hand", () => {
  it("records who added them by id, when and from where", () => {
    expect(ContactAddedBySchema.safeParse({ kind: "member", id: "usr_1", at: NOW, via: "form" }).success).toBe(true);
    expect(ContactAddedBySchema.safeParse({ kind: "agent", id: "aa_0123456789abcdef0123456789abcdef01234567", at: NOW, via: "vizzy" }).success).toBe(true);
    // Never an address, and only the known ways in.
    expect(ContactAddedBySchema.safeParse({ kind: "member", id: "sam@example.com", at: NOW, via: "form" }).success).toBe(false);
    expect(ContactAddedBySchema.safeParse({ kind: "member", id: "usr_1", at: NOW, via: "import" }).success).toBe(false);
  });

  it("records how they agreed to marketing email, who recorded it and when", () => {
    const entry = { state: "granted", how: "verbal", note: null, recordedBy: "usr_1", at: NOW, agreedAt: null };
    expect(ContactConsentSchema.safeParse({ marketing_email: entry }).success).toBe(true);
    expect(ContactConsentSchema.safeParse({}).success).toBe(true);
    expect(ContactConsentSchema.safeParse({ marketing_email: { ...entry, recordedBy: "sam@example.com" } }).success).toBe(false);
    expect(ContactConsentSchema.safeParse({ marketing_email: { ...entry, how: "Told me in person" } }).success).toBe(false);
    expect(ContactConsentSchema.safeParse({ marketing_email: { ...entry, note: "x".repeat(501) } }).success).toBe(false);
  });
});
