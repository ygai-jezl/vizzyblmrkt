import { beforeEach, describe, expect, it, vi } from "vitest";

// The Connections screens' loader: the owner check is the Organisation tab's own (read live on the
// server), and counts only for the brand the person is in now. React's cache is a server only
// export, so it passes the loader through here.
vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), cache: <F>(fn: F) => fn }));
const session = vi.hoisted(() => ({ requireAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const owner = vi.hoisted(() => ({ loadOrganisationOwner: vi.fn() }));
vi.mock("./organisationPage", () => owner);
const screens = vi.hoisted(() => ({ connectionsScreenFor: vi.fn(async (_ctx: unknown, _deps: unknown, opts: { owner?: boolean }) => ({ owner: opts.owner })) }));
vi.mock("./screens", () => screens);

const ADMIN = { tenantId: "ten_fernhill-us", region: "us", source: "idtoken", userId: "usr_priya", role: "admin" };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  session.requireAdminContext.mockResolvedValue(ADMIN);
});

describe("loadConnectionsScreen", () => {
  it("passes on that the person owns the organisation of the brand they are in", async () => {
    owner.loadOrganisationOwner.mockResolvedValue({ ctx: ADMIN });
    const { loadConnectionsScreen } = await import("./screenLoader");
    expect(await loadConnectionsScreen()).toEqual({ owner: true });
  });

  it("says not an owner when the check found none, or found them for another brand", async () => {
    owner.loadOrganisationOwner.mockResolvedValue(null);
    expect(await (await import("./screenLoader")).loadConnectionsScreen()).toEqual({ owner: false });
    vi.resetModules();
    owner.loadOrganisationOwner.mockResolvedValue({ ctx: { ...ADMIN, tenantId: "ten_fernhill" } });
    expect(await (await import("./screenLoader")).loadConnectionsScreen()).toEqual({ owner: false });
  });
});
