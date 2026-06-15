import { describe, it, expect } from "vitest";
import {
  maskLastName,
  maskEmail,
  maskPhone,
  toPublicLeaderboardEntry,
} from "./masking";

describe("maskLastName", () => {
  it("truncates to first letter + period", () => {
    expect(maskLastName("Sawyer")).toBe("S.");
  });
  it("returns null for empty/missing", () => {
    expect(maskLastName(null)).toBeNull();
    expect(maskLastName("")).toBeNull();
  });
});

describe("maskEmail", () => {
  it("masks local part and domain (PRD example)", () => {
    expect(maskEmail("bani@getwaitlist.com")).toBe("b***@g**************");
  });
  it("never exposes more than the first char of local + domain", () => {
    expect(maskEmail("a@b.co")).toBe("a@b***");
    expect(maskEmail(null)).toBeNull();
  });
});

describe("maskPhone", () => {
  it("shows first 3 digits only (PRD example)", () => {
    expect(maskPhone("1234567891")).toBe("123 *** ****");
  });
  it("strips formatting before masking", () => {
    expect(maskPhone("+1 (234) 567-8910")).toBe("123 *** ****");
  });
  it("returns a fully masked value for too-short input", () => {
    expect(maskPhone("12")).toBe("*** *** ****");
    expect(maskPhone(null)).toBeNull();
  });
});

describe("toPublicLeaderboardEntry", () => {
  it("exposes first name + referrals, masks the rest, and never leaks raw PII", () => {
    const entry = toPublicLeaderboardEntry(
      {
        firstName: "Brittany",
        lastName: "Sawyer",
        email: "bani@getwaitlist.com",
        phone: "1234567891",
        amountReferred: 5,
      },
      1,
    );
    expect(entry).toEqual({
      rank: 1,
      amount_referred: 5,
      first_name: "Brittany",
      last_name: "S.",
      email: "b***@g**************",
      phone: "123 *** ****",
    });
    // belt-and-braces: no raw PII anywhere in the serialized payload
    const json = JSON.stringify(entry);
    expect(json).not.toContain("Sawyer");
    expect(json).not.toContain("bani@getwaitlist.com");
    expect(json).not.toContain("1234567891");
  });
});
