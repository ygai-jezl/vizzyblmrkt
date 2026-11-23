import type { ConnectorIcon, ConnectorManifestInput } from "@/lib/connectors/manifest";
import { MANIFESTS } from "@/lib/connectors/manifests";

/**
 * Which connected tools a Vizzy answer read, for the source line under it. Pure and client safe:
 * the tool result comes off the agent stream, so only its connector id is used, and only when a
 * manifest in this repo has that id. The name, mark and link always come from the manifest
 * (src/lib/connectors/manifests), never from the stream.
 */

/** The tools whose answer reads a connection, and carries `connection.connectorId`. */
const READS_A_CONNECTION: ReadonlySet<string> = new Set(["read_connected_live"]);

const WRITTEN: readonly ConnectorManifestInput[] = MANIFESTS;

/** What the source line shows for one connector. */
export interface ChatSource {
  id: string;
  name: string;
  initials?: string;
  icon: ConnectorIcon | null;
  /** The provider's own dashboard, or null when its manifest names none. */
  home: string | null;
}

/** The connector a tool result read, or null when it didn't read one (or failed). */
export function connectorSourceOf(toolName: string, result: Record<string, unknown> | undefined): string | null {
  if (!READS_A_CONNECTION.has(toolName) || !result || result.status !== "success") return null;
  const connection = result.connection;
  const id = connection && typeof connection === "object" ? (connection as { connectorId?: unknown }).connectorId : undefined;
  return typeof id === "string" && WRITTEN.some((m) => m.id === id) ? id : null;
}

/** The source line's view of a connector, from its manifest; null for an id no manifest has. */
export function chatSourceOf(id: string): ChatSource | null {
  const m = WRITTEN.find((w) => w.id === id);
  if (!m) return null;
  return { id: m.id, name: m.name, ...(m.initials ? { initials: m.initials } : {}), icon: m.icon ?? null, home: m.home ?? null };
}

/**
 * The transcript with a connector added to the latest agent message's sources, each once, in the
 * order they were read. Unchanged when there is no agent message yet.
 */
export function withSource<T extends { role: string; sources?: string[] }>(exchange: readonly T[], id: string): T[] {
  const updated = [...exchange];
  const last = updated.findLastIndex((m) => m.role === "agent");
  const target = last >= 0 ? updated[last] : undefined;
  if (!target || target.sources?.includes(id)) return updated;
  updated[last] = { ...target, sources: [...(target.sources ?? []), id] };
  return updated;
}
