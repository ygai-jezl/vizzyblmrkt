import { describe, it, expect } from "vitest";
import { fetchAdminOrganizations } from "./orgs";

/** A fake fetch that answers organizationAcls, then per-org lookups by id. */
function fakeFetch(handlers: {
  acls?: { ok: boolean; body?: unknown };
  orgs?: Record<string, { ok: boolean; body?: unknown }>;
}) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    if (url.includes("organizationAcls")) {
      const h = handlers.acls ?? { ok: true, body: { elements: [] } };
      return { ok: h.ok, json: async () => h.body ?? {} } as unknown as Response;
    }
    const id = url.split("/").pop()!;
    const h = handlers.orgs?.[id] ?? { ok: false };
    return { ok: h.ok, json: async () => h.body ?? {} } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("fetchAdminOrganizations", () => {
  it("returns [] without a token", async () => {
    expect(await fetchAdminOrganizations("")).toEqual({ ok: false, orgs: [] });
  });

  it("lists admin'd orgs and resolves names", async () => {
    const { fn } = fakeFetch({
      acls: {
        ok: true,
        body: {
          elements: [
            { organization: "urn:li:organization:111", role: "ADMINISTRATOR" },
            { organization: "urn:li:organization:222", role: "ADMINISTRATOR" },
          ],
        },
      },
      orgs: {
        "111": { ok: true, body: { localizedName: "Acme Inc" } },
        "222": { ok: true, body: { localizedName: "Beta LLC" } },
      },
    });
    const res = await fetchAdminOrganizations("tok", { fetch: fn });
    expect(res).toEqual({
      ok: true,
      orgs: [
        { urn: "urn:li:organization:111", name: "Acme Inc" },
        { urn: "urn:li:organization:222", name: "Beta LLC" },
      ],
    });
  });

  it("keeps the org with a null name when the lookup fails (fail-soft)", async () => {
    const { fn } = fakeFetch({
      acls: { ok: true, body: { elements: [{ organization: "urn:li:organization:9" }] } },
      orgs: { "9": { ok: false } },
    });
    expect(await fetchAdminOrganizations("tok", { fetch: fn })).toEqual({
      ok: true,
      orgs: [{ urn: "urn:li:organization:9", name: null }],
    });
  });

  it("dedupes org urns; signals ok=false when the ACL call itself fails", async () => {
    const dup = await fetchAdminOrganizations("tok", {
      fetch: fakeFetch({
        acls: {
          ok: true,
          body: { elements: [{ organization: "urn:li:organization:5" }, { organization: "urn:li:organization:5" }] },
        },
        orgs: { "5": { ok: true, body: { localizedName: "Solo" } } },
      }).fn,
    });
    expect(dup).toEqual({ ok: true, orgs: [{ urn: "urn:li:organization:5", name: "Solo" }] });
    // ACLs failure → ok:false so the caller preserves any prior page list.
    expect(await fetchAdminOrganizations("tok", { fetch: fakeFetch({ acls: { ok: false } }).fn })).toEqual({
      ok: false,
      orgs: [],
    });
  });
});
