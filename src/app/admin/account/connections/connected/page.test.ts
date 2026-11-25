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
  collect: false,
  planning: false,
  isAdmin: false,
  owner: false,
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

/** Next.js always hands a page its search params; none here. */
const none = () => ({ searchParams: Promise.resolve({}) });

describe("the Connected and Browse pages", () => {
  it("are not found while NEXT_PUBLIC_CONNECTORS_ENABLED is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONNECTORS_ENABLED", "false");
    await expect(ConnectedPage(none())).rejects.toThrow("not_found");
    await expect(BrowsePage()).rejects.toThrow("not_found");
  });

  it("hand the view what the server read for this person", async () => {
    const el = (await ConnectedPage(none())) as { props: { isAdmin: boolean; chat: boolean; connections: unknown[]; uid: string } };
    expect(el.props).toMatchObject({ isAdmin: false, chat: true, uid: "usr_sam" });
    expect(el.props.connections).toHaveLength(1);
  });

  it("tell the view whether this person owns the organisation, as the server worked it out", async () => {
    state.screen = base({ isAdmin: true, owner: true });
    expect(((await ConnectedPage(none())) as { props: { owner: boolean } }).props.owner).toBe(true);
    state.screen = base({ isAdmin: true });
    expect(((await ConnectedPage(none())) as { props: { owner: boolean } }).props.owner).toBe(false);
  });

  it("open on the connection a Review row names, and only a real connection id", async () => {
    state.screen = base({ isAdmin: true, collect: true });
    const pick = async (c: string | string[] | undefined) =>
      ((await ConnectedPage({ searchParams: Promise.resolve({ c }) })) as { props: { selected: string | null; collect: boolean } }).props;
    expect(await pick("dcn_aaaaaaaaaaaaaaaaaaaa")).toMatchObject({ selected: "dcn_aaaaaaaaaaaaaaaaaaaa", collect: true });
    expect((await pick("not-an-id")).selected).toBeNull();
    expect((await pick(["dcn_aaaaaaaaaaaaaaaaaaaa"])).selected).toBeNull();
    expect((await pick(undefined)).selected).toBeNull();
  });

  it("say so when the core switch is off or the list didn't load", async () => {
    state.screen = base({ core: false, connections: [] });
    expect(((await ConnectedPage(none())) as { props: { screen: { core: boolean } } }).props.screen.core).toBe(false);
    state.screen = base({ failed: true, connections: [] });
    expect(((await BrowsePage()) as { props: { screen: { failed: boolean } } }).props.screen.failed).toBe(true);
  });
});
