/**
 * Waitlist journeys on the lifecycle engine (engine move D2). Pure; server-only
 * flags. Both ship ON in dev (apphosting.yaml) and OFF in prod
 * (apphosting.prod.yaml) until verified on dev and promoted.
 */

/**
 * The kill switch. Off: waitlist journeys on the lifecycle engine send nothing
 * and everyone in them is HELD — never dropped — until it's back on. New
 * signups still enrol (and wait).
 */
export function isWaitlistEngineEnabled(): boolean {
  return process.env.WAITLIST_ENGINE_ENABLED === "true";
}

/**
 * Tenants whose launches may move to the lifecycle engine: comma-separated
 * tenant ids, or "*" for every tenant. Unset or empty = none.
 */
export function isWaitlistEnginePilot(tenantId: string): boolean {
  const raw = (process.env.WAITLIST_ENGINE_PILOT_TENANTS ?? "").trim();
  if (raw === "*") return true;
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .includes(tenantId);
}

/**
 * Client + server — the screens for waitlist journeys on the lifecycle engine:
 * the lifecycle editor's waitlist mode and the launch's "Email engine" panel.
 * Read at BUILD time in client components (NEXT_PUBLIC_).
 */
export function isWaitlistEngineUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_WAITLIST_ENGINE_UI_ENABLED === "true";
}
