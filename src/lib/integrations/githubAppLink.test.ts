import { beforeAll, describe, expect, it, vi } from "vitest";

const tenant = vi.hoisted(() => ({ setTenantGitConnection: vi.fn() }));
vi.mock("@/lib/tenant", () => tenant);

const { verifyState } = await import("./crypto");
const { chooseToken, connectState, readChooseToken, saveAppConnection, CONNECT_STATE_MAX_AGE_MS } = await import("./githubAppLink");

beforeAll(() => {
  process.env.GIT_TOKEN_ENC_KEY = "unit-test-root-key-please-rotate";
});

const inst = (id: number, login: string, type: "User" | "Organization") => ({
  installationId: id,
  accountLogin: login,
  accountType: type,
  repositorySelection: "selected",
  readOnly: true,
});

describe("GitHub App connect steps", () => {
  it("signs each step for this tenant, carrying an install GitHub already named", () => {
    expect(verifyState(connectState("ten_A", "install"))).toMatchObject({ t: "ten_A", p: "github", m: "install" });
    const link = verifyState(connectState("ten_A", "link", 4242));
    expect(link).toMatchObject({ t: "ten_A", p: "github", m: "link", i: 4242 });
    expect(verifyState(connectState("ten_A", "link"))).not.toHaveProperty("i");
  });

  it("round-trips the installs to choose from", () => {
    const c = chooseToken("ten_A", [inst(1, "acme-org", "Organization"), inst(2, "jo", "User")]);
    expect(readChooseToken(c, "ten_A")).toEqual([
      { installationId: 1, accountLogin: "acme-org", accountType: "Organization", repositorySelection: "selected" },
      { installationId: 2, accountLogin: "jo", accountType: "User", repositorySelection: "selected" },
    ]);
  });

  it("refuses another tenant's, an expired, a tampered or a non-choice token", () => {
    const c = chooseToken("ten_A", [inst(1, "acme-org", "Organization")]);
    expect(readChooseToken(c, "ten_B")).toBeNull();
    expect(readChooseToken(c, "ten_A", Date.now() + CONNECT_STATE_MAX_AGE_MS + 1)).toBeNull();
    expect(readChooseToken(`${c}x`, "ten_A")).toBeNull();
    expect(readChooseToken(connectState("ten_A", "link", 1), "ten_A")).toBeNull();
  });

  it("stores only the install id and its account — never a token", async () => {
    await saveAppConnection("ten_A", "u1", { installationId: 7, accountLogin: "acme-org", accountType: "Organization" });
    expect(tenant.setTenantGitConnection).toHaveBeenCalledWith("ten_A", "github", {
      provider: "github",
      kind: "app",
      installationId: 7,
      accountLogin: "acme-org",
      accountType: "Organization",
      scope: "contents:read",
      connectedBy: "u1",
      connectedAt: expect.any(String),
    });
  });
});
