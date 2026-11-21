import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

const { requireAdminContext, notFound } = vi.hoisted(() => ({
  requireAdminContext: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/auth/session", () => ({ requireAdminContext }));
vi.mock("next/navigation", () => ({ notFound }));

const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const { default: DataModelPage } = await import("./page");

const CTX = { tenantId: "ten_demo", region: "us" as const, userId: "uid_owner", role: "admin" as const, source: "idtoken" as const };

const SWITCHES = ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "AUDIENCE_FIELD_FILTERS_ENABLED"];

function turnOn(...names: string[]) {
  for (const n of names) process.env[n] = "true";
}

async function props(): Promise<{ canEdit: boolean; filters?: boolean }> {
  return ((await DataModelPage()) as ReactElement<{ canEdit: boolean; filters?: boolean }>).props;
}

describe("Settings › Data model page", () => {
  beforeEach(() => {
    store.db = new FakeFirestore();
    requireAdminContext.mockResolvedValue(CTX);
  });
  afterEach(() => {
    for (const n of SWITCHES) delete process.env[n];
    vi.clearAllMocks();
  });

  it("isn't there with fields off", async () => {
    turnOn("AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED");
    await expect(DataModelPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("says fields can filter People only while field filters are on", async () => {
    turnOn("AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED");
    expect((await props()).filters).toBe(false);
    turnOn("AUDIENCE_FIELD_FILTERS_ENABLED");
    expect((await props()).filters).toBe(true);
  });

  it("lets admins change the fields and members read them", async () => {
    turnOn(...SWITCHES);
    expect((await props()).canEdit).toBe(true);
    requireAdminContext.mockResolvedValue({ ...CTX, role: "member" });
    expect((await props()).canEdit).toBe(false);
  });
});
