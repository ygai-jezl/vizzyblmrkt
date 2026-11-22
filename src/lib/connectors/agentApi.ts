import { z } from "zod";
import { forTenant, type TenantContext } from "@/lib/tenant";
import { meaningsOf } from "@/lib/metrics/meanings";
import { DATA_CONNECTION_ID_RE, type DataConnection } from "@/lib/types/dataConnection";
import type { AgentApiResult } from "./agentGate";
import { can, type ConnectorActor } from "./grants";
import { shownState } from "./health";
import { lagWords } from "./live";
import { LIVE_BY, LIVE_LIMITS } from "./manifest";
import { connectorMessage } from "./messages";
import { getConnector, knownConnector } from "./registry";
import { readLiveFor, type ServiceDeps } from "./service";

/**
 * What Vizzy's connector tools read (Connectors 1c, ADR-0011), through /api/agent/connectors. Reads
 * only: Vizzy never connects, checks, pauses, changes grants or disconnects.
 *
 * - The brand is the canvas token's (connectorsAgentGate); nothing in a request names one.
 * - Vizzy sees a connection only with the grant {to: "agent:vizzy", can: "read"}, and reads it for
 *   a member only when members may read it too (src/lib/connectors/grants.ts). Without the grant a
 *   read answers 403 with words saying an admin can allow it; the list says only that some
 *   connections aren't shared with Vizzy, never which.
 * - A live read is the people's read (readLiveFor): bounded to 93 days and 100 rows, the stream's
 *   own dimensions, page paths without query strings. Every number in an answer has its meaning,
 *   and nothing else in an answer is a number. Each read is logged as "read" by agent:vizzy.
 */

const LIST_LIMIT = 200;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const NO_AGENT_GRANT = "Vizzy isn't allowed to read this connection. An admin can allow it on the connection in Settings › Connections › Connected.";
export const NO_MEMBER_READ =
  "Members aren't allowed to read this connection's numbers, so Vizzy can't read them for you. An admin can allow members to read it, or ask an admin to look.";

/** Why Vizzy can't read a connection it can see right now, in words, or null when it can. */
function cannotRead(c: DataConnection, actor: ConnectorActor, on: boolean, state: ReturnType<typeof shownState>): string | null {
  if (!can(actor, "read_live", c.grants)) return NO_MEMBER_READ;
  if (!on) return "This connector is turned off in this copy of YouGrow.";
  if (!c.account) return connectorMessage("account_needed");
  if (state === "paused") return connectorMessage("paused");
  return null;
}

/** list_connections: the brand's connections Vizzy may see, their health and what each gives. */
export async function agentConnections(ctx: TenantContext, actor: ConnectorActor, deps: Pick<ServiceDeps, "db" | "now"> = {}): Promise<AgentApiResult> {
  const now = deps.now ?? new Date();
  const rows = await forTenant(ctx, deps.db).dataConnections.find({ where: [["status", "==", "connected"]], limit: LIST_LIMIT });
  const seen = rows.filter((c) => can(actor, "see", c.grants)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const connections = seen.map((c) => {
    const on = getConnector(c.connectorId);
    const m = on ?? knownConnector(c.connectorId);
    const state = shownState(c, now);
    const why = cannotRead(c, actor, on !== null, state);
    return {
      id: c.id,
      connector: m?.name ?? c.connectorId,
      label: c.label,
      health: state,
      problem: c.health.lastErrorCode && state !== "ok" ? connectorMessage(c.health.lastErrorCode) : null,
      canRead: why === null,
      cannotReadBecause: why,
      streams: (m?.produces ?? []).map((p) => ({ stream: p.stream, description: p.description, by: p.liveBy, lag: lagWords(p.lagDays), measures: p.measures })),
    };
  });
  return {
    status: 200,
    body: {
      connections,
      notShared: rows.length > seen.length,
      meanings: meaningsOf(connections.flatMap((c) => c.streams.flatMap((s) => s.measures))),
      asOf: now.toISOString(),
    },
  };
}

export const AgentLiveSchema = z
  .object({
    connectionId: z.string().regex(DATA_CONNECTION_ID_RE),
    stream: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
    from: z.string().regex(DATE),
    to: z.string().regex(DATE),
    by: z.enum(LIVE_BY).optional(),
    limit: z.number().int().min(1).max(LIVE_LIMITS.maxRows).optional(),
  })
  .strict();

/** read_connected_live: one capped live read, every number with its meaning. */
export async function agentLiveRead(ctx: TenantContext, actor: ConnectorActor, body: unknown, deps: ServiceDeps = {}): Promise<AgentApiResult> {
  const parsed = AgentLiveSchema.safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: "invalid_input" } };
  const { connectionId, ...query } = parsed.data;
  const conn = await forTenant(ctx, deps.db).dataConnections.getById(connectionId);
  if (!conn) return { status: 404, body: { error: "not_found" } };
  if (!can(actor, "see", conn.grants)) return { status: 403, body: { error: "no_agent_grant", message: NO_AGENT_GRANT } };
  if (!can(actor, "read_live", conn.grants)) return { status: 403, body: { error: "no_read_grant", message: NO_MEMBER_READ } };
  const r = await readLiveFor(ctx, actor, connectionId, query, deps, "read");
  if (!r.ok) return { status: r.status, body: { error: r.error, ...(r.message ? { message: r.message } : {}) } };
  const a = r.value;
  return {
    status: 200,
    body: {
      connection: { id: conn.id, connector: knownConnector(conn.connectorId)?.name ?? conn.connectorId, label: conn.label },
      stream: a.stream,
      from: a.from,
      to: a.to,
      by: a.by,
      rows: a.rows,
      meanings: a.meanings,
      lag: a.lag.words,
      notes: a.notes,
      asOf: a.asOf,
    },
  };
}
