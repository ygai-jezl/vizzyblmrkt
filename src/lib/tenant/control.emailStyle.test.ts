import { describe, it, expect, vi } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import {
  clearTenantEmailStyleHeaderImage,
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

describe("setTenantEmailStyle: header options", () => {
  const OPTIONS = { headerGradientColor: "#4f46e5", headerText: "white" } as const;

  it("stores a gradient and a forced text colour, lowercased, with a plain write", async () => {
    const db = seeded();
    const tx = vi.spyOn(db, "runTransaction");
    // All three option keys given, so nothing is carried over.
    const input: EmailStyleInput = { ...STYLE, headerGradientColor: "#4F46E5", headerText: "black", headerImage: null };
    const stored = await setTenantEmailStyle("ten_A", input, db);

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyle).toMatchObject({ headerColor: "#0b1f3a", headerGradientColor: "#4f46e5", headerText: "black" });
    expect(stored).toEqual(raw.emailStyle);
    expect(tx).not.toHaveBeenCalled();
  });

  it("null and \"auto\" remove them: the defaults are stored as no key", async () => {
    const db = seeded();
    await setTenantEmailStyle("ten_A", { ...STYLE, ...OPTIONS }, db);
    const stored = await setTenantEmailStyle("ten_A", { ...STYLE, headerGradientColor: null, headerText: "auto" }, db);

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyle).not.toHaveProperty("headerGradientColor");
    expect(raw.emailStyle).not.toHaveProperty("headerText");
    expect(stored).toEqual(raw.emailStyle);
  });

  it("a colour 2 equal to the header colour is solid: stored as no key, replacing a stored gradient", async () => {
    const db = seeded();
    await setTenantEmailStyle("ten_A", { ...STYLE, ...OPTIONS }, db);
    const stored = await setTenantEmailStyle("ten_A", { ...STYLE, headerGradientColor: "#0b1f3a" }, db);

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyle).not.toHaveProperty("headerGradientColor");
    expect(raw.emailStyle).toMatchObject({ headerColor: "#0b1f3a", headerText: "white" });
    expect(stored).toEqual(raw.emailStyle);
  });

  it("a Save that leaves them out keeps the stored ones, and returns them", async () => {
    const db = seeded();
    await setTenantEmailStyle("ten_A", { ...STYLE, ...OPTIONS }, db);
    const stored = await setTenantEmailStyle("ten_A", { ...STYLE, headerColor: "#000080" }, db, { updatedBy: "usr_admin" });

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyle).toEqual({
      ...STYLE,
      headerColor: "#000080",
      ...OPTIONS,
      updatedAt: expect.any(String),
      updatedBy: "usr_admin",
    });
    expect(stored).toEqual(raw.emailStyle);
    expect((await getTenantById("ten_A", db))?.emailStyle).toMatchObject(OPTIONS);
  });

  it("keeps one option and replaces the other", async () => {
    const db = seeded();
    await setTenantEmailStyle("ten_A", { ...STYLE, ...OPTIONS }, db);
    await setTenantEmailStyle("ten_A", { ...STYLE, headerText: "auto" }, db);

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyle).toMatchObject({ headerGradientColor: "#4f46e5" });
    expect(raw.emailStyle).not.toHaveProperty("headerText");
  });

  it("a damaged stored option never blocks a Save that leaves it out: it's dropped", async () => {
    const db = seeded({
      emailStyle: { ...STYLE, headerColor: "#0b1f3a", headerGradientColor: "purple", headerText: "white" },
    });
    const stored = await setTenantEmailStyle("ten_A", STYLE, db);

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyle).not.toHaveProperty("headerGradientColor");
    expect(raw.emailStyle).toMatchObject({ headerColor: "#0b1f3a", headerText: "white" });
    expect(stored).toEqual(raw.emailStyle);
  });

  it("refuses a colour 2 that isn't #rrggbb or another text choice", async () => {
    const db = seeded();
    await expect(setTenantEmailStyle("ten_A", { ...STYLE, headerGradientColor: "purple" }, db)).rejects.toThrow();
    const pink = { ...STYLE, headerText: "pink" } as unknown as EmailStyleInput;
    await expect(setTenantEmailStyle("ten_A", pink, db)).rejects.toThrow();
    expect(db.raw("tenants", "ten_A")).not.toHaveProperty("emailStyle");
  });

  it("applying a suggestion keeps the options and clears it, in one transaction", async () => {
    const db = seeded({ emailStyleSuggestion: SUGGESTION });
    await setTenantEmailStyle("ten_A", { ...STYLE, ...OPTIONS }, db);
    const tx = vi.spyOn(db, "runTransaction");
    await setTenantEmailStyle("ten_A", STYLE, db, { clearSuggestionAt: SUGGESTION.suggestedAt });

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw).not.toHaveProperty("emailStyleSuggestion");
    expect(raw.emailStyle).toMatchObject(OPTIONS);
    expect(tx).toHaveBeenCalledTimes(1);
  });
});

describe("setTenantEmailStyle: header image", () => {
  const BANNER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301.jpg";
  const IMAGE = { id: "hdr_1", filename: BANNER, width: 1200, height: 300 };
  const OPTIONS = { headerGradientColor: "#4f46e5", headerText: "white" } as const;

  it("stores the image by reference, with a plain write when every option is given", async () => {
    const db = seeded();
    const tx = vi.spyOn(db, "runTransaction");
    const stored = await setTenantEmailStyle("ten_A", { ...STYLE, headerGradientColor: null, headerText: "auto", headerImage: IMAGE }, db);

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyle).toMatchObject({ headerColor: "#0b1f3a", headerImage: IMAGE });
    expect(stored).toEqual(raw.emailStyle);
    expect(tx).not.toHaveBeenCalled();
    expect((await getTenantById("ten_A", db))?.emailStyle?.headerImage).toEqual(IMAGE);
  });

  it("null removes it (the colour header), storing exactly the document a Save without images stores", async () => {
    const db = seeded();
    await setTenantEmailStyle("ten_A", { ...STYLE, ...OPTIONS, headerImage: IMAGE }, db);
    const stored = await setTenantEmailStyle("ten_A", { ...STYLE, headerGradientColor: null, headerText: "auto", headerImage: null }, db);

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyle).not.toHaveProperty("headerImage");
    expect(stored).toEqual(raw.emailStyle);
    const plain = seeded();
    await setTenantEmailStyle("ten_A", STYLE, plain);
    const unstamped = (style: unknown) => ({ ...(style as Record<string, unknown>), updatedAt: "x" });
    expect(unstamped(raw.emailStyle)).toEqual(unstamped(plain.raw("tenants", "ten_A")!.emailStyle));
  });

  it("a Save that leaves it out keeps it (with the gradient and text colour), and returns it", async () => {
    const db = seeded();
    await setTenantEmailStyle("ten_A", { ...STYLE, ...OPTIONS, headerImage: IMAGE }, db);
    const stored = await setTenantEmailStyle("ten_A", { ...STYLE, headerColor: "#000080" }, db, { updatedBy: "usr_admin" });

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyle).toEqual({
      ...STYLE,
      headerColor: "#000080",
      ...OPTIONS,
      headerImage: IMAGE,
      updatedAt: expect.any(String),
      updatedBy: "usr_admin",
    });
    expect(stored).toEqual(raw.emailStyle);
  });

  it("a Save with the gradient and text but no image key re-reads in a transaction and carries the image over", async () => {
    const db = seeded();
    await setTenantEmailStyle("ten_A", { ...STYLE, headerImage: IMAGE }, db);
    const tx = vi.spyOn(db, "runTransaction");
    const stored = await setTenantEmailStyle("ten_A", { ...STYLE, headerGradientColor: "#4F46E5", headerText: "black" }, db);

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyle).toMatchObject({ headerGradientColor: "#4f46e5", headerText: "black", headerImage: IMAGE });
    expect(stored).toEqual(raw.emailStyle);
    expect(tx).toHaveBeenCalledTimes(1);
  });

  it("a damaged stored image never blocks a Save that leaves it out: it's dropped", async () => {
    const db = seeded({
      emailStyle: { ...STYLE, headerColor: "#0b1f3a", headerText: "white", headerImage: { ...IMAGE, filename: "x.webp" } },
    });
    const stored = await setTenantEmailStyle("ten_A", STYLE, db);

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyle).not.toHaveProperty("headerImage");
    expect(raw.emailStyle).toMatchObject({ headerColor: "#0b1f3a", headerText: "white" });
    expect(stored).toEqual(raw.emailStyle);
  });

  it("refuses an image the read would drop", async () => {
    const db = seeded();
    for (const headerImage of [{ ...IMAGE, filename: "3f2504e0-4f89-41d3-9a0c-0305e82c3301.webp" }, { ...IMAGE, width: 1201 }]) {
      await expect(setTenantEmailStyle("ten_A", { ...STYLE, headerImage }, db)).rejects.toThrow();
    }
    expect(db.raw("tenants", "ten_A")).not.toHaveProperty("emailStyle");
  });

  it("applying a suggestion keeps the image and clears the suggestion, in one transaction", async () => {
    const db = seeded({ emailStyleSuggestion: SUGGESTION });
    await setTenantEmailStyle("ten_A", { ...STYLE, headerImage: IMAGE }, db);
    const tx = vi.spyOn(db, "runTransaction");
    await setTenantEmailStyle("ten_A", { ...STYLE, headerGradientColor: null, headerText: "auto" }, db, {
      clearSuggestionAt: SUGGESTION.suggestedAt,
    });

    const raw = db.raw("tenants", "ten_A")!;
    expect(raw).not.toHaveProperty("emailStyleSuggestion");
    expect(raw.emailStyle).toMatchObject({ headerImage: IMAGE });
    expect(tx).toHaveBeenCalledTimes(1);
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

describe("clearTenantEmailStyleHeaderImage", () => {
  const BANNER = "3f2504e0-4f89-41d3-9a0c-0305e82c3301.jpg";
  // Seeded raw: the style as the header-image Save stores it (Image mode).
  const stored = (headerImage: unknown = { id: "hdr_1", filename: BANNER, width: 1200, height: 300 }) => ({
    ...STYLE,
    headerColor: "#0b1f3a",
    headerGradientColor: "#3b1f6a",
    headerText: "white",
    headerImage,
    updatedAt: "2026-09-27T00:00:00.000Z",
    updatedBy: "usr_admin",
  });

  it("removes only the style's header image when the deleted file is the one in use", async () => {
    const db = seeded({ emailStyle: stored() });
    const { headerImage: _image, ...rest } = stored();

    expect(await clearTenantEmailStyleHeaderImage("ten_A", BANNER, db)).toBe(true);
    const raw = db.raw("tenants", "ten_A")!;
    expect(raw.emailStyle).toEqual(rest);
    expect(raw.updatedAt).not.toBe("2026-09-01T00:00:00.000Z");
    expect(raw.brandVoice).toEqual({ summary: "Warm" });
    expect((await getTenantById("ten_A", db))?.emailStyle).toMatchObject({ headerColor: "#0b1f3a", logo: STYLE.logo });
  });

  it("leaves another image, a style without one, no style and no tenant alone", async () => {
    const another = stored({ id: "hdr_2", filename: OTHER_FILE, width: 1200, height: 300 });
    for (const db of [seeded({ emailStyle: another }), seeded({ emailStyle: STYLE }), seeded()]) {
      const before = structuredClone(db.raw("tenants", "ten_A"));
      expect(await clearTenantEmailStyleHeaderImage("ten_A", BANNER, db)).toBe(false);
      expect(db.raw("tenants", "ten_A")).toEqual(before);
    }
    expect(await clearTenantEmailStyleHeaderImage("ten_missing", BANNER, seeded())).toBe(false);
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
