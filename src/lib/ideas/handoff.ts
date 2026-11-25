import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { ENVIRONMENT_LABEL, environmentOf, groupProducts, productNameOf } from "@/lib/connect/environments";
import { listWaves } from "@/lib/invites/waves";
import type { ProductConnection } from "@/lib/types/productConnection";

/**
 * Handing a launched idea off to the product it became (LAUNCH_IDEAS_ENABLED). The choices are the
 * brand's product connections that aren't revoked: its own products first, grouped by product with
 * each copy named, then sandboxes labelled Sandbox. Picked first: the product its latest invite
 * wave went to. Data connections (connectors) are a different thing and never listed.
 */

export interface HandoffOption {
  id: string;
  /** The product's own name, for "Handed off to Lumen app". */
  name: string;
  /** What the picker shows, e.g. "Lumen app (Production)" or "Test app (Sandbox)". */
  label: string;
}

export interface HandoffChoices {
  options: HandoffOption[];
  /** The option picked first. */
  defaultId: string | null;
  /** True when the default is where the latest invite wave went. */
  fromWave: boolean;
  /** Names of every connection, revoked ones too, so a hand-off to one still reads. */
  names: Record<string, string>;
}

type Connection = Pick<ProductConnection, "id" | "name" | "kind" | "status" | "environment">;

/** The picker's options, in order: the brand's products (production, then unknown, then staging), then sandboxes. */
export function handoffOptions(connections: readonly Connection[]): HandoffOption[] {
  const { products, sandboxes } = groupProducts([...connections]);
  const own = products.flatMap((g) =>
    [...g.production, ...g.other, ...g.staging].map((c) => {
      const env = environmentOf(c);
      const several = g.production.length + g.other.length + g.staging.length > 1;
      return { id: c.id, name: g.product, label: several && env ? `${g.product} (${ENVIRONMENT_LABEL[env]})` : g.product };
    }),
  );
  const test = sandboxes.map((c) => ({ id: c.id, name: productNameOf(c), label: `${productNameOf(c)} (Sandbox)` }));
  return [...own, ...test];
}

/** The choices for one launch: the options, and the product its latest sent invite wave went to. */
export async function loadHandoff(ctx: TenantContext, campaignId: string, db?: FirestoreLike): Promise<HandoffChoices> {
  const [connections, waves] = await Promise.all([
    forTenant(ctx, db).productConnections.find({ limit: 100 }),
    listWaves(ctx, campaignId, db).catch(() => []),
  ]);
  const options = handoffOptions(connections);
  const listed = new Set(options.map((o) => o.id));
  const wave = waves.find((w) => (w.status === "sent" || w.status === "sending") && listed.has(w.connectionId));
  return {
    options,
    defaultId: wave?.connectionId ?? options[0]?.id ?? null,
    fromWave: !!wave,
    names: Object.fromEntries(connections.map((c) => [c.id, productNameOf(c)])),
  };
}
