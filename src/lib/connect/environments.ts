/**
 * Environments of one product (nav v2 phase 3): a customer usually connects the
 * same app twice — staging, where journeys are tested, and production, where they
 * go live. Each is its own connection (own keys, own users); these helpers let
 * the UI show them as one product and offer "Promote to Production".
 *
 * A connection's environment is its saved `environment` field, or — for
 * connections made before the field existed — inferred from a name like
 * "vizzybl.ai (staging)". Pure, so it's unit-tested and shared by server and UI.
 */

export type ProductEnvironment = "staging" | "production";

export interface EnvironmentAware {
  name: string;
  environment?: ProductEnvironment | null;
}

const WORDS: Record<string, ProductEnvironment> = {
  staging: "staging",
  stage: "staging",
  stg: "staging",
  test: "staging",
  production: "production",
  prod: "production",
  live: "production",
};

// "Name (staging)", "Name [prod]", "Name — staging", "Name · production", "Name: live"
const SUFFIX = /\s*(?:[([]\s*([a-z]+)\s*[)\]]|[-–—·:|]\s*([a-z]+))\s*$/i;

function parseSuffix(name: string): { base: string; environment: ProductEnvironment } | null {
  const m = SUFFIX.exec(name);
  const word = (m?.[1] ?? m?.[2])?.toLowerCase();
  const environment = word ? WORDS[word] : undefined;
  if (!m || !environment) return null;
  const base = name.slice(0, m.index).trim();
  return base ? { base, environment } : null;
}

export function environmentOf(c: EnvironmentAware): ProductEnvironment | null {
  return c.environment ?? parseSuffix(c.name)?.environment ?? null;
}

/** The product's own name, without an environment suffix. */
export function productNameOf(c: EnvironmentAware): string {
  return parseSuffix(c.name)?.base ?? c.name.trim();
}

export const ENVIRONMENT_LABEL: Record<ProductEnvironment, string> = {
  staging: "Staging",
  production: "Production",
};

export interface ProductGroup<C> {
  /** Grouping key: the product name, case-insensitive. */
  key: string;
  product: string;
  staging: C[];
  production: C[];
  /** Connections with no known environment. */
  other: C[];
}

interface Groupable extends EnvironmentAware {
  kind: "custom" | "sandbox";
  status: string;
}

/**
 * Custom connections grouped by product (revoked ones left out), plus the
 * sandboxes, which stay on their own. Groups keep the input order.
 */
export function groupProducts<C extends Groupable>(connections: C[]): { products: ProductGroup<C>[]; sandboxes: C[] } {
  const sandboxes = connections.filter((c) => c.kind === "sandbox" && c.status !== "revoked");
  const groups = new Map<string, ProductGroup<C>>();
  for (const c of connections) {
    if (c.kind !== "custom" || c.status === "revoked") continue;
    const product = productNameOf(c);
    const key = product.toLowerCase();
    const group = groups.get(key) ?? { key, product, staging: [], production: [], other: [] };
    const env = environmentOf(c);
    (env ? group[env] : group.other).push(c);
    groups.set(key, group);
  }
  return { products: [...groups.values()], sandboxes };
}

/**
 * Where a journey on `from` would be promoted to: the live production connection
 * of the same product, when `from` is its staging connection. Null otherwise
 * ("Copy to…" then offers every product).
 */
export function promotionTarget<C extends Groupable & { id: string }>(from: C, all: C[]): C | null {
  if (environmentOf(from) !== "staging") return null;
  const key = productNameOf(from).toLowerCase();
  return (
    all.find(
      (c) =>
        c.id !== from.id &&
        c.kind === "custom" &&
        c.status !== "revoked" &&
        environmentOf(c) === "production" &&
        productNameOf(c).toLowerCase() === key,
    ) ?? null
  );
}
