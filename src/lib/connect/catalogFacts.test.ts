import { describe, it, expect, beforeAll } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { ConnectionCatalogSchema } from "@/lib/types/productConnection";
import { fieldOptions } from "@/components/admin/lifecycle/model";
import { allowedTermsFor } from "@/lib/lifecycle/drafts";
import { createConnection } from "./keys";
import { fetchProductContext } from "./contextClient";
import { SANDBOX_CATALOG } from "./sandbox";

const ctx: TenantContext = { tenantId: "ten_A", region: "eu", source: "system" };

beforeAll(() => {
  process.env.CONNECT_SECRET_ENC_KEY = "unit-test-connect-root-key-rotate-me";
});

describe("catalog facts", () => {
  it("old catalogs without facts still parse, and facts validate their ids", () => {
    const old = ConnectionCatalogSchema.parse({ events: [], traits: [], onboardingSteps: [], glossary: [] });
    expect(old.facts).toEqual([]);
    expect(ConnectionCatalogSchema.safeParse({ facts: [{ id: "Share Of Voice", label: "x" }] }).success).toBe(false);
    expect(ConnectionCatalogSchema.parse({ facts: [{ id: "share_of_voice", label: "Share of voice" }] }).facts[0]).toMatchObject({
      type: "number",
      source: "",
    });
  });

  it("offers catalogued facts as typed condition fields", () => {
    const opts = fieldOptions(SANDBOX_CATALOG);
    expect(opts).toContainEqual({ value: "fact.share_of_voice", label: "Share of voice (%)", group: "Facts", kind: "number" });
    // A catalog saved before facts existed has none — and doesn't break the picker.
    const { facts: _f, ...legacy } = SANDBOX_CATALOG;
    expect(fieldOptions(legacy as typeof SANDBOX_CATALOG).some((o) => o.group === "Facts")).toBe(false);
  });

  it("lets the AI line use catalogued fact labels", () => {
    const terms = allowedTermsFor({ connection: { name: "Acme", catalog: SANDBOX_CATALOG }, brand: null, context: null, insightSentence: null });
    expect(terms).toEqual(expect.arrayContaining(["Share of voice", "AI engines checked"]));
  });

  it("warns when the product returns facts the catalog doesn't describe", async () => {
    const db = new FakeFirestore();
    const { connection } = await createConnection(ctx, { name: "Acme", kind: "custom", catalog: SANDBOX_CATALOG }, db);
    const conn = {
      ...connection,
      contextEndpoint: { url: "https://api.acme.test/ctx", enabled: true, timeoutMs: 5000 },
      linkDomains: ["acme.test"],
    };
    const r = await fetchProductContext(conn, { userId: "u1", purpose: "test" }, {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            asOf: "2026-09-23T10:00:00Z",
            facts: [
              { id: "share_of_voice", label: "Share of voice", value: 12 },
              { id: "mystery_metric", label: "Mystery", value: 3 },
            ],
          }),
        ),
    });
    expect(r.ok && r.warnings).toEqual(["unknown_fact:mystery_metric"]);
  });
});
