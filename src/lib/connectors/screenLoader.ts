import { cache } from "react";
import { requireAdminContext } from "@/lib/auth/session";
import { connectionsScreenFor, type ConnectionsScreen } from "./screens";

/**
 * The Settings › Connections screen data for the signed in person, read once per request: the
 * layout's Connected count and the page share it. Server components only (React's cache).
 */
export const loadConnectionsScreen = cache(async (): Promise<ConnectionsScreen> => connectionsScreenFor(await requireAdminContext()));
