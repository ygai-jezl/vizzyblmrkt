import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionsScreen } from "@/lib/connectors/screens";
import { connectionView, listingFor } from "@/components/admin/connectors/testing";

const state = vi.hoisted(() => ({ screen: null as unknown, rootDomain: "acme.example" as string | undefined }));
vi.mock("@/lib/connectors/screenLoader", () => ({ loadConnectionsScreen: async () => state.screen }));
vi.mock("@/lib/auth/session", () => ({ requireAdminContext: async () => ({ tenantId: "ten_acme", region: "us", source: "idtoken", role: "admin" }) }));
vi.mock("@/lib/tenant", () => ({ getTenantById: async () => ({ rootDomain: state.rootDomain }) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not_found");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
const { default: PickPropertyPage } = await import("./page");

const SIGNED_IN = connectionView({ id: "dcn_sisisisisisisisisisi", connectorId: "search-console", needsAccount: true, details: { method: "oauth_pkce", account: "" } });
const base = (over: Partial<ConnectionsScreen> = {}): ConnectionsScreen => ({
  core: true,
  chat: false,
  isAdmin: true,
  uid: "usr_alex",
  connectors: [listingFor("search-console", ["oauth_pkce", "share_access"])],
  connections: [SIGNED_IN],
  failed: false,
  ...over,
});
const open = (connectorId: string, connection?: string) =>
  PickPropertyPage({ params: Promise.resolve({ connectorId }), searchParams: Promise.resolve(connection ? { connection } : {}) }) as Promise<{ props: Record<string, unknown> }>;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
  state.screen = base();
  state.rootDomain = "acme.example";
});
afterEach(() => vi.unstubAllEnvs());

describe("the picker page", () => {
  it("is not found while the screens or the connector are off", async () => {
    await expect(open("cloudflare", SIGNED_IN.id)).rejects.toThrow("not_found");
    vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "false");
    await expect(open("search-console", SIGNED_IN.id)).rejects.toThrow("not_found");
  });

  it("gives the picker the connection, the manifest's note and the brand's root domain", async () => {
    const el = await open("search-console", SIGNED_IN.id);
    expect(el.props).toMatchObject({ connectionId: SIGNED_IN.id, method: "oauth_pkce", current: "", rootDomain: "acme.example", connectorName: "Google Search Console" });
    expect(el.props.listedNote).toContain("Sites you haven't verified are left out.");
    state.rootDomain = undefined;
    expect((await open("search-console", SIGNED_IN.id)).props.rootDomain).toBeNull();
  });

  it("tells a member only admins choose, and anyone that a connection isn't waiting", async () => {
    state.screen = base({ isAdmin: false });
    expect(String((await open("search-console", SIGNED_IN.id)).props.children)).toContain("Only admins choose");
    state.screen = base();
    expect(String((await open("search-console", "dcn_nononononononononono")).props.children)).toContain("isn't waiting for a property");
    state.screen = base({ connections: [connectionView({ connectorId: "search-console" })] });
    expect(String((await open("search-console", "dcn_aaaaaaaaaaaaaaaaaaaa")).props.children)).toContain("isn't waiting for a property");
  });
});
