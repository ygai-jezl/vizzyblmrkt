import { beforeEach, describe, expect, it, vi } from "vitest";

// pinPrimaryLogo keeps today's primary where it is: it flags the derived one, never un-flags.
const repo = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn(async () => {}) }));
vi.mock("@/lib/tenant", () => ({ forTenant: () => ({ logos: repo }) }));

const { pinPrimaryLogo } = await import("./brandLogos");

const ctx = { tenantId: "ten_A", region: "us", source: "system" } as const;
const logo = (id: string, isPrimary: boolean) => ({ id, tenantId: "ten_A", isPrimary });

beforeEach(() => vi.clearAllMocks());

describe("pinPrimaryLogo", () => {
  it("with none flagged, flags the newest (the derived primary)", async () => {
    repo.find.mockResolvedValue([logo("logo_new", false), logo("logo_old", false)]);
    expect(await pinPrimaryLogo(ctx)).toBe("logo_new");
    expect(repo.find).toHaveBeenCalledWith({ orderBy: [["createdAt", "desc"]], limit: 60 });
    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith("logo_new", { isPrimary: true });
  });

  it("leaves a flagged primary as it is, even when it isn't the newest", async () => {
    repo.find.mockResolvedValue([logo("logo_new", false), logo("logo_flagged", true)]);
    expect(await pinPrimaryLogo(ctx)).toBe("logo_flagged");
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("has nothing to keep with no logos", async () => {
    repo.find.mockResolvedValue([]);
    expect(await pinPrimaryLogo(ctx)).toBeNull();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("throws when the flag can't be set, so the upload doesn't run", async () => {
    repo.find.mockResolvedValue([logo("logo_new", false)]);
    repo.update.mockRejectedValueOnce(new Error("firestore down"));
    await expect(pinPrimaryLogo(ctx)).rejects.toThrow("firestore down");
  });
});
