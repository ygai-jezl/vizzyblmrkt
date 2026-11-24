import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionsScreen } from "@/lib/connectors/screens";
import { connectionView, listingFor } from "@/components/admin/connectors/testing";

const screen = vi.hoisted(() => ({ now: null as unknown }));
vi.mock("@/lib/connectors/screenLoader", () => ({ loadConnectionsScreen: async () => screen.now }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not_found");
  },
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
const { default: ConnectorListingPage } = await import("./page");

const base = (over: Partial<ConnectionsScreen> = {}): ConnectionsScreen => ({
  core: true,
  chat: false,
  collect: false,
  planning: false,
  isAdmin: true,
  uid: "usr_alex",
  connectors: [listingFor("search-console", ["oauth_pkce", "share_access"])],
  connections: [],
  failed: false,
  ...over,
});
const open = (connectorId: string, sp: Record<string, string> = {}) => ConnectorListingPage({ params: Promise.resolve({ connectorId }), searchParams: Promise.resolve(sp) });
const SIGNED_IN = connectionView({ id: "dcn_sisisisisisisisisisi", connectorId: "search-console", needsAccount: true, details: { method: "oauth_pkce", account: "" } });

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
  screen.now = base();
});
afterEach(() => vi.unstubAllEnvs());

describe("a connector's Listing page", () => {
  it("is not found while the screens are off, or while the connector's own switch is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "false");
    await expect(open("search-console")).rejects.toThrow("not_found");
    vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
    // Cloudflare's switch is off, so the list route never offered it.
    await expect(open("cloudflare")).rejects.toThrow("not_found");
    await expect(open("search-console")).resolves.toBeTruthy();
  });

  it("sends a new sign in on to the picker, and says how it went otherwise", async () => {
    screen.now = base({ connections: [SIGNED_IN] });
    await expect(open("search-console", { status: "connected", connection: SIGNED_IN.id })).rejects.toThrow(
      "redirect:/admin/account/connections/search-console/pick?connection=dcn_sisisisisisisisisisi",
    );
    const el = (await open("search-console", { status: "error", reason: "denied" })) as { props: { banner: unknown; replace: unknown } };
    expect(el.props.banner).toMatchObject({ tone: "err", text: expect.stringContaining("Access wasn't given") });
    expect(el.props.replace).toBeNull();
  });

  it("passes a turned down token connection to replace, for admins only", async () => {
    const broken = connectionView({ health: { state: "broken", lastOkAt: null, lastCheckedAt: null, message: null, pausedUntil: null } });
    screen.now = base({ connectors: [listingFor("cloudflare", ["token_fields"])], connections: [broken] });
    const el = (await open("cloudflare", { reconnect: broken.id })) as { props: { replace: { id: string } | null; connections: unknown[] } };
    expect(el.props.replace?.id).toBe(broken.id);
    screen.now = base({ isAdmin: false, connectors: [listingFor("cloudflare", ["token_fields"])], connections: [broken] });
    expect(((await open("cloudflare", { reconnect: broken.id })) as { props: { replace: unknown } }).props.replace).toBeNull();
  });

  it("says so when the core switch is off", async () => {
    screen.now = base({ core: false, connectors: [] });
    const el = (await open("search-console")) as { props: { screen: { core: boolean } } };
    expect(el.props.screen.core).toBe(false);
  });
});
