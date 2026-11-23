import type { TenantContext } from "@/lib/tenant";
import { isConnectorsChatEnabled, isConnectorsCollectEnabled, isConnectorsEnabled } from "./flags";
import { humanActor } from "./grants";
import { listForActor, type ConnectionView, type ConnectorListing, type ServiceDeps } from "./service";

/**
 * What the Settings › Connections screens (NEXT_PUBLIC_CONNECTORS_ENABLED) start from, read on
 * the server through the same service the routes use (forTenant and the grants table, so a member
 * gets name and health only). The screens then call the routes under /api/admin/connectors for
 * every change, and reload from GET /api/admin/connectors.
 */
export interface ConnectionsScreen {
  /** CONNECTORS_ENABLED. Off, every connector route answers 404, so the screens say it is off. */
  core: boolean;
  /** Vizzy reads connected data (CONNECTORS_CHAT_ENABLED): only then is the Vizzy grant offered. */
  chat: boolean;
  /** Collected numbers (CONNECTORS_COLLECT_ENABLED): the Collected column and the Manage card's block. */
  collect: boolean;
  /**
   * Collected numbers suggest articles (signals, a later switch): only then does the Manage card say
   * whether a connection is used for planning. False until that switch exists.
   */
  planning: boolean;
  /** Admins connect and change things; everyone else sees read only states. */
  isAdmin: boolean;
  /** The signed in person, so activity can say "You". */
  uid: string;
  /** The connectors offered now: each one's switch on and a way to connect ready on this copy. */
  connectors: ConnectorListing[];
  /** The brand's connections as this person may see them, newest first. */
  connections: ConnectionView[];
  /** The list didn't load. */
  failed: boolean;
}

/**
 * The screen data for one person in one brand. Pages read it through loadConnectionsScreen
 * (src/lib/connectors/screenLoader.ts), once per request.
 */
export async function connectionsScreenFor(ctx: TenantContext, deps: ServiceDeps = {}): Promise<ConnectionsScreen> {
  const base: ConnectionsScreen = {
    core: isConnectorsEnabled(),
    chat: isConnectorsChatEnabled(),
    collect: isConnectorsCollectEnabled(),
    planning: false,
    isAdmin: ctx.role === "admin",
    uid: ctx.userId ?? "",
    connectors: [],
    connections: [],
    failed: false,
  };
  if (!base.core) return base;
  try {
    const r = await listForActor(ctx, humanActor(ctx), deps);
    if (r.ok) return { ...base, connectors: r.value.connectors, connections: r.value.connections };
  } catch (err) {
    console.warn("[connections] the list didn't load", err instanceof Error ? err.message : "unknown error");
  }
  return { ...base, failed: true };
}

/** How many connections are connected now, for the Connected tab. */
export function connectedCount(screen: Pick<ConnectionsScreen, "connections">): number {
  return screen.connections.filter((c) => c.status === "connected").length;
}
