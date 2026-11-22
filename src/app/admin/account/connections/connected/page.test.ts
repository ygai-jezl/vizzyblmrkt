import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionsScreen } from "@/lib/connectors/screens";
import { connectionView } from "@/components/admin/connectors/testing";

const state = vi.hoisted(() => ({ screen: null as unknown }));
vi.mock("@/lib/connectors/screenLoader", () => ({ loadConnectionsScreen: async () => state.screen }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not_found");
  },
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
const { default: ConnectedPage } = await import("./page");
const { default: BrowsePage } = await import("../browse/page");

const base = (over: Partial<ConnectionsScreen> = {}): ConnectionsScreen => ({
  core: true,
  chat: true,
  isAdmin: false,
  uid: "usr_sam",
  connectors: [],
  connections: [connectionView({ member: true })],
  failed: false,
  ...over,
});

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "true");
  state.screen = base();
});
afterEach(() => vi.unstubAllEnvs());

describe("the Connected and Browse pages", () => {
  it("are not found while NEXT_PUBLIC_CONNECTORS_ENABLED is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "false");
    await expect(ConnectedPage()).rejects.toThrow("not_found");
    await expect(BrowsePage()).rejects.toThrow("not_found");
  });

  it("hand the view what the server read for this person", async () => {
    const el = (await ConnectedPage()) as { props: { isAdmin: boolean; chat: boolean; connections: unknown[]; uid: string } };
    expect(el.props).toMatchObject({ isAdmin: false, chat: true, uid: "usr_sam" });
    expect(el.props.connections).toHaveLength(1);
  });

  it("say so when the core switch is off or the list didn't load", async () => {
    state.screen = base({ core: false, connections: [] });
    expect(((await ConnectedPage()) as { props: { screen: { core: boolean } } }).props.screen.core).toBe(false);
    state.screen = base({ failed: true, connections: [] });
    expect(((await BrowsePage()) as { props: { screen: { failed: boolean } } }).props.screen.failed).toBe(true);
  });
});
