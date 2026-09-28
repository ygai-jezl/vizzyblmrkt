import { describe, it, expect } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import {
  clearTenantEmailStyleLogo,
  clearTenantEmailStyleSuggestion,
  setTenantEmailStyle,
  setTenantEmailStyleSuggestion,
} from "./control";
import { getTenantById } from "./registry";
import type { EmailStyleInput, EmailStyleSuggestion } from "@/lib/types/tenant";

const FILE = "0f8fad5b-d9cb-469f-a165-70867728950e.png";
const OTHER_FILE = "7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg";
const STYLE: EmailStyleInput = {
  logo: { id: "logo_1", filename: FILE, width: 120, height: 40 },
  companyName: "Example Co",
  headerColor: "#0B1F3A",
  accentColor: "#ff6b35",
};
const SUGGESTION: EmailStyleSuggestion = {
  logoId: "logo_1",
  companyName: null,
  headerColor: "#000080",
  accentColor: "#ff6b35",
  source: "chat",
  brief: "Make the header navy",
  notes: [],
  suggestedBy: "usr_admin",
  suggestedAt: "2026-09-27T10:00:00.000Z",
};
const NEWER = "2026-09-27T10:05:00.000Z";

function seeded(over: Record<string, unknown> = {}): FakeFirestore {
  const db = new FakeFirestore();
  db.seed("tenants", "ten_A", {
    tenantName: "Example Co",
    rootDomain: "example.com",
    status: "active",
    region: "us",
    allowedOrigins: ["https://example.com"],
    billingTier: "mvp_free",
    ownerId: "usr_owner",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    brandVoice: { summary: "Warm" },
    ...over,
  });
  return db;
}

describe("setTenantEmailStyle", () => {
  it("stores the style top-level, lowercased and stamped, and leaves the rest alone", async () => {
    const db = seeded();
    await setTenantEmailStyle("ten_A", STYLE, db, { updatedBy: "usr_admin" });

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyle).toEqual({
      ...STYLE,
      headerColor: "#0b1f3a",
      updatedAt: expect.any(String),
      updatedBy: "usr_admin",
    });
    expect(raw.brandVoice).toEqual({ summary: "Warm" });
    expect(raw.updatedAt).not.toBe("2026-09-01T00:00:00.000Z");
    expect((await getTenantById("ten_A", db))?.emailStyle?.headerColor).toBe("#0b1f3a");
  });

  it("refuses to store a style the read would drop", async () => {
    const db = seeded();
    await expect(setTenantEmailStyle("ten_A", { ...STYLE, headerColor: "red" }, db)).rejects.toThrow();
    await expect(setTenantEmailStyle("ten_A", { ...STYLE, companyName: "{{first_name}}" }, db)).rejects.toThrow();
    expect(db.raw("tenants", "ten_A")).not.toHaveProperty("emailStyle");
  });

  it("null removes the field (Reset to default)", async () => {
    const db = seeded();
    await setTenantEmailStyle("ten_A", STYLE, db);
    await setTenantEmailStyle("ten_A", null, db);

    expect(db.raw("tenants", "ten_A")).not.toHaveProperty("emailStyle");
    expect((await getTenantById("ten_A", db))?.emailStyle).toBeUndefined();
  });
});

describe("clearTenantEmailStyleLogo", () => {
  it("nulls the logo when the deleted file is the one in use, keeping the rest of the style", async () => {
    const db = seeded();
    await setTenantEmailStyle("ten_A", STYLE, db);

    expect(await clearTenantEmailStyleLogo("ten_A", FILE, db)).toBe(true);
    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyle).toMatchObject({ logo: null, companyName: "Example Co", headerColor: "#0b1f3a" });
    expect((await getTenantById("ten_A", db))?.emailStyle?.logo).toBeNull();
  });

  it("leaves a style using another logo, or no style, untouched", async () => {
    const db = seeded();
    await setTenantEmailStyle("ten_A", STYLE, db);
    const before = structuredClone(db.raw("tenants", "ten_A"));

    expect(await clearTenantEmailStyleLogo("ten_A", OTHER_FILE, db)).toBe(false);
    expect(db.raw("tenants", "ten_A")).toEqual(before);

    const bare = seeded();
    expect(await clearTenantEmailStyleLogo("ten_A", FILE, bare)).toBe(false);
    expect(bare.raw("tenants", "ten_A")).not.toHaveProperty("emailStyle");
    expect(await clearTenantEmailStyleLogo("ten_missing", FILE, bare)).toBe(false);
  });
});

describe("setTenantEmailStyleSuggestion", () => {
  it("stores the suggestion top-level and never touches the saved style", async () => {
    const db = seeded();
    await setTenantEmailStyle("ten_A", STYLE, db);
    const style = structuredClone(db.raw("tenants", "ten_A")!.emailStyle);

    await setTenantEmailStyleSuggestion("ten_A", SUGGESTION, db);
    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyleSuggestion).toEqual(SUGGESTION);
    expect(raw.emailStyle).toEqual(style);
    expect((await getTenantById("ten_A", db))?.emailStyleSuggestion).toEqual(SUGGESTION);
  });

  it("refuses to store a suggestion the read would drop", async () => {
    const db = seeded();
    await expect(setTenantEmailStyleSuggestion("ten_A", { ...SUGGESTION, brief: "a".repeat(501) }, db)).rejects.toThrow();
    await expect(setTenantEmailStyleSuggestion("ten_A", { ...SUGGESTION, headerColor: "navy" }, db)).rejects.toThrow();
    expect(db.raw("tenants", "ten_A")).not.toHaveProperty("emailStyleSuggestion");
  });
});

describe("applying a suggestion (setTenantEmailStyle with clearSuggestionAt)", () => {
  it("saves the style and clears the suggestion it applies, in one write", async () => {
    const db = seeded({ emailStyleSuggestion: SUGGESTION });
    await setTenantEmailStyle("ten_A", STYLE, db, { updatedBy: "usr_admin", clearSuggestionAt: SUGGESTION.suggestedAt });

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw).not.toHaveProperty("emailStyleSuggestion");
    expect(raw.emailStyle).toMatchObject({ headerColor: "#0b1f3a", updatedBy: "usr_admin" });
  });

  it("keeps a newer suggestion that arrived while the admin was reviewing", async () => {
    const db = seeded({ emailStyleSuggestion: { ...SUGGESTION, suggestedAt: NEWER } });
    await setTenantEmailStyle("ten_A", STYLE, db, { clearSuggestionAt: SUGGESTION.suggestedAt });

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyleSuggestion).toMatchObject({ suggestedAt: NEWER });
    expect(raw.emailStyle).toMatchObject({ headerColor: "#0b1f3a" });
  });

  it("a suggestion that lands mid-Save survives (the transaction re-reads)", async () => {
    const db = seeded({ emailStyleSuggestion: SUGGESTION });
    db.onBeforeCommit = async () => {
      await setTenantEmailStyleSuggestion("ten_A", { ...SUGGESTION, suggestedAt: NEWER }, db);
    };
    await setTenantEmailStyle("ten_A", STYLE, db, { clearSuggestionAt: SUGGESTION.suggestedAt });

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyleSuggestion).toMatchObject({ suggestedAt: NEWER });
    expect(raw.emailStyle).toMatchObject({ headerColor: "#0b1f3a" });
  });

  it("a plain Save or Reset leaves the suggestion alone", async () => {
    const db = seeded({ emailStyleSuggestion: SUGGESTION });
    await setTenantEmailStyle("ten_A", STYLE, db);
    await setTenantEmailStyle("ten_A", null, db);
    expect(db.raw("tenants", "ten_A")!.emailStyleSuggestion).toEqual(SUGGESTION);
  });
});

describe("clearTenantEmailStyleSuggestion (Dismiss)", () => {
  it("clears the suggestion when it's still the one dismissed, leaving the saved style", async () => {
    const db = seeded({ emailStyleSuggestion: SUGGESTION });
    await setTenantEmailStyle("ten_A", STYLE, db);

    expect(await clearTenantEmailStyleSuggestion("ten_A", SUGGESTION.suggestedAt, db)).toBe(true);
    const raw = db.raw("tenants", "ten_A")!;
    expect(raw).not.toHaveProperty("emailStyleSuggestion");
    expect(raw.emailStyle).toMatchObject({ headerColor: "#0b1f3a" });
  });

  it("only clears on a match: a newer suggestion, no suggestion or no tenant is left alone", async () => {
    const db = seeded({ emailStyleSuggestion: { ...SUGGESTION, suggestedAt: NEWER } });
    const before = structuredClone(db.raw("tenants", "ten_A"));
    expect(await clearTenantEmailStyleSuggestion("ten_A", SUGGESTION.suggestedAt, db)).toBe(false);
    expect(db.raw("tenants", "ten_A")).toEqual(before);

    const bare = seeded();
    expect(await clearTenantEmailStyleSuggestion("ten_A", SUGGESTION.suggestedAt, bare)).toBe(false);
    expect(bare.raw("tenants", "ten_A")).not.toHaveProperty("emailStyleSuggestion");
    expect(await clearTenantEmailStyleSuggestion("ten_missing", SUGGESTION.suggestedAt, bare)).toBe(false);
  });
});
