import { beforeEach, describe, expect, it } from "vitest";
import { createOrganisationConnection } from "@/lib/tenant";
import { CONNECTOR_ERRORS } from "./messages";
import { organisationShareAddresses, organisationShareRoom, organisationTokenCheckRoom } from "./organisation";
import { SHARE_ADDRESS_CAP } from "./service";
import { ORG, orgWorld, T0, type OrgWorld } from "./testing/organisation";

// The share address cap and the rate limits count per organisation, in every region.
let w: OrgWorld;
const health = { state: "ok" as const, lastOkAt: T0, lastCheckedAt: T0, lastErrorCode: null, failures: 0, pausedUntil: null };
const address = (n: number, deletedAt: string | null = null) => ({ email: `ygc-${"a".repeat(19)}${String.fromCharCode(97 + n)}@made-up-identities.iam.gserviceaccount.com`, uniqueId: String(1000 + n), createdAt: T0, deletedAt });
const ocn = (n: number) => `ocn_${"a".repeat(19)}${String.fromCharCode(97 + n)}`;

async function seedAddress(n: number, region: "us" | "eu", over: Record<string, unknown> = {}) {
  await createOrganisationConnection(
    {
      id: ocn(n),
      organisationId: ORG,
      region,
      connectorId: "search-console",
      method: "share_access",
      label: "Search Console",
      createdBy: "usr_priya",
      signerUid: null,
      connectedFromTenantId: "ten_fernhill",
      secrets: {},
      serviceAccount: address(n),
      health,
      pausedAt: null,
      pausedBy: null,
      status: "connected",
      createdAt: T0,
      updatedAt: T0,
      disconnectedAt: null,
      collectHold: null,
      parts: [],
      ...over,
    },
    [],
    { regionDb: w.regionDb },
  );
}

beforeEach(() => {
  w = orgWorld();
});

describe("an organisation's Google addresses", () => {
  it("are counted in every region, with addresses a failed delete left at Google, and capped at 5", async () => {
    await seedAddress(0, "eu");
    await seedAddress(1, "us");
    await seedAddress(2, "eu", { status: "disconnected" });
    await seedAddress(3, "us", { status: "disconnected", serviceAccount: address(3, T0) });
    const deps = { regionDb: w.regionDb, limit: async () => false };
    expect(await organisationShareAddresses(ORG, "search-console", deps)).toBe(3);
    expect(await organisationShareRoom(ORG, "search-console", deps)).toEqual({ ok: true });
    await seedAddress(4, "eu");
    await seedAddress(5, "us");
    expect(await organisationShareAddresses(ORG, "search-console", deps)).toBe(SHARE_ADDRESS_CAP);
    expect(await organisationShareRoom(ORG, "search-console", deps)).toEqual({ ok: false, code: "org_share_limit" });
    expect(await organisationShareAddresses("org_ten_other", "search-console", deps)).toBe(0);
  });

  it("are made and tokens checked under the organisation's own rate limits", async () => {
    const seen: string[] = [];
    const limit = async (subject: string, config: { prefix: string }) => {
      seen.push(`${config.prefix} ${subject}`);
      return true;
    };
    expect(await organisationShareRoom(ORG, "search-console", { regionDb: w.regionDb, limit })).toEqual({ ok: false, code: "busy" });
    expect(await organisationTokenCheckRoom(ORG, "cloudflare", { regionDb: w.regionDb, limit })).toBe(false);
    expect(seen).toEqual([`connector-share-org:search-console ${ORG}`, `connector-check-org:cloudflare ${ORG}`]);
  });

  it("say why in the organisation's words, and the brand's limit names no shared connection", () => {
    expect(CONNECTOR_ERRORS.org_share_limit).toBe("This organisation already has 5 Google addresses for this connector, the most one organisation can have. Disconnect one it no longer uses, or sign in with Google instead.");
    expect(CONNECTOR_ERRORS.share_limit).toContain("Disconnect one you no longer use");
  });
});
